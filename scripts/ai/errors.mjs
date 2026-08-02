import { randomUUID } from "node:crypto";

const QUOTA_ERROR_CODES = new Set([
  "credit_balance_exhausted",
  "insufficient_quota",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
]);

const PUBLIC_ERRORS = {
  INVALID_CREDENTIAL: {
    message: "API Key 无效、已失效或没有调用权限。",
    action: "请检查并重新输入 API Key。",
    statusCode: 401,
    retryable: false,
  },
  ACCESS_DENIED: {
    message: "当前账号、项目或所在地区无法访问该服务。",
    action: "请检查服务商账户权限和区域限制。",
    statusCode: 403,
    retryable: false,
  },
  MODEL_UNAVAILABLE: {
    message: "模型不存在、不可用，或当前 API Key 无权访问。",
    action: "请检查模型 ID，或在服务商控制台确认模型权限。",
    statusCode: 400,
    retryable: false,
  },
  INVALID_REQUEST: {
    message: "当前模型不支持这次验证请求。",
    action: "请检查模型 ID，或改用支持文本生成的模型。",
    statusCode: 400,
    retryable: false,
  },
  QUOTA_EXCEEDED: {
    message: "账户余额、额度或消费上限不足。",
    action: "请前往服务商控制台检查余额与消费限制。",
    statusCode: 402,
    retryable: false,
  },
  RATE_LIMITED: {
    message: "服务商暂时限制了请求频率。",
    action: "请稍后再试。",
    statusCode: 429,
    retryable: true,
  },
  PROVIDER_UNAVAILABLE: {
    message: "AI 服务暂时不可用。",
    action: "请稍后重试；如果持续失败，请检查服务商状态。",
    statusCode: 503,
    retryable: true,
  },
  NETWORK_ERROR: {
    message: "无法连接 AI 服务。",
    action: "请检查网络、防火墙或代理设置。",
    statusCode: 503,
    retryable: true,
  },
  REQUEST_TIMEOUT: {
    message: "连接 AI 服务超时。",
    action: "请检查网络后重试。",
    statusCode: 504,
    retryable: true,
  },
  INVALID_RESPONSE: {
    message: "AI 服务返回了无法识别的结果。",
    action: "请重试，或更换模型 ID。",
    statusCode: 502,
    retryable: true,
  },
  AI_NOT_CONFIGURED: {
    message: "AI 服务尚未完成配置。",
    action: "请先填写 API Key 和模型 ID，并完成验证。",
    statusCode: 400,
    retryable: false,
  },
  KEYCHAIN_UNAVAILABLE: {
    message: "无法访问 macOS 钥匙串。",
    action: "请允许钥匙串访问后重试。",
    statusCode: 503,
    retryable: true,
  },
};

export class AiServiceError extends Error {
  constructor(code, { provider, diagnostics, message } = {}) {
    const definition = PUBLIC_ERRORS[code] ?? PUBLIC_ERRORS.PROVIDER_UNAVAILABLE;
    super(message ?? definition.message);
    this.name = "AiServiceError";
    this.code = code;
    this.statusCode = definition.statusCode;
    this.details = {
      ...(provider ? { provider } : {}),
      retryable: definition.retryable,
      action: definition.action,
      diagnosticId: `diag_${randomUUID()}`,
    };
    Object.defineProperty(this, "diagnostics", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: diagnostics ?? {},
    });
  }
}

function providerErrorCode(payload) {
  const code = payload?.error?.code;
  return typeof code === "string" ? code : "";
}

function providerErrorParam(payload) {
  const param = payload?.error?.param;
  return typeof param === "string" ? param : "";
}

export function aiErrorFromHttp({ provider, response, payload }) {
  const status = response.status;
  const upstreamCode = providerErrorCode(payload);
  const param = providerErrorParam(payload);
  const diagnostics = {
    provider,
    httpStatus: status,
    upstreamCode,
    requestId: response.headers.get("x-request-id") ?? undefined,
  };

  if (status === 401) {
    return new AiServiceError("INVALID_CREDENTIAL", {
      provider,
      diagnostics,
    });
  }
  if (status === 403) {
    return new AiServiceError("ACCESS_DENIED", { provider, diagnostics });
  }
  if (status === 404 || upstreamCode === "model_not_found") {
    return new AiServiceError("MODEL_UNAVAILABLE", {
      provider,
      diagnostics,
    });
  }
  if (status === 402 || QUOTA_ERROR_CODES.has(upstreamCode)) {
    return new AiServiceError("QUOTA_EXCEEDED", {
      provider,
      diagnostics,
    });
  }
  if (status === 429) {
    return new AiServiceError("RATE_LIMITED", { provider, diagnostics });
  }
  if (status >= 500) {
    return new AiServiceError("PROVIDER_UNAVAILABLE", {
      provider,
      diagnostics,
    });
  }
  if (param === "model" || status === 422) {
    return new AiServiceError("MODEL_UNAVAILABLE", {
      provider,
      diagnostics,
    });
  }
  return new AiServiceError("INVALID_REQUEST", { provider, diagnostics });
}

export function normalizeAiTransportError(error, provider) {
  if (error instanceof AiServiceError) return error;
  if (error?.name === "AbortError" || error?.name === "TimeoutError") {
    return new AiServiceError("REQUEST_TIMEOUT", {
      provider,
      diagnostics: { name: error?.name },
    });
  }
  return new AiServiceError("NETWORK_ERROR", {
    provider,
    diagnostics: { name: error?.name, code: error?.code },
  });
}

export function keychainAiError(error) {
  if (error instanceof AiServiceError) return error;
  return new AiServiceError("KEYCHAIN_UNAVAILABLE", {
    diagnostics: { name: error?.name, code: error?.code },
  });
}
