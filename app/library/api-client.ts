const configuredLibraryApiUrl =
  (
    import.meta as ImportMeta & {
      env?: { VITE_LIBRARY_API_URL?: string };
    }
  ).env?.VITE_LIBRARY_API_URL ?? "http://127.0.0.1:4317";

export const LIBRARY_API_BASE = `${configuredLibraryApiUrl.replace(/\/+$/, "")}/api`;

export type PaperIntakeDiagnostic = {
  reason: string;
  outputPreview: string;
  outputLength: number;
  truncated: boolean;
  model: string;
};

type ApiErrorDetails = {
  action?: string;
  intakeDiagnostic?: PaperIntakeDiagnostic;
};

type ApiErrorPayload = {
  error?: string | { message?: string; code?: string; details?: unknown };
};

function safeErrorDetails(code: string | undefined, value: unknown): ApiErrorDetails | undefined {
  if (!value || typeof value !== "object") return undefined;
  const details = value as Record<string, unknown>;
  const safe: ApiErrorDetails = {};
  if (typeof details.action === "string") safe.action = details.action;
  if (code === "INVALID_AI_RESULT" || code === "EMPTY_AI_RESPONSE") {
    const diagnostic = details.intakeDiagnostic;
    if (diagnostic && typeof diagnostic === "object") {
      const candidate = diagnostic as Record<string, unknown>;
      if (
        typeof candidate.reason === "string" &&
        typeof candidate.outputPreview === "string" &&
        typeof candidate.model === "string" &&
        typeof candidate.truncated === "boolean" &&
        typeof candidate.outputLength === "number" &&
        Number.isSafeInteger(candidate.outputLength) && candidate.outputLength >= 0
      ) {
        const outputPreview = candidate.outputPreview.slice(0, 16_000);
        safe.intakeDiagnostic = {
          reason: candidate.reason.slice(0, 512),
          model: candidate.model.slice(0, 256),
          outputPreview,
          outputLength: candidate.outputLength,
          truncated: candidate.truncated || outputPreview.length < candidate.outputPreview.length,
        };
      }
    }
  }
  return Object.keys(safe).length ? safe : undefined;
}

export class ApiRequestError extends Error {
  readonly code?: string;
  readonly details?: ApiErrorDetails;

  constructor(message: string, code?: string, details?: unknown) {
    super(message);
    this.name = "ApiRequestError";
    this.code = code;
    this.details = safeErrorDetails(code, details);
  }
}

function requestError(payload: ApiErrorPayload | null | undefined, fallback: string) {
  const error = payload?.error;
  const structured = error && typeof error === "object" ? error : undefined;
  const message = structured?.message || (typeof error === "string" ? error : "") || fallback;
  const code = typeof structured?.code === "string" ? structured.code : undefined;
  const details = safeErrorDetails(code, structured?.details);
  const action = details?.action;
  return new ApiRequestError(action && action !== message ? `${message} ${action}` : message, code, details);
}

export async function libraryRequest<T>(path: string, init?: RequestInit) {
  if (typeof window !== "undefined" && window.literatureDesktop) {
    const bridge = window.literatureDesktop;
    if (init?.signal?.aborted) throw new DOMException("请求已取消", "AbortError");
    const requestId = crypto.randomUUID();
    const cancel = () => { void bridge.cancelRequest(requestId); };
    init?.signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (init?.body instanceof File) {
        const match = path.match(/^\/papers\/([^/]+)\/pdf\/import$/);
        if (!match) throw new Error("文件只能通过 PDF 导入入口读取。");
        const grant = await bridge.grantDroppedPdf(init.body);
        const body = await bridge.importPdf(decodeURIComponent(match[1]), grant.id);
        return body as T;
      }
      const response = await bridge.request({
        path,
        method: (init?.method ?? "GET") as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
        requestId,
      });
      const payload = response.body as T & ApiErrorPayload;
      if (response.status < 200 || response.status >= 300) {
        throw requestError(payload, "本地请求失败");
      }
      return payload as T;
    } finally {
      init?.signal?.removeEventListener("abort", cancel);
    }
  }
  const response = await fetch(`${LIBRARY_API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const payload = (await response.json().catch(() => null)) as
    | (T & ApiErrorPayload)
    | null;
  if (!response.ok) {
    throw requestError(payload, "本机文献数据库暂时不可用");
  }
  return payload as T;
}

export function pdfOpenUrl(paperId: string) {
  if (typeof window !== "undefined" && window.literatureDesktop) {
    return window.literatureDesktop.pdfUrl(paperId);
  }
  return `${LIBRARY_API_BASE}/papers/${encodeURIComponent(paperId)}/pdf/open`;
}
