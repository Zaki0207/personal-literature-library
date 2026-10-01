import {
  AiServiceError,
  aiErrorFromHttp,
  normalizeAiTransportError,
} from "./errors.mjs";
import {
  aiRequestTimeoutMs,
  defaultReasoningEffort,
  isDeepSeekModel,
} from "./reasoning-effort.mjs";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import { setTimeout as delay } from "node:timers/promises";

function firstNonEmpty(...values) {
  return values.find(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
}

function httpCompatibleAllProxy(value) {
  if (!value) return undefined;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function createProxyAwareFetch(environment = process.env) {
  const allProxy = httpCompatibleAllProxy(
    firstNonEmpty(environment.all_proxy, environment.ALL_PROXY),
  );
  const httpProxy = firstNonEmpty(
    environment.http_proxy,
    environment.HTTP_PROXY,
    allProxy,
  );
  const httpsProxy = firstNonEmpty(
    environment.https_proxy,
    environment.HTTPS_PROXY,
    allProxy,
  );

  if (!httpProxy && !httpsProxy) return globalThis.fetch;

  const dispatcher = new EnvHttpProxyAgent({
    ...(httpProxy ? { httpProxy } : {}),
    ...(httpsProxy ? { httpsProxy } : {}),
    ...(firstNonEmpty(environment.no_proxy, environment.NO_PROXY)
      ? { noProxy: firstNonEmpty(environment.no_proxy, environment.NO_PROXY) }
      : {}),
  });

  return (url, init = {}) =>
    undiciFetch(url, {
      ...init,
      dispatcher,
    });
}

const defaultProviderFetch = createProxyAwareFetch();
const WEB_SEARCH_TIMEOUT_MS = 20 * 60_000;

function webSearchEvidence(payload) {
  const sources = new Map();
  let used = false;
  const add = (source) => {
    if (typeof source?.url !== "string") return;
    try {
      const url = new URL(source.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
      const previous = sources.get(url.href);
      sources.set(url.href, {
        url: url.href,
        title: typeof source.title === "string" ? source.title : previous?.title || "",
      });
    } catch {
      // Ignore malformed upstream citations.
    }
  };
  for (const item of payload?.output ?? []) {
    if (item.type === "web_search_call" && item.status === "completed") {
      used = true;
      for (const source of item.action?.sources ?? []) add(source);
      if (["open_page", "find_in_page"].includes(item.action?.type)) add(item.action);
    }
    for (const part of item.content ?? []) {
      for (const annotation of part.annotations ?? []) {
        if (annotation.type === "url_citation") add(annotation);
      }
    }
  }
  return { webSearchUsed: used, webSources: [...sources.values()] };
}

export const AI_PROVIDER_DEFINITIONS = Object.freeze({
  openai: Object.freeze({
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    modelPlaceholder: "例如：gpt-5.6",
  }),
  deepseek: Object.freeze({
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    modelPlaceholder: "例如：deepseek-v4-flash",
  }),
});

async function responseJson(response) {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    if (!response.ok) return null;
    throw new AiServiceError("INVALID_RESPONSE", {
      diagnostics: {
        httpStatus: response.status,
        contentType: response.headers.get("content-type") ?? undefined,
      },
    });
  }
}

function sseEventBlocks(value) {
  const blocks = [];
  let remaining = value;
  while (remaining) {
    const lfIndex = remaining.indexOf("\n\n");
    const crlfIndex = remaining.indexOf("\r\n\r\n");
    const indexes = [
      lfIndex >= 0 ? { index: lfIndex, length: 2 } : null,
      crlfIndex >= 0 ? { index: crlfIndex, length: 4 } : null,
    ].filter(Boolean);
    if (!indexes.length) break;
    const boundary = indexes.sort((left, right) => left.index - right.index)[0];
    blocks.push(remaining.slice(0, boundary.index));
    remaining = remaining.slice(boundary.index + boundary.length);
  }
  return { blocks, remaining };
}

function sseData(block) {
  return block
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}

function responseFailure(payload, response, provider) {
  const error = payload?.error || payload;
  const code = error?.code;
  const status = code === "rate_limit_exceeded" ? 429
    : code === "invalid_api_key" ? 401
      : code === "model_not_found" ? 404
        : code === "invalid_request_error" ? 400 : 503;
  return aiErrorFromHttp({
    provider,
    response: { status, headers: response.headers },
    payload: { error },
  });
}

async function responseFromSse(response, provider) {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/event-stream")) {
    return responseJson(response);
  }
  if (!response.body) {
    throw new AiServiceError("INVALID_RESPONSE", {
      diagnostics: { contentType },
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completedResponse = null;
  const completedItems = new Map();

  const consumeBlock = (block) => {
    const data = sseData(block);
    if (!data || data === "[DONE]") return;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      throw new AiServiceError("INVALID_RESPONSE", {
        diagnostics: { contentType },
      });
    }
    if (event?.type === "error" || event?.type === "response.failed") {
      throw responseFailure(event.response || event, response, provider);
    }
    if (event?.type === "response.incomplete") {
      throw new AiServiceError("RESPONSE_INCOMPLETE", { provider });
    }
    if (event?.type === "response.output_item.done" && event.item?.id) {
      completedItems.set(event.item.id, event.item);
    }
    if (event?.type === "response.completed" && event.response?.status === "completed") {
      completedResponse = {
        ...event.response,
        output: event.response.output?.length ? event.response.output : [...completedItems.values()],
      };
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const parsed = sseEventBlocks(buffer);
      buffer = parsed.remaining;
      for (const block of parsed.blocks) {
        consumeBlock(block);
        if (completedResponse) return completedResponse;
      }
      if (done) break;
    }
    if (buffer.trim()) consumeBlock(buffer);
    if (completedResponse) return completedResponse;
    throw new AiServiceError("STREAM_INTERRUPTED", {
      provider,
      diagnostics: { requestId: response.headers.get("x-request-id") ?? undefined },
    });
  } finally {
    // A completed Responses event is terminal; a gateway need not close TCP.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function providerEndpoint(baseUrl, pathname) {
  return `${baseUrl.replace(/\/+$/u, "")}/${pathname.replace(/^\/+/, "")}`;
}

function openAiOutputText(payload) {
  if (!Array.isArray(payload?.output)) return "";
  return payload.output
    .filter((item) => item?.type === "message")
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((content) => content?.type === "output_text")
    .map((content) => (typeof content.text === "string" ? content.text : ""))
    .join("");
}

function chatCompletionText(payload) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  return typeof choice?.message?.content === "string"
    ? choice.message.content
    : "";
}

class BaseProvider {
  constructor({ fetchImpl = defaultProviderFetch, timeoutMs = 20_000, maxRetries = 2, retryDelayMs = 750 } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new TypeError("AI Provider 需要可用的 fetch 实现。");
    }
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxRetries = Math.max(0, Math.min(2, maxRetries));
    this.retryDelayMs = Math.max(0, retryDelayMs);
  }

  async request(url, { provider, apiKey, body, timeoutMs = this.timeoutMs }) {
    const startedAt = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await responseJson(response);
      if (!response.ok) {
        throw aiErrorFromHttp({ provider, response, payload });
      }
      return {
        payload,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        requestId: response.headers.get("x-request-id") ?? undefined,
      };
    } catch (error) {
      throw normalizeAiTransportError(error, provider);
    } finally {
      clearTimeout(timer);
    }
  }

  async requestStream(
    url,
    { provider, apiKey, body, timeoutMs = this.timeoutMs },
  ) {
    const startedAt = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = await responseJson(response);
        throw aiErrorFromHttp({ provider, response, payload });
      }
      return {
        payload: await responseFromSse(response, provider),
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        requestId: response.headers.get("x-request-id") ?? undefined,
      };
    } catch (error) {
      throw normalizeAiTransportError(error, provider);
    } finally {
      clearTimeout(timer);
    }
  }

  async verify({ apiKey, model, baseUrl, reasoningEffort }) {
    const result = await this.generateText({
      apiKey,
      model,
      baseUrl,
      input: "Reply with exactly: OK",
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
    if (!result.text.trim()) {
      throw new AiServiceError("INVALID_RESPONSE", {
        provider: this.id,
        diagnostics: { resolvedModel: result.resolvedModel },
      });
    }
    return result;
  }
}

export class OpenAiProvider extends BaseProvider {
  id = "openai";

  async requestResponses(url, options) {
    const deadline = performance.now() + options.timeoutMs;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await this.requestStream(url, {
          ...options,
          timeoutMs: attempt === 0 ? options.timeoutMs : Math.max(1, deadline - performance.now()),
        });
        if (result.payload?.status === "failed" || result.payload?.error) {
          throw responseFailure(result.payload, {
            headers: new Headers(result.requestId ? { "x-request-id": result.requestId } : {}),
          }, this.id);
        }
        if (result.payload?.status === "incomplete") {
          throw new AiServiceError("RESPONSE_INCOMPLETE", { provider: this.id });
        }
        if (result.payload?.status !== "completed") {
          throw new AiServiceError("INVALID_RESPONSE", { provider: this.id });
        }
        return { ...result, attempts: attempt + 1 };
      } catch (caught) {
        let error = normalizeAiTransportError(caught, this.id);
        if (error.diagnostics.httpStatus === 404 && error.diagnostics.upstreamCode !== "model_not_found") {
          error = new AiServiceError("RESPONSES_UNSUPPORTED", {
            provider: this.id, diagnostics: error.diagnostics,
          });
        }
        const retryAfter = error.diagnostics.retryAfter;
        const retryAfterMs = retryAfter
          ? Number.isFinite(Number(retryAfter))
            ? Number(retryAfter) * 1_000
            : Math.max(0, Date.parse(retryAfter) - Date.now()) : 0;
        const waitMs = Math.max(this.retryDelayMs * 2 ** attempt, retryAfterMs || 0);
        const retryable = ["PROVIDER_UNAVAILABLE", "RATE_LIMITED", "NETWORK_ERROR", "STREAM_INTERRUPTED"].includes(error.code);
        if (retryable && attempt < this.maxRetries && waitMs <= 10_000 && performance.now() + waitMs < deadline) {
          await delay(waitMs);
          continue;
        }
        error.details.protocol = "Responses";
        error.details.attempts = attempt + 1;
        const status = error.diagnostics.httpStatus;
        if (Number.isInteger(status)) error.details.httpStatus = status;
        const statusLabel = status ? " HTTP " + status : "";
        const retryLabel = attempt > 0 ? "，已自动重试 " + attempt + " 次" : "";
        if (error.code === "PROVIDER_UNAVAILABLE") {
          error.message = "当前服务的 Responses 接口返回错误" + statusLabel + retryLabel + "。";
        } else {
          error.message += "（Responses" + statusLabel + retryLabel + "）";
        }
        throw error;
      }
    }
  }

  async generateText({
    apiKey,
    model,
    input,
    baseUrl,
    webSearch = false,
    reasoningEffort,
  }) {
    const resolvedBaseUrl = baseUrl ?? AI_PROVIDER_DEFINITIONS.openai.baseUrl;
    const result = await this.requestResponses(
      providerEndpoint(resolvedBaseUrl, "responses"),
      {
        provider: this.id,
        apiKey,
        timeoutMs: webSearch ? WEB_SEARCH_TIMEOUT_MS : aiRequestTimeoutMs(),
        body: {
          model,
          input,
          store: false,
          stream: true,
          ...(reasoningEffort
            ? isDeepSeekModel(model)
              ? { thinking: { type: "enabled" }, reasoning_effort: reasoningEffort }
              : { reasoning: { effort: reasoningEffort } }
            : {}),
          ...(webSearch ? {
            tools: [{ type: "web_search" }],
            tool_choice: "auto",
            include: ["web_search_call.action.sources"],
          } : {}),
        },
      },
    );
    return {
      provider: this.id,
      protocol: "responses",
      requestedModel: model,
      resolvedModel: typeof result.payload.model === "string" ? result.payload.model : model,
      text: openAiOutputText(result.payload),
      usage: result.payload.usage ?? null,
      latencyMs: result.latencyMs,
      requestId: result.requestId,
      attempts: result.attempts,
      ...webSearchEvidence(result.payload),
    };
  }
}

