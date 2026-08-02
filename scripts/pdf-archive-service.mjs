import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createProxyAwareFetch } from "./ai/providers.mjs";

export const DEFAULT_PDF_DIRECTORY = join(
  homedir(),
  "Library",
  "Application Support",
  "个人文献库",
  "pdfs",
);

const MAX_PDF_BYTES = 200 * 1_024 * 1_024;
const FETCH_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;
const PDF_MAGIC = Buffer.from("%PDF-");
const PDF_HEADER_BYTES = 1_024;

export class PdfArchiveError extends Error {
  constructor(
    message,
    { statusCode = 422, code = "PDF_ARCHIVE_ERROR", details } = {},
  ) {
    super(message);
    this.name = "PdfArchiveError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function isBlockedHost(host) {
  const normalized = host
    .replace(/^\[/u, "")
    .replace(/\]$/u, "")
    .toLocaleLowerCase("en");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "0.0.0.0" ||
    /^0\./u.test(normalized) ||
    /^127(?:\.\d{1,3}){3}$/u.test(normalized) ||
    /^10(?:\.\d{1,3}){3}$/u.test(normalized) ||
    /^192\.168(?:\.\d{1,3}){2}$/u.test(normalized) ||
    /^169\.254(?:\.\d{1,3}){2}$/u.test(normalized) ||
    /^172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/u.test(normalized) ||
    /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2}$/u.test(
      normalized,
    ) ||
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("::ffff:")
  );
}

function assertSafePdfUrl(value, { allowPrivateNetwork = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new PdfArchiveError("PDF 来源链接格式无效。", {
      code: "PDF_SOURCE_INVALID",
    });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new PdfArchiveError("PDF 来源链接必须使用 http:// 或 https://。", {
      code: "PDF_SOURCE_INVALID",
    });
  }
  if (url.username || url.password) {
    throw new PdfArchiveError("PDF 来源链接不能包含用户名或密码。", {
      code: "PDF_SOURCE_INVALID",
    });
  }
  if (!allowPrivateNetwork && isBlockedHost(url.hostname)) {
    throw new PdfArchiveError("不能从本机或局域网地址归档 PDF。", {
      code: "PDF_SOURCE_NOT_ALLOWED",
    });
  }
  return url;
}

function pdfStorageKey(paperId, sourceUrl, salt = "") {
  const digest = createHash("sha256")
    .update(`${paperId}\u0000${sourceUrl}\u0000${salt}`)
    .digest("hex");
  return `pdf-${digest}.pdf`;
}

function createPdfValidationTransform(maxBytes) {
  const hash = createHash("sha256");
  const prefix = [];
  let prefixLength = 0;
  let sizeBytes = 0;

  const transform = new Transform({
    transform(chunk, encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      sizeBytes += bytes.length;
      if (sizeBytes > maxBytes) {
        callback(
          new PdfArchiveError("PDF 文件超过 200 MiB，未保存到本地。", {
            statusCode: 413,
            code: "PDF_TOO_LARGE",
          }),
        );
        return;
      }
      if (prefixLength < PDF_HEADER_BYTES) {
        const remaining = PDF_HEADER_BYTES - prefixLength;
        const next = bytes.subarray(0, remaining);
        prefix.push(next);
        prefixLength += next.length;
      }
      hash.update(bytes);
      callback(null, bytes);
    },
    flush(callback) {
      const header = Buffer.concat(prefix, prefixLength);
      if (!header.includes(PDF_MAGIC)) {
        callback(
          new PdfArchiveError("下载内容不是有效 PDF，未保存到本地。", {
            code: "PDF_INVALID_CONTENT",
          }),
        );
        return;
      }
      callback();
    },
  });

  return {
    transform,
    result() {
      return {
        sizeBytes,
        sha256: hash.digest("hex"),
      };
    },
  };
}

function failureDetails(error) {
  if (error instanceof PdfArchiveError) {
    return { code: error.code, message: error.message };
  }
  if (error?.name === "AbortError" || error?.name === "TimeoutError") {
    return {
      code: "PDF_TIMEOUT",
      message: "下载 PDF 超时，请稍后重试。",
    };
  }
  return {
    code: "PDF_DOWNLOAD_FAILED",
    message: "无法下载 PDF，请检查链接或网络。",
  };
}

function sourceReadable(value) {
  if (value instanceof Readable) return value;
  if (value && typeof value.getReader === "function") {
    return Readable.fromWeb(value);
  }
  throw new PdfArchiveError("PDF 下载响应不包含文件内容。", {
    statusCode: 502,
    code: "PDF_DOWNLOAD_FAILED",
  });
}

