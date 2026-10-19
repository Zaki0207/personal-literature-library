import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { createProxyAwareFetch } from "./ai/providers.mjs";
import { createPublicNetworkFetch } from "./network-safety.mjs";

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
const MAX_FETCH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 400;
const MAX_RETRY_DELAY_MS = 2_000;
const RETRYABLE_HTTP_STATUSES = new Set([500, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);
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

function isKnownLoginRedirect(url) {
  return url.hostname === "ieeexplore.ieee.org" && url.pathname === "/Xplore/login.jsp";
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

function isRetryableNetworkError(error) {
  let candidate = error;
  for (let depth = 0; candidate && depth < 5; depth += 1) {
    if (RETRYABLE_NETWORK_CODES.has(candidate.code)) return true;
    candidate = candidate.cause;
  }
  return false;
}

function failureDetails(error, context = {}) {
  const candidate = { ...context, ...error?.details };
  const details = {
    ...(Number.isInteger(candidate.status) && candidate.status >= 100 && candidate.status <= 599
      ? { status: candidate.status }
      : {}),
    retryable: typeof candidate.retryable === "boolean"
      ? candidate.retryable
      : isRetryableNetworkError(error) || error?.name === "AbortError" || error?.name === "TimeoutError",
    ...(Number.isInteger(candidate.attempts) && candidate.attempts >= 1 && candidate.attempts <= MAX_FETCH_ATTEMPTS
      ? { attempts: candidate.attempts }
      : {}),
  };
  if (error instanceof PdfArchiveError) {
    return { code: error.code, message: error.message, details };
  }
  if (error?.name === "AbortError" || error?.name === "TimeoutError") {
    return {
      code: "PDF_TIMEOUT",
      message: "下载 PDF 超时，请稍后重试，或在浏览器下载后导入本地 PDF。",
      details,
    };
  }
  if (error?.code === "REMOTE_ADDRESS_NOT_ALLOWED") {
    return {
      code: "PDF_SOURCE_NOT_ALLOWED",
      message: "PDF 来源指向了本机、局域网或保留网络，请检查来源链接。",
      details,
    };
  }
  return {
    code: "PDF_DOWNLOAD_FAILED",
    message: "无法下载 PDF，请检查链接或网络，或在浏览器下载后导入本地 PDF。",
    details,
  };
}

async function cancelResponseBody(response) {
  if (!response?.body) return;
  try {
    if (typeof response.body.cancel === "function") {
      await response.body.cancel();
    } else if (typeof response.body.destroy === "function") {
      response.body.destroy();
    }
  } catch {
    // A consumed or aborted body no longer needs cancellation.
  }
}

function awaitFetchUntilAborted(request, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(request).then((response) => {
      if (settled) {
        void cancelResponseBody(response);
        return;
      }
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve(response);
    }, (error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    if (signal.aborted) abort();
  });
}

function retryDelay(response, attempt, baseDelayMs) {
  const value = response?.headers.get("retry-after");
  if (value) {
    const seconds = /^\d+(?:\.\d+)?$/u.test(value.trim()) ? Number(value) : NaN;
    const requested = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - Date.now();
    if (Number.isFinite(requested)) return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, requested));
  }
  return Math.min(MAX_RETRY_DELAY_MS, baseDelayMs * attempt);
}

