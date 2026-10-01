const configuredLibraryApiUrl =
  (
    import.meta as ImportMeta & {
      env?: { VITE_LIBRARY_API_URL?: string };
    }
  ).env?.VITE_LIBRARY_API_URL ?? "http://127.0.0.1:4317";

export const LIBRARY_API_BASE = `${configuredLibraryApiUrl.replace(/\/+$/, "")}/api`;

type ApiErrorPayload = {
  error?: string | { message?: string; details?: { action?: string } };
};

export async function libraryRequest<T>(path: string, init?: RequestInit) {
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
    const errorValue = payload?.error;
    const message =
      typeof errorValue === "object"
        ? errorValue.message || "本机文献数据库暂时不可用"
        : errorValue || "本机文献数据库暂时不可用";
    const action =
      typeof errorValue === "object" ? errorValue.details?.action : "";
    throw new Error(
      action && action !== message ? `${message} ${action}` : message,
    );
  }
  return payload as T;
}

export function pdfOpenUrl(paperId: string) {
  return `${LIBRARY_API_BASE}/papers/${encodeURIComponent(paperId)}/pdf/open`;
}
