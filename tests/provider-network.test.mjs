import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createProxyAwareFetch } from "../scripts/ai/providers.mjs";

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