export class PdfArchiveService {
  constructor({
    repository,
    pdfDirectory = DEFAULT_PDF_DIRECTORY,
    fetchImpl = createProxyAwareFetch(),
    allowPrivateNetwork = false,
    maxBytes = MAX_PDF_BYTES,
    timeoutMs = FETCH_TIMEOUT_MS,
  } = {}) {
    if (!repository) throw new Error("PdfArchiveService 需要 repository。");
    this.repository = repository;
    this.pdfDirectory = resolve(pdfDirectory);
    this.temporaryDirectory = resolve(this.pdfDirectory, ".tmp");
    this.fetchImpl = fetchImpl;
    this.allowPrivateNetwork = allowPrivateNetwork;
    this.maxBytes = maxBytes;
    this.timeoutMs = timeoutMs;
    this.inFlight = new Map();
  }

  async archive(paperId, { force = false } = {}) {
    const existing = this.inFlight.get(paperId);
    if (existing) return existing;

    const task = this.#archive(paperId, { force });
    this.inFlight.set(paperId, task);
    try {
      return await task;
    } finally {
      if (this.inFlight.get(paperId) === task) {
        this.inFlight.delete(paperId);
      }
    }
  }

  async importPdf(paperId, input) {
    const existing = this.inFlight.get(paperId);
    if (existing) {
      throw new PdfArchiveError("该论文的 PDF 正在保存，请稍后再试。", {
        statusCode: 409,
        code: "PDF_ARCHIVE_BUSY",
      });
    }

    const task = this.#importPdf(paperId, input);
    this.inFlight.set(paperId, task);
    try {
      return await task;
    } finally {
      if (this.inFlight.get(paperId) === task) {
        this.inFlight.delete(paperId);
      }
    }
  }

  async getLocalPdf(paperId) {
    const record = this.repository.getPdfArchiveRecord(paperId);
    if (!record || record.status !== "ready" || !record.storageKey) return null;
    const filePath = this.#filePath(record.storageKey);
    try {
      const metadata = await stat(filePath);
      if (!metadata.isFile() || metadata.size <= 0) {
        throw new Error("PDF 文件不存在。");
      }
      const descriptor = await open(filePath, "r");
      try {
        const header = Buffer.alloc(Math.min(PDF_HEADER_BYTES, metadata.size));
        const { bytesRead } = await descriptor.read(header, 0, header.length, 0);
        if (!header.subarray(0, bytesRead).includes(PDF_MAGIC)) {
          throw new Error("PDF 文件已损坏。");
        }
      } finally {
        await descriptor.close();
      }
      return {
        path: filePath,
        sizeBytes: metadata.size,
        sha256: record.sha256,
      };
    } catch {
      await this.repository.clearPdfArchiveRecord(paperId);
      return null;
    }
  }

