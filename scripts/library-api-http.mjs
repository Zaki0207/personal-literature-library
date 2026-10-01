import { createReadStream } from "node:fs";
import { ValidationError } from "./library-repository.mjs";

const MAX_BODY_BYTES = 1_048_576;
const LOCAL_WEB_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function allowedOrigin(origin) {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      LOCAL_WEB_HOSTS.has(url.hostname.toLocaleLowerCase("en"))
    ) {
      return url.origin;
    }
  } catch {
    return null;
  }
  return null;
}

function responseHeaders(request, extra = {}) {
  const origin = allowedOrigin(request.headers.origin);
  return {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    ...(origin
      ? {
          "Access-Control-Allow-Origin": origin,
          Vary: "Origin",
        }
      : {}),
    ...extra,
  };
}

export function sendJson(
  response,
  request,
  statusCode,
  value,
  extraHeaders = {},
) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    ...responseHeaders(request, extraHeaders),
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

export function sendNoContent(response, request) {
  const origin = allowedOrigin(request.headers.origin);
  response.writeHead(204, {
    "Cache-Control": "no-store",
    ...(origin
      ? {
          "Access-Control-Allow-Origin": origin,
          Vary: "Origin",
        }
      : {}),
    "Access-Control-Allow-Methods":
      "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
  });
  response.end();
}

export function sendRedirect(response, request, location) {
  response.writeHead(302, {
    ...responseHeaders(request, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": "0",
      Location: location,
      "Referrer-Policy": "no-referrer",
    }),
  });
  response.end();
}

function pdfFilename(title) {
  const name = String(title ?? "论文")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 120);
  return `${name || "论文"}.pdf`;
}

export function parsePdfRange(value, sizeBytes) {
  if (!value) return { start: 0, end: sizeBytes - 1 };
  const match = String(value).match(/^bytes=(\d*)-(\d*)$/u);
  if (!match) return null;
  const [, startText, endText] = match;
  if (!startText && !endText) return null;
  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return {
      start: Math.max(0, sizeBytes - suffixLength),
      end: sizeBytes - 1,
    };
  }
  const start = Number(startText);
  const end = endText ? Number(endText) : sizeBytes - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= sizeBytes
  ) {
    return null;
  }
  return { start, end: Math.min(end, sizeBytes - 1) };
}

export function sendPdfFile(response, request, file, title) {
  const range = parsePdfRange(request.headers.range, file.sizeBytes);
  if (!range) {
    response.writeHead(416, {
      ...responseHeaders(request, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Range": `bytes */${file.sizeBytes}`,
        "Content-Length": "0",
        "Accept-Ranges": "bytes",
      }),
    });
    response.end();
    return;
  }
  const length = range.end - range.start + 1;
  const partial = Boolean(request.headers.range);
  const filename = pdfFilename(title);
  response.writeHead(partial ? 206 : 200, {
    ...responseHeaders(request, {
      "Content-Type": "application/pdf",
      "Content-Length": String(length),
      "Accept-Ranges": "bytes",
      ...(partial
        ? {
            "Content-Range": `bytes ${range.start}-${range.end}/${file.sizeBytes}`,
          }
        : {}),
      "Content-Disposition": `inline; filename="paper.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    }),
  });
  const stream = createReadStream(file.path, {
    start: range.start,
    end: range.end,
  });
  stream.once("error", () => response.destroy());
  stream.pipe(response);
}

function assertLocalRequestOrigin(request, message) {
  const origin = request.headers.origin;
  if (origin && !allowedOrigin(origin)) {
    const error = new Error(message);
    error.statusCode = 403;
    error.code = "ORIGIN_NOT_ALLOWED";
    throw error;
  }
}

export function assertMutationRequestOrigin(request) {
  assertLocalRequestOrigin(request, "本地文献库写入接口只接受本机页面请求。");
}

export function assertAiRequestOrigin(request) {
  assertLocalRequestOrigin(request, "AI 配置接口只接受本机页面请求。");
}

export function assertPdfRequestOrigin(request) {
  assertLocalRequestOrigin(request, "PDF 归档接口只接受本机页面请求。");
}

export function readPdfArchiveOptions(input) {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    throw new ValidationError("请求正文必须是 JSON 对象。");
  }
  const fields = Object.keys(input);
  if (fields.some((field) => field !== "force")) {
    throw new ValidationError("PDF 归档请求仅支持 force 字段。");
  }
  if (input.force !== undefined && typeof input.force !== "boolean") {
    throw new ValidationError("force 必须是布尔值。");
  }
  return { force: input.force === true };
}

export async function readJsonBody(request) {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLocaleLowerCase("en").includes("application/json")) {
    throw new ValidationError("Content-Type 必须是 application/json。");
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new ValidationError("请求正文不能超过 1 MiB。");
    }
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) {
    throw new ValidationError("请求正文不能为空。");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError("请求正文不是有效的 JSON。");
  }
}

export async function readOptionalJsonBody(request) {
  const contentLength = request.headers["content-length"];
  if (
    (contentLength === undefined || contentLength === "0") &&
    request.headers["transfer-encoding"] === undefined
  ) {
    return {};
  }
  return readJsonBody(request);
}

function routeEntityId(pathname, { prefix, suffix = "", invalidMessage }) {
  const pattern = suffix
    ? new RegExp(`^${prefix}/([^/]+)/${suffix}$`)
    : new RegExp(`^${prefix}/([^/]+)$`);
  const match = pathname.match(pattern);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    throw new ValidationError(invalidMessage);
  }
}

export function routePaperId(pathname, suffix = "") {
  return routeEntityId(pathname, {
    prefix: "/api/papers",
    suffix,
    invalidMessage: "论文 ID 编码无效。",
  });
}

export function routeCategoryId(pathname, suffix = "") {
  return routeEntityId(pathname, {
    prefix: "/api/categories",
    suffix,
    invalidMessage: "分类 ID 编码无效。",
  });
}

export function routeAiConnection(pathname, suffix = "") {
  return routeEntityId(pathname, {
    prefix: "/api/ai/connections",
    suffix,
    invalidMessage: "AI 服务连接 ID 编码无效。",
  });
}

export function routeAiModel(pathname, suffix = "") {
  return routeEntityId(pathname, {
    prefix: "/api/ai/models",
    suffix,
    invalidMessage: "AI 模型配置 ID 编码无效。",
  });
}

export function routeRadarItem(pathname, suffix) {
  return routeEntityId(pathname, {
    prefix: "/api/radar/items",
    suffix,
    invalidMessage: "文献雷达条目 ID 编码无效。",
  });
}

export function errorPayload(error) {
  return {
    error: {
      code: error.code ?? "INTERNAL_ERROR",
      message:
        error.statusCode && error.message
          ? error.message
          : "本地文献库发生内部错误。",
      ...(error.details ? { details: error.details } : {}),
    },
  };
}
