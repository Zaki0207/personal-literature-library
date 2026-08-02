import { randomUUID } from "node:crypto";
import { MacOsKeychainCredentialStore } from "./credential-store.mjs";
import { createAiProviders } from "./providers.mjs";
import { AiServiceError, keychainAiError } from "./errors.mjs";

function validationError(message, field) {
  const error = new Error(message);
  error.name = "ValidationError";
  error.statusCode = 400;
  error.code = "VALIDATION_ERROR";
  error.details = { field };
  return error;
}

function conflictError(message, details) {
  const error = new Error(message);
  error.name = "ConflictError";
  error.statusCode = 409;
  error.code = "CONFLICT";
  error.details = details;
  return error;
}

function validateEntityId(value, field) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
  ) {
    throw validationError(`${field} 格式无效。`, field);
  }
  return value;
}

function validateModel(model) {
  if (
    typeof model !== "string" ||
    !model.trim() ||
    model.trim().length > 200 ||
    /[\s\u0000-\u001f\u007f]/u.test(model.trim())
  ) {
    throw validationError(
      "模型 ID 必须是 1 到 200 个字符，且不能包含空格或控制字符。",
      "model",
    );
  }
  return model.trim();
}

function validateApiKey(apiKey) {
  if (apiKey === undefined || apiKey === null || apiKey === "") return null;
  if (
    typeof apiKey !== "string" ||
    !apiKey.trim() ||
    apiKey.trim().length > 8_192 ||
    /[\r\n\u0000]/u.test(apiKey)
  ) {
    throw validationError("API Key 格式无效。", "apiKey");
  }
  return apiKey.trim();
}

function validateBaseUrl(baseUrl) {
  if (
    typeof baseUrl !== "string" ||
    !baseUrl.trim() ||
    baseUrl.trim().length > 2_048 ||
    /[\u0000-\u001f\u007f]/u.test(baseUrl)
  ) {
    throw validationError("Base URL 必须是有效的网址。", "baseUrl");
  }

  let url;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw validationError("Base URL 必须是有效的网址。", "baseUrl");
  }

  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const secure = url.protocol === "https:";
  const localHttp =
    url.protocol === "http:" && loopbackHosts.has(url.hostname.toLowerCase());
  if (!secure && !localHttp) {
    throw validationError(
      "Base URL 必须使用 HTTPS；只有本机地址可以使用 HTTP。",
      "baseUrl",
    );
  }
  if (url.username || url.password) {
    throw validationError("Base URL 不能包含用户名或密码。", "baseUrl");
  }
  if (url.search || url.hash) {
    throw validationError("Base URL 不能包含查询参数或片段。", "baseUrl");
  }

  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

function validateServiceName(name, baseUrl) {
  const fallback = new URL(baseUrl).hostname;
  const value =
    name === undefined ||
    name === null ||
    (typeof name === "string" && !name.trim())
      ? fallback
      : name;
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 100 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw validationError("服务名称必须是 1 到 100 个字符。", "name");
  }
  return value.trim();
}