  async removeLocalPdf(paperId) {
    const record = this.repository.getPdfArchiveRecord(paperId);
    if (record?.storageKey) {
      await rm(this.#filePath(record.storageKey), { force: true });
    }
    return this.repository.clearPdfArchiveRecord(paperId);
  }

  async #archive(paperId, { force = false } = {}) {
    const paper = this.repository.getPaper(paperId);
    if (!paper) {
      throw new PdfArchiveError("未找到论文。", {
        statusCode: 404,
        code: "NOT_FOUND",
      });
    }
    if (!paper.pdfUrl) {
      throw new PdfArchiveError("该论文没有可自动下载的 PDF 来源链接。", {
        code: "PDF_SOURCE_UNAVAILABLE",
      });
    }

    const sourceUrl = assertSafePdfUrl(paper.pdfUrl, {
      allowPrivateNetwork: this.allowPrivateNetwork,
    }).href;
    const existing = await this.getLocalPdf(paperId);
    const record = this.repository.getPdfArchiveRecord(paperId);
    if (
      !force &&
      existing &&
      record?.status === "ready" &&
      record.sourceUrl === sourceUrl
    ) {
      return {
        paper: this.repository.getPaper(paperId),
        backup: undefined,
        alreadyArchived: true,
      };
    }

    let fetched;
    try {
      fetched = await this.#fetchPdf(sourceUrl);
      const { response } = fetched;
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(contentLength) && contentLength > this.maxBytes) {
        throw new PdfArchiveError("PDF 文件超过 200 MiB，未保存到本地。", {
          statusCode: 413,
          code: "PDF_TOO_LARGE",
        });
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (/^(?:text\/html|application\/(?:json|xml))/iu.test(contentType.trim())) {
        throw new PdfArchiveError("下载地址返回了网页而非 PDF，未保存到本地。", {
          code: "PDF_INVALID_CONTENT",
        });
      }
      return await this.#saveStream({
        paperId,
        sourceUrl,
        input: sourceReadable(response.body),
        storageKey: pdfStorageKey(paperId, sourceUrl, randomUUID()),
      });
    } catch (error) {
      const failure = failureDetails(error);
      await this.repository.recordPdfArchiveFailure(paperId, {
        sourceUrl,
        errorCode: failure.code,
        errorMessage: failure.message,
      });
      throw error instanceof PdfArchiveError
        ? error
        : new PdfArchiveError(failure.message, {
            statusCode: 502,
            code: failure.code,
          });
    } finally {
      fetched?.cancel();
    }
  }

  async #importPdf(paperId, input) {
    try {
      return await this.#saveStream({
        paperId,
        sourceUrl: "",
        input,
        storageKey: pdfStorageKey(paperId, "manual", randomUUID()),
      });
    } catch (error) {
      const failure = failureDetails(error);
      await this.repository.recordPdfArchiveFailure(paperId, {
        sourceUrl: "",
        errorCode: failure.code,
        errorMessage: failure.message,
      });
      throw error instanceof PdfArchiveError
        ? error
        : new PdfArchiveError(failure.message, {
            statusCode: 502,
            code: failure.code,
          });
    }
  }

  async #fetchPdf(sourceUrl) {
    let url = assertSafePdfUrl(sourceUrl, {
      allowPrivateNetwork: this.allowPrivateNetwork,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
        const response = await this.fetchImpl(url, {
          redirect: "manual",
          signal: controller.signal,
          headers: {
            Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.1",
            "User-Agent": "PersonalLiteratureLibrary/1.0 (local desktop app)",
          },
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          if (!location || redirect === MAX_REDIRECTS) {
            throw new PdfArchiveError("PDF 链接重定向次数过多。", {
              statusCode: 502,
              code: "PDF_REDIRECT_LIMIT",
            });
          }
          url = assertSafePdfUrl(new URL(location, url).href, {
            allowPrivateNetwork: this.allowPrivateNetwork,
          });
          continue;
        }
        if (response.status === 401 || response.status === 403) {
          throw new PdfArchiveError("该 PDF 需要登录，请手动导入。", {
            statusCode: 422,
            code: "PDF_AUTH_REQUIRED",
          });
        }
        if (response.status === 404) {
          throw new PdfArchiveError("未找到远程 PDF，请检查来源链接。", {
            statusCode: 404,
            code: "PDF_NOT_FOUND",
          });
        }
        if (!response.ok) {
          throw new PdfArchiveError(
            `PDF 来源服务返回了 ${response.status}。`,
            { statusCode: 502, code: "PDF_DOWNLOAD_FAILED" },
          );
        }
        return {
          response,
          cancel() {
            clearTimeout(timer);
          },
        };
      }
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }
    throw new PdfArchiveError("PDF 链接重定向次数过多。", {
      statusCode: 502,
      code: "PDF_REDIRECT_LIMIT",
    });
  }

  async #saveStream({ paperId, sourceUrl, input, storageKey }) {
    const paper = this.repository.getPaper(paperId);
    if (!paper) {
      throw new PdfArchiveError("未找到论文。", {
        statusCode: 404,
        code: "NOT_FOUND",
      });
    }
    await mkdir(this.pdfDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.temporaryDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = join(
      this.temporaryDirectory,
      `${storageKey}.${randomUUID()}.part`,
    );
    const finalPath = this.#filePath(storageKey);
    const previousStorageKey = this.repository.getPdfArchiveRecord(paperId)?.storageKey;
    let finalWritten = false;

    try {
      const validator = createPdfValidationTransform(this.maxBytes);
      await pipeline(
        sourceReadable(input),
        validator.transform,
        createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
      );
      const current = this.repository.getPaper(paperId);
      if (sourceUrl && current?.pdfUrl && current.pdfUrl !== sourceUrl) {
        await rm(temporaryPath, { force: true });
        return this.repository.recordPdfArchiveStale(paperId);
      }
      await rename(temporaryPath, finalPath);
      finalWritten = true;
      const { sizeBytes, sha256 } = validator.result();
      const committed = await this.repository.recordPdfArchiveReady(paperId, {
        sourceUrl,
        storageKey,
        sizeBytes,
        sha256,
      });
      if (!committed.committed) {
        await rm(finalPath, { force: true });
      } else if (previousStorageKey && previousStorageKey !== storageKey) {
        await rm(this.#filePath(previousStorageKey), { force: true }).catch(
          () => undefined,
        );
      }
      return committed;
    } catch (error) {
      await rm(temporaryPath, { force: true });
      if (finalWritten) await rm(finalPath, { force: true });
      throw error;
    }
  }

  #filePath(storageKey) {
    if (!/^pdf-[a-f0-9]{64}\.pdf$/u.test(storageKey)) {
      throw new PdfArchiveError("PDF 本地文件标识无效。", {
        statusCode: 500,
        code: "PDF_STORAGE_INVALID",
      });
    }
    return resolve(this.pdfDirectory, storageKey);
  }
}

export function createPdfArchiveService(options = {}) {
  return new PdfArchiveService(options);
}
