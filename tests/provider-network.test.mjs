import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  DeepSeekProvider,
  OpenAiProvider,
  createProxyAwareFetch,
} from "../scripts/ai/providers.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("AI 请求在存在 HTTP 代理时自动经由代理发送", async (t) => {
  let receivedTarget = "";
  const proxy = createServer((request, response) => {
    receivedTarget = request.url ?? "";
    response.writeHead(200, {
      "Connection": "close",
      "Content-Type": "application/json",
    });
    response.end(JSON.stringify({ ok: true }));
  });
  proxy.on("connect", (request, socket, head) => {
    receivedTarget = request.url ?? "";
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const reply = () => {
      const body = JSON.stringify({ ok: true });
      socket.end(
        `HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      );
    };
    if (head.length > 0) reply();
    else socket.once("data", reply);
  });
  const address = await listen(proxy);
  t.after(() => close(proxy));

  const proxyFetch = createProxyAwareFetch({
    http_proxy: `http://127.0.0.1:${address.port}`,
  });
  const response = await proxyFetch("http://ai-provider.test/verify");

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.match(
    receivedTarget,
    /^(?:http:\/\/)?ai-provider\.test(?::80)?(?:\/verify)?$/,
  );
});

test("没有兼容代理时保持使用 Node 原生 fetch", () => {
  assert.equal(createProxyAwareFetch({}), globalThis.fetch);
  assert.equal(
    createProxyAwareFetch({ all_proxy: "socks5://127.0.0.1:1080" }),
    globalThis.fetch,
  );
});

test("所有 AI 请求统一使用二十分钟超时", async () => {
  const openAiProvider = new OpenAiProvider();
  let openAiRequest;
  openAiProvider.requestStream = async (_url, request) => {
    openAiRequest = request;
    return {
      payload: {
        status: "completed",
        model: request.body.model,
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "OK" }],
          },
        ],
      },
      latencyMs: 1,
    };
  };
  await openAiProvider.generateText({
    apiKey: "test",
    model: "gpt-5.6-sol",
    input: "test",
    reasoningEffort: "xhigh",
    timeoutMs: 3 * 60_000,
  });
  assert.equal(openAiRequest.timeoutMs, 20 * 60_000);

  await openAiProvider.generateText({
    apiKey: "test",
    model: "gpt-5.6-sol",
    input: "test",
    reasoningEffort: "high",
    timeoutMs: 30 * 60_000,
  });
  assert.equal(openAiRequest.timeoutMs, 20 * 60_000);

  await openAiProvider.generateText({
    apiKey: "test",
    model: "gpt-5.6-sol",
    input: "test",
  });
  assert.equal(openAiRequest.timeoutMs, 20 * 60_000);

  const deepSeekProvider = new DeepSeekProvider();
  let deepSeekRequest;
  deepSeekProvider.request = async (_url, request) => {
    deepSeekRequest = request;
    return {
      payload: {
        model: request.body.model,
        choices: [{ message: { content: "OK" } }],
      },
      latencyMs: 1,
    };
  };
  await deepSeekProvider.generateText({
    apiKey: "test",
    model: "deepseek-v4-pro",
    input: "test",
    reasoningEffort: "max",
  });
  assert.equal(deepSeekRequest.timeoutMs, 20 * 60_000);
});

