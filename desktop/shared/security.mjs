const entity = "[A-Za-z0-9_-]{1,128}";
const routes = [
  [/^\/api\/(library|health)$/, ["GET"]],
  [/^\/api\/papers$/, ["POST"]],
  [new RegExp(`^/api/papers/${entity}$`), ["GET", "PATCH", "DELETE"]],
  [new RegExp(`^/api/papers/${entity}/restore$`), ["POST"]],
  [new RegExp(`^/api/papers/${entity}/pdf/archive$`), ["POST", "DELETE"]],
  [new RegExp(`^/api/papers/${entity}/reading-position$`), ["GET", "PUT"]],
  [/^\/api\/paper-intake\/analyze$/, ["POST"]],
  [/^\/api\/paper-intake\/prompt-template$/, ["GET", "PUT"]],
  [/^\/api\/paper-intake\/prompt-template\/reset$/, ["POST"]],
  [/^\/api\/categories$/, ["GET", "POST"]],
  [/^\/api\/categories\/reorder$/, ["PUT"]],
  [new RegExp(`^/api/categories/${entity}$`), ["PATCH", "DELETE"]],
  [new RegExp(`^/api/categories/${entity}/restore$`), ["POST"]],
  [/^\/api\/ai\/settings$/, ["GET"]],
  [/^\/api\/ai\/connections$/, ["POST"]],
  [new RegExp(`^/api/ai/connections/${entity}$`), ["PATCH", "DELETE"]],
  [new RegExp(`^/api/ai/connections/${entity}/models/verify$`), ["POST"]],
  [new RegExp(`^/api/ai/models/${entity}$`), ["PATCH", "DELETE"]],
  [new RegExp(`^/api/ai/models/${entity}/active$`), ["PUT"]],
  [/^\/api\/radar$/, ["GET", "PUT"]],
  [/^\/api\/radar\/ai-trace$/, ["GET"]],
  [/^\/api\/radar\/prompt-template$/, ["PUT"]],
  [/^\/api\/radar\/prompt-template\/default$/, ["GET"]],
  [/^\/api\/radar\/run$/, ["POST"]],
  [/^\/api\/radar\/tasks$/, ["GET", "POST"]],
  [new RegExp(`^/api/radar/tasks/${entity}$`), ["GET"]],
  [new RegExp(`^/api/radar/tasks/${entity}/cancel$`), ["POST"]],
  [new RegExp(`^/api/radar/items/${entity}/(discard|restore|add)$`), ["POST"]],
  [/^\/api\/knowledge\/settings$/, ["GET", "PUT"]],
];

export function assertPaperId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new Error("论文 ID 无效。");
  }
  return value;
}

export function validateApiRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("桌面请求必须是对象。");
  }
  if (Object.keys(input).some((key) => !["path", "method", "body", "requestId"].includes(key))) {
    throw new Error("桌面请求包含不支持的字段。");
  }
  const method = input.method ?? "GET";
  const path = input.path;
  if (typeof path !== "string" || path.length > 1024 || /[#\\\s]/u.test(path)) {
    throw new Error("桌面 API 路径无效。");
  }
  const [pathname, query] = path.split("?");
  if (pathname.includes("%") || path.split("?").length > 2) throw new Error("桌面 API 路径无效。");
  if (query !== undefined) {
    const params = new URLSearchParams(query);
    if (method !== "GET" || !new RegExp(`^/api/papers/${entity}/reading-position$`).test(pathname)
      || [...params.keys()].length !== 1 || !params.has("pdfVersion") || !/^[A-Za-z0-9:_-]{1,128}$/u.test(params.get("pdfVersion"))) {
      throw new Error("桌面 API 查询参数无效。");
    }
  }
  if (!routes.some(([pattern, methods]) => pattern.test(pathname) && methods.includes(method))) {
    throw new Error("不允许访问这个桌面 API。");
  }
  if (input.requestId !== undefined && (typeof input.requestId !== "string" || !/^[\w-]{1,128}$/u.test(input.requestId))) {
    throw new Error("请求 ID 无效。");
  }
  if (method === "GET" && input.body !== undefined) throw new Error("读取请求不能包含正文。");
  const body = input.body === undefined ? undefined : JSON.stringify(input.body);
  if (body !== undefined && Buffer.byteLength(body) > 1_048_576) throw new Error("请求正文超过 1 MiB。");
  return { path, method, body, requestId: input.requestId };
}

export function safeExternalUrl(value) {
  if (typeof value !== "string" || value.length > 8192) throw new Error("外部链接无效。");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("外部链接必须是 HTTP 或 HTTPS 地址。");
  }
  return url.href;
}

export function parsePdfUrl(value) {
  if (typeof value !== "string" || !/^literature-pdf:\/\/paper\/[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new Error("PDF 地址无效。");
  const url = new URL(value);
  if (url.protocol !== "literature-pdf:" || url.hostname !== "paper" || url.search || url.hash || url.username || url.password) {
    throw new Error("PDF 地址无效。");
  }
  return assertPaperId(decodeURIComponent(url.pathname.slice(1)));
}
