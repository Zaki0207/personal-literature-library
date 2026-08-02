import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  MacOsKeychainCredentialStore,
  MemoryCredentialStore,
} from "../scripts/ai/credential-store.mjs";
import { createAiService } from "../scripts/ai/ai-service.mjs";
import { createLibraryApi } from "../scripts/library-api.mjs";

async function makeAiFixture(t, name, { aiFetch, credentialStore } = {}) {
  const directory = await mkdtemp(join(tmpdir(), `library-ai-${name}-`));
  const dbPath = join(directory, "database", "library.sqlite3");
  const backupDir = join(directory, "backups");
  const seedPath = join(directory, "seed.json");
  await writeFile(
    seedPath,
    JSON.stringify({ categoryRecords: [], papers: [] }),
    "utf8",
  );
  const resolvedCredentialStore =
    credentialStore ?? new MemoryCredentialStore();
  const api = await createLibraryApi({
    port: 0,
    dbPath,
    backupDir,
    seedPath,
    credentialStore: resolvedCredentialStore,
    ...(aiFetch ? { aiFetch } : {}),
  });
  const address = await api.listen();
  t.after(async () => {
    await api.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    api,
    baseUrl: address.url,
    credentialStore: resolvedCredentialStore,
    dbPath,
  };
}

async function jsonRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  return { response, body: await response.json() };
}