test("OpenAI 联网检索使用流式 Responses 并提取最终结果", async () => {
  let receivedUrl = "";
  let receivedInit;
  const encoder = new TextEncoder();
  const finalResponse = {
    id: "resp_stream_test",
    status: "completed",
    model: "gpt-stream-resolved",
    output: [
      {
        type: "web_search_call", status: "completed",
        action: { type: "search", sources: [{ type: "url", url: "https://papers.example/paper" }] },
      },
      {
        type: "message",
        status: "completed",
        content: [{
          type: "output_text", text: "检索完成",
          annotations: [{ type: "url_citation", url: "https://papers.example/paper", title: "论文原文" }],
        }],
      },
    ],
    usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
  };
  const provider = new OpenAiProvider({
    fetchImpl: async (url, init) => {
      receivedUrl = String(url);
      receivedInit = init;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'event: response.created\r\ndata: {"type":"response.created","response":{"status":"in_progress"}}\r\n\r\n',
            ),
          );
          controller.enqueue(
            encoder.encode(
              `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: finalResponse })}\n\n`,
            ),
          );
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "x-request-id": "req_stream_test",
        },
      });
    },
  });

  const result = await provider.generateText({
    apiKey: "test-key",
    model: "gpt-stream",
    baseUrl: "https://gateway.example/v1",
    input: "查找论文",
    webSearch: true,
    reasoningEffort: "xhigh",
  });

  assert.equal(receivedUrl, "https://gateway.example/v1/responses");
  assert.equal(receivedInit.headers.Accept, "text/event-stream");
  assert.deepEqual(JSON.parse(receivedInit.body), {
    model: "gpt-stream",
    input: "查找论文",
    store: false,
    reasoning: { effort: "xhigh" },
    tools: [{ type: "web_search" }],
    tool_choice: "auto",
    include: ["web_search_call.action.sources"],
    stream: true,
  });
  assert.equal(result.text, "检索完成");
  assert.equal(result.resolvedModel, "gpt-stream-resolved");
  assert.equal(result.requestId, "req_stream_test");
  assert.equal(result.webSearchUsed, true);
  assert.deepEqual(result.webSources, [{ url: "https://papers.example/paper", title: "论文原文" }]);
});

function completedPayload() {
  return {
    status: "completed", model: "test-model",
    output: [{ type: "message", content: [{ type: "output_text", text: "检索完成" }] }],
  };
}

function jsonResponse(payload = completedPayload(), status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function eventResponse(event) {
  return new Response("data: " + JSON.stringify(event) + "\n\n", { headers: { "Content-Type": "text/event-stream" } });
}

const requestInput = { apiKey: "test-key", model: "test-model", baseUrl: "https://gateway.example/v1", input: "查找论文", webSearch: true };

test("参数错误和不存在的 Responses 接口均不会触发 Chat Completions 或污染后续请求", async () => {
  for (const status of [400, 404, 405, 415]) {
    const calls = [];
    const provider = new OpenAiProvider({ retryDelayMs: 0, fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return calls.length === 1 ? jsonResponse({ error: { code: "invalid_request_error" } }, status) : jsonResponse();
    } });
    await assert.rejects(provider.generateText({ ...requestInput, webSearch: false }));
    assert.equal(calls.length, 1);
    const next = await provider.generateText(requestInput);
    assert.equal(next.text, "检索完成");
    assert.equal(next.protocol, "responses");
    assert.equal(next.webSearchUsed, false, "请求联网不代表服务实际执行过检索");
    assert.ok(calls.every((call) => call.url.endsWith("/responses") && call.body.stream === true));
  }
});

test("Responses 的暂时 503 和 502 会原样重试并恢复，不切换接口或模型", async () => {
  const calls = [];
  const provider = new OpenAiProvider({ retryDelayMs: 0, fetchImpl: async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    if (calls.length < 3) return jsonResponse({ error: { code: "server_error" } }, calls.length === 1 ? 503 : 502);
    return jsonResponse();
  } });
  const result = await provider.generateText(requestInput);
  assert.equal(result.text, "检索完成");
  assert.equal(result.attempts, 3);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls, [calls[0], calls[0], calls[0]]);
  assert.equal(calls[0].url, "https://gateway.example/v1/responses");
});

