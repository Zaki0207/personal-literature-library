import {
  AiServiceError,
  aiErrorFromHttp,
  normalizeAiTransportError,
} from "./errors.mjs";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

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

function shouldTryChatCompletions(error) {
  return (
    error instanceof AiServiceError &&
    ((error.diagnostics?.httpStatus === 404 &&
      error.diagnostics?.upstreamCode !== "model_not_found") ||
      (error.code === "INVALID_REQUEST" &&
        [400, 405, 415].includes(error.diagnostics?.httpStatus)))
  );
}

class BaseProvider {
  constructor({ fetchImpl = defaultProviderFetch, timeoutMs = 20_000 } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new TypeError("AI Provider 需要可用的 fetch 实现。");
    }
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
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

  async verify({ apiKey, model, baseUrl }) {
    const result = await this.generateText({
      apiKey,
      model,
      baseUrl,
      input: "Reply with exactly: OK",
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
  chatCompatibleBaseUrls = new Set();

  async generateChatCompletion({ apiKey, model, input, baseUrl, webSearch }) {
    if (webSearch) {
      throw new AiServiceError("WEB_SEARCH_UNSUPPORTED", {
        provider: this.id,
        diagnostics: { endpoint: "chat/completions" },
      });
    }
    const result = await this.request(
      providerEndpoint(baseUrl, "chat/completions"),
      {
        provider: this.id,
        apiKey,
        body: {
          model,
          messages: [{ role: "user", content: input }],
          stream: false,
        },
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

  async generateText({ apiKey, model, input, baseUrl, webSearch = false }) {
    const resolvedBaseUrl = baseUrl ?? AI_PROVIDER_DEFINITIONS.openai.baseUrl;
    if (this.chatCompatibleBaseUrls.has(resolvedBaseUrl)) {
      return this.generateChatCompletion({
        apiKey,
        model,
        input,
        baseUrl: resolvedBaseUrl,
        webSearch,
      });
    }

    let result;
    try {
      result = await this.request(
        providerEndpoint(resolvedBaseUrl, "responses"),
        {
          provider: this.id,
          apiKey,
          body: {
            model,
            input,
            store: false,
            ...(webSearch
              ? {
                  tools: [{ type: "web_search" }],
                  tool_choice: "required",
                }
              : {}),
          },
          ...(webSearch ? { timeoutMs: 120_000 } : {}),
        },
      );
    } catch (error) {
      if (!shouldTryChatCompletions(error)) throw error;
      if (webSearch) {
        throw new AiServiceError("WEB_SEARCH_UNSUPPORTED", {
          provider: this.id,
          diagnostics: {
            httpStatus: error.diagnostics?.httpStatus,
            upstreamCode: error.diagnostics?.upstreamCode,
          },
        });
      }
      const fallback = await this.generateChatCompletion({
        apiKey,
        model,
        input,
        baseUrl: resolvedBaseUrl,
      });
      this.chatCompatibleBaseUrls.add(resolvedBaseUrl);
      return fallback;
    }
    if (result.payload?.status !== "completed") {
      throw new AiServiceError("INVALID_RESPONSE", {
        provider: this.id,
        diagnostics: { status: result.payload?.status },
      });
    }
    return {
      provider: this.id,
      requestedModel: model,
      resolvedModel:
        typeof result.payload.model === "string" ? result.payload.model : model,
      text: openAiOutputText(result.payload),
      usage: result.payload.usage ?? null,
      latencyMs: result.latencyMs,
      requestId: result.requestId,
      webSearchUsed: webSearch,
    };
  }
}

export class DeepSeekProvider extends BaseProvider {
  id = "deepseek";

  async generateText({ apiKey, model, input, baseUrl }) {
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
          stream: false,
        },
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