function responsesSuccess(model) {
  return new Response(
    JSON.stringify({
      status: "completed",
      model,
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "OK" }],
        },
      ],
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function chatSuccess(model) {
  return new Response(
    JSON.stringify({
      model,
      choices: [{ message: { role: "assistant", content: "OK" } }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

test("服务连接共享钥匙串密钥，并可添加和切换多个模型", async (t) => {
  const calls = [];
  const aiFetch = async (url, init) => {
    const requestUrl = String(url);
    const body = JSON.parse(init.body);
    calls.push({ url: requestUrl, init, body });
    if (requestUrl.startsWith("https://api.deepseek.com/") && requestUrl.endsWith("/responses")) {
      return new Response("not found", { status: 404 });
    }
    return requestUrl.endsWith("/chat/completions")
      ? chatSuccess(body.model)
      : responsesSuccess(`${body.model}-resolved`);
  };
  const fixture = await makeAiFixture(t, "connections-and-models", {
    aiFetch,
  });

  const initial = await jsonRequest(fixture.baseUrl, "/api/ai/settings");
  assert.equal(initial.response.status, 200);
  assert.deepEqual(initial.body, { connections: [], activeModelId: null });

  const relaySecret = "sk-test-relay-never-store";
  const relayBaseUrl = "https://gateway.example/v1";
  const relay = await jsonRequest(fixture.baseUrl, "/api/ai/connections", {
    method: "POST",
    body: JSON.stringify({
      name: "研究网关",
      baseUrl: relayBaseUrl,
      model: "gpt-custom",
      apiKey: relaySecret,
    }),
  });
  assert.equal(relay.response.status, 200);
  assert.equal(relay.body.settings.connections.length, 1);
  const relayConnection = relay.body.settings.connections[0];
  const firstRelayModel = relayConnection.models[0];
  assert.equal(relayConnection.name, "研究网关");
  assert.equal(relayConnection.baseUrl, relayBaseUrl);
  assert.equal(relayConnection.configured, true);
  assert.equal(relay.body.settings.activeModelId, firstRelayModel.id);
  assert.equal(JSON.stringify(relay.body).includes(relaySecret), false);
  assert.equal(
    await fixture.credentialStore.get(relayConnection.id),
    relaySecret,
  );
  assert.equal(calls[0].url, `${relayBaseUrl}/responses`);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${relaySecret}`);

  const secondModel = await jsonRequest(
    fixture.baseUrl,
    `/api/ai/connections/${relayConnection.id}/models/verify`,
    {
      method: "POST",
      body: JSON.stringify({
        name: "研究网关",
        baseUrl: relayBaseUrl,
        model: "gpt-second",
      }),
    },
  );
  assert.equal(secondModel.response.status, 200);
  assert.equal(secondModel.body.settings.connections[0].models.length, 2);
  assert.equal(secondModel.body.settings.activeModelId, firstRelayModel.id);
  assert.equal(fixture.credentialStore.values.size, 1);
  const secondRelayModel = secondModel.body.settings.connections[0].models.find(
    (model) => model.model === "gpt-second",
  );
  assert.ok(secondRelayModel);

  const callsBeforeDuplicate = calls.length;
  const duplicateModel = await jsonRequest(
    fixture.baseUrl,
    `/api/ai/connections/${relayConnection.id}/models/verify`,
    {
      method: "POST",
      body: JSON.stringify({
        name: "研究网关",
        baseUrl: relayBaseUrl,
        model: "gpt-second",
      }),
    },
  );
  assert.equal(duplicateModel.response.status, 409);
  assert.equal(duplicateModel.body.error.code, "CONFLICT");
  assert.equal(duplicateModel.body.error.details.field, "model");
  assert.equal(calls.length, callsBeforeDuplicate);

  const reverifiedModel = await jsonRequest(
    fixture.baseUrl,
    `/api/ai/connections/${relayConnection.id}/models/verify`,
    {
      method: "POST",
      body: JSON.stringify({
        name: "研究网关",
        baseUrl: relayBaseUrl,
        model: "gpt-second",
        reverify: true,
      }),
    },
  );
  assert.equal(reverifiedModel.response.status, 200);
  assert.equal(reverifiedModel.body.settings.connections[0].models.length, 2);
  assert.equal(calls.length, callsBeforeDuplicate + 1);

  const deepSeekSecret = "ds-test-never-store";
  const deepSeek = await jsonRequest(fixture.baseUrl, "/api/ai/connections", {
    method: "POST",
    body: JSON.stringify({
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-custom",
      apiKey: deepSeekSecret,
    }),
  });
  assert.equal(deepSeek.response.status, 200);
  const deepSeekConnection = deepSeek.body.settings.connections.find(
    (connection) => connection.name === "DeepSeek",
  );
  assert.ok(deepSeekConnection);
  const deepSeekModel = deepSeekConnection.models[0];
  assert.equal(
    calls.some(
      (call) =>
        call.url === "https://api.deepseek.com/chat/completions" &&
        call.body.model === "deepseek-custom",
    ),
    true,
  );

  const activated = await jsonRequest(
    fixture.baseUrl,
    `/api/ai/models/${deepSeekModel.id}/active`,
    { method: "PUT" },
  );
  assert.equal(activated.response.status, 200);
  assert.equal(activated.body.settings.activeModelId, deepSeekModel.id);

  const database = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try {
    const services = database.prepare("SELECT * FROM ai_services").all();
    const models = database.prepare("SELECT * FROM ai_models").all();
    assert.equal(services.length, 2);
    assert.equal(models.length, 3);
    assert.equal(JSON.stringify(services).includes(relaySecret), false);
    assert.equal(JSON.stringify(models).includes(relaySecret), false);
    assert.equal(
      services.find((service) => service.id === relayConnection.id).base_url,
      relayBaseUrl,
    );
  } finally {
    database.close();
  }
  const databaseBytes = await readFile(fixture.dbPath);
  assert.equal(databaseBytes.includes(Buffer.from(relaySecret)), false);
  assert.equal(databaseBytes.includes(Buffer.from(deepSeekSecret)), false);

  const removedModel = await jsonRequest(
    fixture.baseUrl,
    `/api/ai/models/${secondRelayModel.id}`,
    { method: "DELETE" },
  );
  assert.equal(removedModel.response.status, 200);
  assert.equal(
    removedModel.body.settings.connections.find(
      (connection) => connection.id === relayConnection.id,
    ).models.length,
    1,
  );

  const removed = await jsonRequest(
    fixture.baseUrl,
    `/api/ai/connections/${relayConnection.id}`,
    { method: "DELETE" },
  );
  assert.equal(removed.response.status, 200);
  assert.equal(await fixture.credentialStore.has(relayConnection.id), false);
  assert.equal(
    removed.body.settings.connections.some(
      (connection) => connection.id === relayConnection.id,
    ),
    false,
  );
});

test("OpenAI 兼容地址不支持 Responses 时自动回退到 Chat Completions", async (t) => {
  const calls = [];
  const fixture = await makeAiFixture(t, "openai-chat-fallback", {
    aiFetch: async (url, init) => {
      const requestUrl = String(url);
      calls.push(requestUrl);
      if (requestUrl.endsWith("/responses")) {
        return new Response("not found", { status: 404 });
      }
      return chatSuccess(JSON.parse(init.body).model);
    },
  });

  const first = await jsonRequest(fixture.baseUrl, "/api/ai/connections", {
    method: "POST",
    body: JSON.stringify({
      name: "兼容网关",
      model: "relay-model",
      baseUrl: "https://relay.example/v1",
      apiKey: "sk-relay-test",
    }),
  });
  assert.equal(first.response.status, 200);
  const connectionId = first.body.verification.connectionId;
  assert.deepEqual(calls, [
    "https://relay.example/v1/responses",
    "https://relay.example/v1/chat/completions",
  ]);

  const second = await jsonRequest(
    fixture.baseUrl,
    `/api/ai/connections/${connectionId}/models/verify`,
    {
      method: "POST",
      body: JSON.stringify({
        name: "兼容网关",
        model: "relay-model-2",
        baseUrl: "https://relay.example/v1",
      }),
    },
  );
  assert.equal(second.response.status, 200);
  assert.equal(calls.at(-1), "https://relay.example/v1/chat/completions");
  assert.equal(calls.length, 3);
});

test("Responses 返回接口不支持时仍可用 Chat Completions 验证 DeepSeek V4", async (t) => {
  const calls = [];
  const fixture = await makeAiFixture(t, "deepseek-invalid-responses", {
    aiFetch: async (url, init) => {
      const requestUrl = String(url);
      calls.push(requestUrl);
      if (requestUrl.endsWith("/responses")) {
        return new Response(
          JSON.stringify({
            error: {
              code: "invalid_request_error",
              message: "Unsupported endpoint",
            },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      return chatSuccess(JSON.parse(init.body).model);
    },
  });

  const result = await jsonRequest(fixture.baseUrl, "/api/ai/connections", {
    method: "POST",
    body: JSON.stringify({
      name: "DeepSeek",
      model: "deepseek-v4-pro",
      baseUrl: "https://api.deepseek.com",
      apiKey: "ds-v4-test",
    }),
  });

  assert.equal(result.response.status, 200);
  assert.equal(result.body.verification.requestedModel, "deepseek-v4-pro");
  assert.deepEqual(calls, [
    "https://api.deepseek.com/responses",
    "https://api.deepseek.com/chat/completions",
  ]);
});

test("Base URL 仅允许安全地址，修改发送目标必须重新输入密钥", async (t) => {
  const calls = [];
  const fixture = await makeAiFixture(t, "base-url-security", {
    aiFetch: async (url) => {
      calls.push(String(url));
      return responsesSuccess("gpt-safe");
    },
  });

  for (const baseUrl of [
    "http://gateway.example/v1",
    "https://user:password@gateway.example/v1",
    "https://gateway.example/v1?token=unsafe",
  ]) {
    const invalid = await jsonRequest(fixture.baseUrl, "/api/ai/connections", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-safe",
        baseUrl,
        apiKey: "sk-never-send-invalid-target",
      }),
    });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.body.error.code, "VALIDATION_ERROR");
    assert.equal(invalid.body.error.details.field, "baseUrl");
  }
  assert.equal(calls.length, 0);

  const configured = await jsonRequest(
    fixture.baseUrl,
    "/api/ai/connections",
    {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-safe",
        baseUrl: "https://first.example/v1/",
        apiKey: "sk-safe-target",
      }),
    },
  );
  assert.equal(configured.response.status, 200);
  const connectionId = configured.body.verification.connectionId;
  assert.equal(calls[0], "https://first.example/v1/responses");

  const retargetedWithoutKey = await jsonRequest(
    fixture.baseUrl,
    `/api/ai/connections/${connectionId}/models/verify`,
    {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-safe",
        baseUrl: "https://second.example/v1",
      }),
    },
  );
  assert.equal(retargetedWithoutKey.response.status, 400);
  assert.match(retargetedWithoutKey.body.error.message, /重新输入 API Key/);
  assert.equal(calls.length, 1);

  const retargeted = await jsonRequest(
    fixture.baseUrl,
    `/api/ai/connections/${connectionId}/models/verify`,
    {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-new-target",
        baseUrl: "https://second.example/v1",
        apiKey: "sk-second-target",
      }),
    },
  );
  assert.equal(retargeted.response.status, 200);
  const updatedConnection = retargeted.body.settings.connections[0];
  assert.equal(updatedConnection.id, connectionId);
  assert.equal(updatedConnection.baseUrl, "https://second.example/v1");
  assert.deepEqual(
    updatedConnection.models.map((model) => model.model),
    ["gpt-new-target"],
  );
  assert.equal(calls[1], "https://second.example/v1/responses");
});

test("Base URL 结尾斜杠不同不会被误判为发送目标变更", async (t) => {
  const calls = [];
  const fixture = await makeAiFixture(t, "equivalent-base-url", {
    aiFetch: async (url, init) => {
      calls.push(String(url));
      return responsesSuccess(JSON.parse(init.body).model);
    },
  });

  const configured = await jsonRequest(
    fixture.baseUrl,
    "/api/ai/connections",
    {
      method: "POST",
      body: JSON.stringify({
        model: "root-model",
        baseUrl: "https://gateway.example/",
        apiKey: "sk-root-target",
      }),
    },
  );
  assert.equal(configured.response.status, 200);
  const connectionId = configured.body.verification.connectionId;

  const addedModel = await jsonRequest(
    fixture.baseUrl,
    `/api/ai/connections/${connectionId}/models/verify`,
    {
      method: "POST",
      body: JSON.stringify({
        model: "root-model-2",
        baseUrl: "https://gateway.example",
      }),
    },
  );

  assert.equal(addedModel.response.status, 200);
  assert.equal(addedModel.body.settings.connections[0].models.length, 2);
  assert.deepEqual(calls, [
    "https://gateway.example/responses",
    "https://gateway.example/responses",
  ]);
});

test("既有服务商配置迁移为服务连接和模型，且继续复用钥匙串账户", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "library-ai-migrate-services-"));
  const dbPath = join(directory, "database", "library.sqlite3");
  const seedPath = join(directory, "seed.json");
  await mkdir(join(directory, "database"), { recursive: true });
  await writeFile(
    seedPath,
    JSON.stringify({ categoryRecords: [], papers: [] }),
    "utf8",
  );
  const database = new DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE ai_connections (
      provider TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      resolved_model TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 0,
      verified_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO ai_connections (
      provider, model, resolved_model, active,
      verified_at, created_at, updated_at
    ) VALUES (
      'openai', 'gpt-existing', 'gpt-existing', 1,
      '2026-08-01T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z'
    );
  `);
  database.close();

  const credentialStore = new MemoryCredentialStore({
    openai: "sk-existing-keychain-secret",
  });
  const api = await createLibraryApi({
    port: 0,
    dbPath,
    backupDir: join(directory, "backups"),
    seedPath,
    credentialStore,
  });
  const address = await api.listen();
  t.after(async () => {
    await api.close();
    await rm(directory, { recursive: true, force: true });
  });

  const migrated = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const service = migrated
      .prepare("SELECT * FROM ai_services WHERE id = 'openai'")
      .get();
    const model = migrated
      .prepare("SELECT * FROM ai_models WHERE service_id = 'openai'")
      .get();
    assert.equal(service.name, "OpenAI");
    assert.equal(service.base_url, "https://api.openai.com/v1");
    assert.equal(service.credential_key, "openai");
    assert.equal(model.model, "gpt-existing");
    assert.equal(model.active, 1);
  } finally {
    migrated.close();
  }

  const settings = await jsonRequest(address.url, "/api/ai/settings");
  assert.equal(settings.body.connections[0].configured, true);
  assert.equal(settings.body.connections[0].models[0].model, "gpt-existing");
  assert.equal(
    settings.body.activeModelId,
    settings.body.connections[0].models[0].id,
  );
});

test("服务商原始错误会被归一化且失败配置不会写入", async (t) => {
  const rawMessage = "raw upstream secret diagnostic";
  const fixture = await makeAiFixture(t, "errors", {
    aiFetch: async () =>
      new Response(
        JSON.stringify({
          error: { code: "insufficient_balance", message: rawMessage },
        }),
        { status: 402, headers: { "Content-Type": "application/json" } },
      ),
  });

  const result = await jsonRequest(fixture.baseUrl, "/api/ai/connections", {
    method: "POST",
    body: JSON.stringify({
      name: "失败服务",
      baseUrl: "https://failed.example/v1",
      model: "failed-model",
      apiKey: "sk-invalid-balance",
    }),
  });
  assert.equal(result.response.status, 402);
  assert.equal(result.body.error.code, "QUOTA_EXCEEDED");
  assert.equal(JSON.stringify(result.body).includes(rawMessage), false);
  assert.equal(fixture.credentialStore.values.size, 0);
  assert.equal(fixture.api.repository.getAiServices().length, 0);
});

test("当前模型不可用时自动回退到最近验证的可用模型", async (t) => {
  const calls = [];
  const fixture = await makeAiFixture(t, "active-model-fallback", {
    aiFetch: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url: String(url), model: body.model });
      return responsesSuccess(body.model);
    },
  });

  const first = await jsonRequest(fixture.baseUrl, "/api/ai/connections", {
    method: "POST",
    body: JSON.stringify({
      name: "可用服务",
      baseUrl: "https://available.example/v1",
      model: "available-active",
      apiKey: "key-available",
    }),
  });
  const availableConnectionId = first.body.verification.connectionId;
  const activeModelId = first.body.verification.modelId;
  const second = await jsonRequest(
    fixture.baseUrl,
    `/api/ai/connections/${availableConnectionId}/models/verify`,
    {
      method: "POST",
      body: JSON.stringify({
        name: "可用服务",
        baseUrl: "https://available.example/v1",
        model: "available-fallback",
      }),
    },
  );
  const fallbackModel = second.body.settings.connections[0].models.find(
    (model) => model.model === "available-fallback",
  );

  const missing = await jsonRequest(fixture.baseUrl, "/api/ai/connections", {
    method: "POST",
    body: JSON.stringify({
      name: "密钥缺失服务",
      baseUrl: "https://missing.example/v1",
      model: "missing-newest",
      apiKey: "key-will-be-removed",
    }),
  });
  await fixture.credentialStore.delete(missing.body.verification.connectionId);
  const database = new DatabaseSync(fixture.dbPath);
  try {
    database
      .prepare("UPDATE ai_models SET verified_at = ? WHERE model = ?")
      .run("2099-01-01T00:00:00.000Z", "missing-newest");
  } finally {
    database.close();
  }

  const deleted = await jsonRequest(
    fixture.baseUrl,
    `/api/ai/models/${activeModelId}`,
    { method: "DELETE" },
  );
  assert.equal(deleted.response.status, 200);
  assert.equal(deleted.body.settings.activeModelId, fallbackModel.id);
  assert.equal(
    deleted.body.settings.connections
      .flatMap((connection) => connection.models)
      .find((model) => model.id === fallbackModel.id).active,
    true,
  );
  const persisted = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try {
    assert.equal(
      persisted.prepare("SELECT id FROM ai_models WHERE active = 1").get().id,
      fallbackModel.id,
    );
  } finally {
    persisted.close();
  }

  await fixture.api.aiService.generateText({ input: "fallback-check" });
  assert.equal(calls.at(-1).model, "available-fallback");
});