export class DeepSeekProvider extends BaseProvider {
  id = "deepseek";

  async generateText({
    apiKey,
    model,
    input,
    baseUrl,
    reasoningEffort = defaultReasoningEffort(model),
    webSearch = false,
  }) {
    if (webSearch) throw new AiServiceError("WEB_SEARCH_UNSUPPORTED", { provider: this.id });
    const effectiveTimeoutMs = aiRequestTimeoutMs();
    const result = await this.request(
      providerEndpoint(
        baseUrl ?? AI_PROVIDER_DEFINITIONS.deepseek.baseUrl,
        "chat/completions",
      ),
      {
        provider: this.id,
        apiKey,
        body: {
          model,
          messages: [{ role: "user", content: input }],
          thinking: { type: "enabled" },
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          stream: false,
        },
        ...(effectiveTimeoutMs ? { timeoutMs: effectiveTimeoutMs } : {}),
      },
    );
    return {
      provider: this.id,
      requestedModel: model,
      resolvedModel:
        typeof result.payload?.model === "string" ? result.payload.model : model,
      text: chatCompletionText(result.payload),
      usage: result.payload?.usage ?? null,
      latencyMs: result.latencyMs,
      requestId: result.requestId,
    };
  }
}

export function createAiProviders(options = {}) {
  return new Map([
    ["openai", new OpenAiProvider(options)],
    ["deepseek", new DeepSeekProvider(options)],
  ]);
}