function waitForRetry(delayMs, signal) {
  return sleep(delayMs, undefined, { signal });
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
    retryDelayMs = RETRY_DELAY_MS,
    retryWait = waitForRetry,
    resolveHost,
  } = {}) {
    if (!repository) throw new Error("PdfArchiveService 需要 repository。");
    this.repository = repository;
    this.pdfDirectory = resolve(pdfDirectory);
    this.temporaryDirectory = resolve(this.pdfDirectory, ".tmp");
    this.fetchImpl = createPublicNetworkFetch((url, init) => {
      init.signal?.throwIfAborted();
      return fetchImpl(url, init);
    }, {
      ...(allowPrivateNetwork
        ? { lookupImpl: null }
        : resolveHost !== undefined
          ? { lookupImpl: resolveHost }
          : {}),
    });
    this.allowPrivateNetwork = allowPrivateNetwork;
    this.maxBytes = maxBytes;
    this.timeoutMs = timeoutMs;
    this.retryDelayMs = Number.isFinite(retryDelayMs)
      ? Math.min(MAX_RETRY_DELAY_MS, Math.max(0, retryDelayMs))
      : RETRY_DELAY_MS;
    this.retryWait = retryWait;
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
    const existing = await this.getLocalPdf(paperId);
    const record = this.repository.getPdfArchiveRecord(paperId);
    if (!force && existing && record?.status === "ready" && !record.sourceUrl) {
      return {
        paper: this.repository.getPaper(paperId),
        backup: undefined,
        alreadyArchived: true,
      };
    }
    if (!paper.pdfUrl) {
      throw new PdfArchiveError("该论文没有可自动下载的 PDF 来源链接。", {
        code: "PDF_SOURCE_UNAVAILABLE",
      });
    }

    const sourceUrl = assertSafePdfUrl(paper.pdfUrl, {
      allowPrivateNetwork: this.allowPrivateNetwork,
    }).href;
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
        signal: fetched.signal,
      });
    } catch (error) {
      const failure = failureDetails(error, {
        attempts: fetched?.attempts,
        status: fetched?.response.status,
      });
      await this.repository.recordPdfArchiveFailure(paperId, {
        sourceUrl,
        errorCode: failure.code,
        errorMessage: failure.message,
      });
      throw new PdfArchiveError(failure.message, {
        statusCode: error instanceof PdfArchiveError ? error.statusCode : 502,
        code: failure.code,
        details: failure.details,
      });
    } finally {
      await fetched?.cancel();
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let attempts = 0;
    let lastStatus;
    try {
      for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
        attempts = attempt;
        let response;
        try {
          let url = assertSafePdfUrl(sourceUrl, {
            allowPrivateNetwork: this.allowPrivateNetwork,
          });
          for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
            controller.signal.throwIfAborted();
            response = await awaitFetchUntilAborted(this.fetchImpl(url, {
              redirect: "manual",
              signal: controller.signal,
              headers: {
                Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.1",
                "User-Agent": "PersonalLiteratureLibrary/1.0 (local desktop app)",
              },
            }), controller.signal);
            lastStatus = response.status;
            if ([301, 302, 303, 307, 308].includes(response.status)) {
              const location = response.headers.get("location");
              await cancelResponseBody(response);
              if (!location || redirect === MAX_REDIRECTS) {
                throw new PdfArchiveError("PDF 链接重定向次数过多，请检查来源链接或导入本地 PDF。", {
                  statusCode: 502,
                  code: "PDF_REDIRECT_LIMIT",
                  details: { status: response.status, retryable: false, attempts: attempt },
                });
              }
              url = assertSafePdfUrl(new URL(location, url).href, {
                allowPrivateNetwork: this.allowPrivateNetwork,
              });
              if (isKnownLoginRedirect(url)) {
                throw new PdfArchiveError("该 PDF 来源跳转到了 IEEE 登录页，请在浏览器登录并下载后导入本地 PDF。", {
                  statusCode: 422,
                  code: "PDF_AUTH_REQUIRED",
                  details: { status: response.status, retryable: false, attempts: attempt },
                });
              }
              response = undefined;
              continue;
            }
            if (response.status === 401 || response.status === 403) {
              throw new PdfArchiveError("该 PDF 需要登录，请在浏览器下载后导入本地 PDF。", {
                statusCode: 422,
                code: "PDF_AUTH_REQUIRED",
                details: { status: response.status, retryable: false, attempts: attempt },
              });
            }
            if (response.status === 404) {
              throw new PdfArchiveError("未找到远程 PDF，请检查来源链接或导入本地 PDF。", {
                statusCode: 404,
                code: "PDF_NOT_FOUND",
                details: { status: response.status, retryable: false, attempts: attempt },
              });
            }
            if (!response.ok) {
              const retryable = RETRYABLE_HTTP_STATUSES.has(response.status);
              throw new PdfArchiveError(
                retryable
                  ? `PDF 来源暂时不可用（HTTP ${response.status}），请稍后重试，或在浏览器下载后导入本地 PDF。`
                  : `PDF 来源服务返回了 HTTP ${response.status}，请检查来源链接，或在浏览器下载后导入本地 PDF。`,
                {
                  statusCode: 502,
                  code: "PDF_DOWNLOAD_FAILED",
                  details: { status: response.status, retryable, attempts: attempt },
                },
              );
            }
            return {
              response,
              attempts: attempt,
              signal: controller.signal,
              async cancel() {
                clearTimeout(timer);
                await cancelResponseBody(response);
              },
            };
          }
        } catch (error) {
          const delayMs = retryDelay(response, attempt, this.retryDelayMs);
          await cancelResponseBody(response);
          if (controller.signal.aborted) throw controller.signal.reason;
          const retryable = error instanceof PdfArchiveError
            ? error.details?.retryable === true
            : isRetryableNetworkError(error);
          if (!retryable || attempt === MAX_FETCH_ATTEMPTS) throw error;
          await this.retryWait(delayMs, controller.signal);
          controller.signal.throwIfAborted();
        }
      }
    } catch (error) {
      clearTimeout(timer);
      const failure = failureDetails(error, {
        ...(lastStatus === undefined ? {} : { status: lastStatus }),
        attempts,
      });
      throw new PdfArchiveError(failure.message, {
        statusCode: error instanceof PdfArchiveError ? error.statusCode : 502,
        code: failure.code,
        details: failure.details,
      });
    }
    throw new PdfArchiveError("PDF 链接重定向次数过多。", {
      statusCode: 502,
      code: "PDF_REDIRECT_LIMIT",
    });
  }

  async #saveStream({ paperId, sourceUrl, input, storageKey, signal }) {
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
        ...(signal ? [{ signal }] : []),
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
  return new PdfArchiveService({
    ...options,
    ...(Object.hasOwn(options, "fetchImpl") &&
    !Object.hasOwn(options, "resolveHost")
      ? { resolveHost: null }
      : {}),
  });
}