test("连接名称可独立保存，地址和密钥仍必须通过模型验证", async (t) => {
  const calls = [];
  const fixture = await makeAiFixture(t, "connection-metadata", {
    aiFetch: async (url, init) => {
      calls.push(String(url));
      return responsesSuccess(JSON.parse(init.body).model);
    },
  });
  const configured = await jsonRequest(
    fixture.baseUrl,
    "/api/ai/connections",
    {
      method: "POST",
      body: JSON.stringify({
        name: "原名称",
        baseUrl: "https://metadata.example/v1",
        model: "metadata-model",
        apiKey: "key-metadata",
      }),
    },
  );
  const connectionId = configured.body.verification.connectionId;
  const callCount = calls.length;

  const renamed = await jsonRequest(
    fixture.baseUrl,
    `/api/ai/connections/${connectionId}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        name: "新名称",
        baseUrl: "https://metadata.example/v1/",
      }),
    },
  );
  assert.equal(renamed.response.status, 200);
  assert.equal(renamed.body.settings.connections[0].name, "新名称");
  assert.equal(calls.length, callCount);

  const unsafeRetarget = await jsonRequest(
    fixture.baseUrl,
    `/api/ai/connections/${connectionId}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        name: "不应保存",
        baseUrl: "https://other.example/v1",
      }),
    },
  );
  assert.equal(unsafeRetarget.response.status, 400);
  assert.equal(unsafeRetarget.body.error.details.field, "baseUrl");
  assert.equal(
    fixture.api.repository.getAiService(connectionId).name,
    "新名称",
  );
});