export function createAiService({
  repository,
  credentialStore = new MacOsKeychainCredentialStore(),
  providers = createAiProviders(),
} = {}) {
  if (!repository) throw new TypeError("AI Service 需要文献库 repository。");

  const compatibleProvider = providers.get("openai") ?? providers.values().next().value;
  if (!compatibleProvider) {
    throw new TypeError("AI Service 需要 OpenAI 兼容 Provider。");
  }

  const credentialExists = async (credentialKey) => {
    try {
      return await credentialStore.has(credentialKey);
    } catch (error) {
      throw keychainAiError(error);
    }
  };

  const readCredential = async (credentialKey) => {
    try {
      return await credentialStore.get(credentialKey);
    } catch (error) {
      throw keychainAiError(error);
    }
  };

  const writeCredential = async (credentialKey, secret) => {
    try {
      await credentialStore.set(credentialKey, secret);
    } catch (error) {
      throw keychainAiError(error);
    }
  };

  const deleteCredential = async (credentialKey) => {
    try {
      await credentialStore.delete(credentialKey);
    } catch (error) {
      throw keychainAiError(error);
    }
  };

  const restoreCredential = async (credentialKey, previousSecret) => {
    if (previousSecret === null) {
      await deleteCredential(credentialKey);
      return;
    }
    await writeCredential(credentialKey, previousSecret);
  };

  const settings = async () => {
    const services = repository.getAiServices();
    const internalConnections = await Promise.all(
      services.map(async (service) => {
        const configured = await credentialExists(service.credentialKey);
        return {
          id: service.id,
          name: service.name,
          baseUrl: service.baseUrl,
          configured,
          status: configured ? "verified" : "credential-missing",
          models: service.models.map((model) => ({
            id: model.id,
            model: model.model,
            resolvedModel: model.resolvedModel,
            verifiedAt: model.verifiedAt,
            persistedActive: Boolean(model.active),
          })),
        };
      }),
    );

    const configuredModels = internalConnections
      .filter((connection) => connection.configured)
      .flatMap((connection) => connection.models);
    const persistedActiveModel = configuredModels.find(
      (model) => model.persistedActive,
    );
    const fallbackModel = [...configuredModels].sort((left, right) => {
      const leftTime = Date.parse(left.verifiedAt ?? "") || 0;
      const rightTime = Date.parse(right.verifiedAt ?? "") || 0;
      return rightTime - leftTime || left.id.localeCompare(right.id);
    })[0];
    const activeModelId = persistedActiveModel?.id ?? fallbackModel?.id ?? null;
    const connections = internalConnections.map((connection) => ({
      ...connection,
      models: connection.models.map((model) => ({
        id: model.id,
        model: model.model,
        resolvedModel: model.resolvedModel,
        verifiedAt: model.verifiedAt,
        active: Boolean(connection.configured && model.id === activeModelId),
      })),
    }));
    return {
      connections,
      activeModelId,
    };
  };

  const reconcileActiveModel = async (backup) => {
    const resolvedSettings = await settings();
    const persistedActiveModel = repository
      .getAiServices()
      .flatMap((service) => service.models)
      .find((model) => model.active);
    if (persistedActiveModel?.id === resolvedSettings.activeModelId) {
      return { settings: resolvedSettings, backup };
    }
    if (resolvedSettings.activeModelId) {
      const saved = await repository.setActiveAiModel(
        resolvedSettings.activeModelId,
      );
      return { settings: await settings(), backup: saved.backup };
    }
    if (persistedActiveModel) {
      const saved = await repository.clearActiveAiModel();
      return { settings: await settings(), backup: saved.backup };
    }
    return { settings: resolvedSettings, backup };
  };

  return {
    getSettings: settings,

    async verifyAndSave(connectionId, input = {}) {
      const normalizedConnectionId = connectionId
        ? validateEntityId(connectionId, "connectionId")
        : randomUUID();
      const existingService = connectionId
        ? repository.getAiService(normalizedConnectionId)
        : null;
      if (connectionId && !existingService) {
        const error = new Error("未找到要更新的 AI 服务连接。");
        error.name = "NotFoundError";
        error.statusCode = 404;
        error.code = "NOT_FOUND";
        throw error;
      }

      const model = validateModel(input.model);
      const submittedKey = validateApiKey(input.apiKey);
      const previousBaseUrl = existingService
        ? validateBaseUrl(existingService.baseUrl)
        : null;
      const baseUrl = validateBaseUrl(input.baseUrl ?? previousBaseUrl ?? "");
      const name = validateServiceName(
        input.name ?? existingService?.name,
        baseUrl,
      );
      if (!submittedKey && previousBaseUrl && baseUrl !== previousBaseUrl) {
        throw validationError(
          "Base URL 已更改，请重新输入 API Key 以确认发送目标。",
          "baseUrl",
        );
      }
      const duplicate = repository
        .getAiServices()
        .find(
          (service) =>
            validateBaseUrl(service.baseUrl) === baseUrl &&
            service.id !== normalizedConnectionId,
        );
      if (duplicate) {
        throw conflictError("该 Base URL 已经存在，无需重复添加。", {
          field: "baseUrl",
          connectionId: duplicate.id,
        });
      }

      const duplicateModel = existingService?.models.find(
        (entry) => entry.model === model,
      );
      if (
        duplicateModel &&
        baseUrl === previousBaseUrl &&
        input.reverify !== true
      ) {
        throw conflictError("该模型已经添加，无需重复验证。", {
          field: "model",
          connectionId: normalizedConnectionId,
          modelId: duplicateModel.id,
        });
      }

      const credentialKey =
        existingService?.credentialKey ?? normalizedConnectionId;
      const apiKey = submittedKey ?? (await readCredential(credentialKey));
      if (!apiKey) {
        throw new AiServiceError("AI_NOT_CONFIGURED");
      }

      const verification = await compatibleProvider.verify({
        apiKey,
        model,
        baseUrl,
      });

      const currentSettings = await settings();
      const previousCredential = submittedKey
        ? await readCredential(credentialKey)
        : null;
      if (submittedKey) await writeCredential(credentialKey, submittedKey);

      let saved;
      try {
        saved = await repository.saveAiServiceModel({
          connectionId: normalizedConnectionId,
          name,
          baseUrl,
          model,
          resolvedModel: verification.resolvedModel,
          makeActive:
            input.makeActive === true || currentSettings.activeModelId === null,
        });
      } catch (error) {
        if (submittedKey) {
          await restoreCredential(credentialKey, previousCredential);
        }
        throw error;
      }

      return {
        verification: {
          ok: true,
          connectionId: normalizedConnectionId,
          modelId: saved.model.id,
          baseUrl,
          requestedModel: verification.requestedModel,
          resolvedModel: verification.resolvedModel,
          latencyMs: verification.latencyMs,
          verifiedAt: saved.model.verifiedAt,
        },
        settings: await settings(),
        backup: saved.backup,
      };
    },

    async updateConnection(connectionId, input = {}) {
      const normalizedConnectionId = validateEntityId(
        connectionId,
        "connectionId",
      );
      const existingService = repository.getAiService(normalizedConnectionId);
      if (!existingService) {
        const error = new Error("未找到要更新的 AI 服务连接。");
        error.name = "NotFoundError";
        error.statusCode = 404;
        error.code = "NOT_FOUND";
        throw error;
      }

      const previousBaseUrl = validateBaseUrl(existingService.baseUrl);
      const baseUrl = validateBaseUrl(input.baseUrl ?? previousBaseUrl);
      if (baseUrl !== previousBaseUrl || input.apiKey !== undefined) {
        throw validationError(
          "Base URL 或 API Key 必须通过模型验证后保存。",
          baseUrl !== previousBaseUrl ? "baseUrl" : "apiKey",
        );
      }
      const name = validateServiceName(input.name, baseUrl);
      const saved = await repository.updateAiServiceMetadata({
        connectionId: normalizedConnectionId,
        name,
      });
      return { settings: await settings(), backup: saved.backup };
    },

    async setActiveModel(modelId) {
      const normalizedModelId = validateEntityId(modelId, "modelId");
      const model = repository.getAiModel(normalizedModelId);
      if (!model || !(await credentialExists(model.service.credentialKey))) {
        throw new AiServiceError("AI_NOT_CONFIGURED");
      }
      const saved = await repository.setActiveAiModel(normalizedModelId);
      return { settings: await settings(), backup: saved.backup };
    },

    async deleteModel(modelId) {
      const normalizedModelId = validateEntityId(modelId, "modelId");
      const deleted = await repository.deleteAiModel(normalizedModelId);
      return reconcileActiveModel(deleted.backup);
    },

    async deleteConnection(connectionId) {
      const normalizedConnectionId = validateEntityId(
        connectionId,
        "connectionId",
      );
      const service = repository.getAiService(normalizedConnectionId);
      if (!service) {
        const error = new Error("未找到该 AI 服务连接。");
        error.name = "NotFoundError";
        error.statusCode = 404;
        error.code = "NOT_FOUND";
        throw error;
      }
      const previousCredential = await readCredential(service.credentialKey);
      await deleteCredential(service.credentialKey);
      let deleted;
      try {
        deleted = await repository.deleteAiService(normalizedConnectionId);
      } catch (error) {
        await restoreCredential(service.credentialKey, previousCredential);
        throw error;
      }
      return reconcileActiveModel(deleted.backup);
    },

    async generateText({ input, modelId, webSearch = false } = {}) {
      if (typeof input !== "string" || !input.trim()) {
        throw validationError("AI 输入不能为空。", "input");
      }
      let selected;
      if (modelId) {
        selected = repository.getAiModel(validateEntityId(modelId, "modelId"));
      } else {
        const activeModelId = (await settings()).activeModelId;
        selected = activeModelId
          ? repository.getAiModel(activeModelId)
          : null;
      }
      if (!selected) throw new AiServiceError("AI_NOT_CONFIGURED");
      const apiKey = await readCredential(selected.service.credentialKey);
      if (!apiKey) throw new AiServiceError("AI_NOT_CONFIGURED");
      return compatibleProvider.generateText({
        apiKey,
        model: selected.model,
        baseUrl: selected.service.baseUrl,
        input: input.trim(),
        webSearch: webSearch === true,
      });
    },
  };
}