test("持续故障最多重试两次，错误显示 Responses 和 HTTP 状态且不泄露原始正文", async () => {
  let calls = 0;
  const secret = "sk-do-not-expose";
  const provider = new OpenAiProvider({ retryDelayMs: 0, fetchImpl: async () => {
    calls += 1;
    return jsonResponse({ error: { code: "server_error", message: secret } }, 503);
  } });
  await assert.rejects(provider.generateText(requestInput), (error) => {
    assert.equal(error.code, "PROVIDER_UNAVAILABLE");
    assert.equal(error.details.protocol, "Responses");
    assert.equal(error.details.httpStatus, 503);
    assert.equal(error.details.attempts, 3);
    assert.match(error.message, /Responses.*503.*2/u);
    assert.equal(JSON.stringify(error).includes(secret), false);
    return true;
  });
  assert.equal(calls, 3);
});

test("认证、余额错误和长时间 Retry-After 不会立即重试", async () => {
  for (const [status, code, headers] of [
    [401, "invalid_api_key", {}], [403, "access_denied", {}],
    [402, "insufficient_quota", {}], [429, "insufficient_quota", {}],
    [429, "rate_limit_exceeded", { "Retry-After": "120" }],
  ]) {
    let calls = 0;
    const provider = new OpenAiProvider({ retryDelayMs: 0, fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ error: { code } }, status, headers);
    } });
    await assert.rejects(provider.generateText(requestInput));
    assert.equal(calls, 1);
  }
});

test("Responses 流式 error 和 response.failed 事件会被识别并按故障类型重试", async () => {
  for (const type of ["error", "response.failed"]) {
    let calls = 0;
    const provider = new OpenAiProvider({ retryDelayMs: 0, fetchImpl: async () => {
      calls += 1;
      if (calls > 1) return eventResponse({ type: "response.completed", response: completedPayload() });
      return eventResponse(type === "error"
        ? { type, code: "server_error", message: "private upstream body" }
        : { type, response: { status: "failed", error: { code: "server_error" } } });
    } });
    assert.equal((await provider.generateText(requestInput)).text, "检索完成");
    assert.equal(calls, 2);
  }
});

test("没有完成事件的部分输出不能伪装成成功", async () => {
  const provider = new OpenAiProvider({ maxRetries: 0, fetchImpl: async () => eventResponse({
    type: "response.output_text.delta", delta: "部分结果",
  }) });
  await assert.rejects(provider.generateText(requestInput), { code: "STREAM_INTERRUPTED" });
});

test("JSON 和 SSE 中的未完成结果不会被当作完整答案", async () => {
  for (const response of [
    () => jsonResponse({ status: "incomplete" }),
    () => eventResponse({ type: "response.incomplete", response: { status: "incomplete" } }),
  ]) {
    let calls = 0;
    const provider = new OpenAiProvider({ retryDelayMs: 0, fetchImpl: async () => { calls += 1; return response(); } });
    await assert.rejects(provider.generateText(requestInput), { code: "RESPONSE_INCOMPLETE" });
    assert.equal(calls, 1);
  }
});

test("收到完成事件后立即返回并关闭流，不等待网关断开连接", async () => {
  let cancelled = false;
  const provider = new OpenAiProvider({ fetchImpl: async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: " + JSON.stringify({ type: "response.completed", response: completedPayload() }) + "\n\n"));
      // Deliberately leave the connection open after completion.
    },
    cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "text/event-stream" } }) });
  const result = await provider.requestStream("https://gateway.example/v1/responses", {
    provider: "openai", apiKey: "test-key", body: {}, timeoutMs: 500,
  });
  assert.equal(result.payload.status, "completed");
  assert.equal(cancelled, true);
});

test("原生 DeepSeek 不会尝试执行不支持的联网请求", async () => {
  let calls = 0;
  const provider = new DeepSeekProvider({ fetchImpl: async () => { calls += 1; return jsonResponse(); } });
  await assert.rejects(provider.generateText({ ...requestInput, model: "deepseek-v4-pro" }), { code: "WEB_SEARCH_UNSUPPORTED" });
  assert.equal(calls, 0);
});