test("AI 配置接口只允许当前本地网站来源", async (t) => {
  const fixture = await makeAiFixture(t, "origin-restriction");

  const allowed = await jsonRequest(fixture.baseUrl, "/api/ai/settings", {
    headers: { Origin: "http://localhost:3000" },
  });
  assert.equal(allowed.response.status, 200);
  assert.equal(
    allowed.response.headers.get("access-control-allow-origin"),
    "http://localhost:3000",
  );

  const rejected = await jsonRequest(fixture.baseUrl, "/api/ai/settings", {
    headers: { Origin: "http://localhost:6553" },
  });
  assert.equal(rejected.response.status, 403);
  assert.equal(rejected.body.error.code, "ORIGIN_NOT_ALLOWED");
  assert.equal(
    rejected.response.headers.get("access-control-allow-origin"),
    null,
  );
});

test("数据库写入失败时恢复原钥匙串状态", async () => {
  const provider = {
    async verify({ model }) {
      return {
        requestedModel: model,
        resolvedModel: model,
        latencyMs: 1,
      };
    },
  };
  const providers = new Map([["openai", provider]]);
  const newCredentials = new MemoryCredentialStore();
  const createFailureRepository = {
    getAiServices: () => [],
    getAiService: () => null,
    async saveAiServiceModel() {
      throw new Error("database-create-failed");
    },
  };
  const createFailureService = createAiService({
    repository: createFailureRepository,
    credentialStore: newCredentials,
    providers,
  });
  await assert.rejects(
    createFailureService.verifyAndSave(null, {
      name: "失败服务",
      baseUrl: "https://rollback.example/v1",
      model: "rollback-model",
      apiKey: "new-key",
    }),
    /database-create-failed/,
  );
  assert.equal(newCredentials.values.size, 0);

  const existingService = {
    id: "existing-service",
    name: "既有服务",
    baseUrl: "https://existing.example/v1",
    credentialKey: "existing-service",
    models: [],
  };
  const existingCredentials = new MemoryCredentialStore({
    "existing-service": "old-key",
  });
  const updateFailureRepository = {
    getAiServices: () => [existingService],
    getAiService: () => existingService,
    async saveAiServiceModel() {
      throw new Error("database-update-failed");
    },
    async deleteAiService() {
      throw new Error("database-delete-failed");
    },
  };
  const updateFailureService = createAiService({
    repository: updateFailureRepository,
    credentialStore: existingCredentials,
    providers,
  });
  await assert.rejects(
    updateFailureService.verifyAndSave("existing-service", {
      name: "既有服务",
      baseUrl: "https://existing.example/v1",
      model: "replacement-model",
      apiKey: "replacement-key",
    }),
    /database-update-failed/,
  );
  assert.equal(
    await existingCredentials.get("existing-service"),
    "old-key",
  );

  await assert.rejects(
    updateFailureService.deleteConnection("existing-service"),
    /database-delete-failed/,
  );
  assert.equal(
    await existingCredentials.get("existing-service"),
    "old-key",
  );
});

test("钥匙串辅助程序通过 stdin 接收密钥，不放入进程参数", async () => {
  let captured;
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    const input = [];
    child.stdin.on("data", (chunk) => input.push(chunk));
    child.stdin.on("finish", () => {
      captured = {
        command,
        args: [...args],
        options,
        stdin: Buffer.concat(input).toString("utf8"),
      };
      queueMicrotask(() => child.emit("close", 0));
    });
    return child;
  };
  const store = new MacOsKeychainCredentialStore({
    platform: "darwin",
    spawnImpl,
    serviceName: "test.personal-literature-library.ai",
    helperBinaryPath: "/tmp/fake-keychain-helper",
    compileHelper: false,
  });
  const secret = "secret-never-in-argv";

  await store.set("openai", secret);

  assert.equal(captured.command, "/tmp/fake-keychain-helper");
  assert.equal(captured.options.shell, false);
  assert.deepEqual(captured.args, [
    "set",
    "test.personal-literature-library.ai",
    "openai",
  ]);
  assert.equal(captured.args.includes(secret), false);
  assert.equal(captured.stdin, secret);
});
