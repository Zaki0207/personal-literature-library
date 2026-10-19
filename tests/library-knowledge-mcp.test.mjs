import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";
import {
  createLibraryMcpClient,
  createLibraryMcpServer,
  resolveLibraryConnection,
} from "../scripts/library-mcp.mjs";
import { handleKnowledgeRoutes } from "../scripts/library-api-routes/knowledge.mjs";
import { errorPayload, sendJson } from "../scripts/library-api-http.mjs";

async function fixture(t, { allowNotes = true } = {}) {
  const token = "local-runtime-token-not-an-ai-key";
  const data = {
    papers: [{ id: "p1", title: "Smoke Reconstruction", aiSummary: "应用已有总结", note: "private-marker", categoryIds: [], identifiers: [], updatedAt: "2026-10-11T12:00:00Z", apiKey: "secret-ai-provider-key" }],
    categories: [],
    connections: [{ apiKey: "secret-ai-provider-key" }],
  };
  let reads = 0;
  const requests = [];
  const repository = {
    getLibrary() { reads += 1; return data; },
    updatePaper() { throw new Error("knowledge route wrote data"); },
    createPaper() { throw new Error("knowledge route wrote data"); },
  };
  const server = createServer(async (request, response) => {
    requests.push({ method: request.method, pathname: new URL(request.url, "http://localhost").pathname });
    if (request.headers.authorization !== `Bearer ${token}`) {
      sendJson(response, request, 401, { error: { message: `authorization contained ${request.headers.authorization}` } });
      return;
    }
    try {
      const pathname = new URL(request.url, "http://localhost").pathname;
      if (!(await handleKnowledgeRoutes({ request, response, pathname, repository, allowKnowledgeNotes: allowNotes }))) sendJson(response, request, 404, {});
    } catch (error) { sendJson(response, request, error.statusCode ?? 500, errorPayload(error)); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  const directory = await mkdtemp(join(tmpdir(), "library-knowledge-"));
  const runtimePath = join(directory, "runtime.json");
  await writeFile(runtimePath, JSON.stringify({ apiUrl, token, pid: process.pid, version: 1 }), { mode: 0o600 });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(directory, { recursive: true, force: true });
  });
  return { data, apiUrl, token, runtimePath, requests, readCount: () => reads };
}

test("MCP follows runtime discovery and reads fresh API records without credentials or paid AI calls", async (t) => {
  const f = await fixture(t);
  const client = createLibraryMcpClient({ env: {}, runtimePath: f.runtimePath });
  const first = await client.callTool("search_papers", { query: "Smoke" });
  assert.equal(first.results[0].id, "p1");
  f.data.papers[0].title = "Updated Research";
  f.data.papers[0].updatedAt = "2026-10-12T00:01:00Z";
  const second = await client.callTool("search_papers", { query: "Updated" });
  assert.equal(second.results[0].title, "Updated Research");
  assert.notEqual(first.revision, second.revision);
  const paper = await client.callTool("get_paper", { id: "p1" });
  assert.equal(paper.paper.note, "private-marker");
  for (const value of [first, second, paper]) {
    assert.equal(JSON.stringify(value).includes(f.token), false);
    assert.equal(JSON.stringify(value).includes("secret-ai-provider-key"), false);
  }
  assert.equal(f.readCount(), 3);
  assert.ok(f.requests.every((request) => request.method === "GET" && request.pathname.startsWith("/api/knowledge/")));
});

test("knowledge HTTP routes reject writes, unknown/duplicate inputs and support pagination and notes scope", async (t) => {
  const f = await fixture(t, { allowNotes: false });
  f.data.papers.push({ ...f.data.papers[0], id: "p2" });
  const headers = { Authorization: `Bearer ${f.token}` };
  const result = await fetch(`${f.apiUrl}/api/knowledge/search?q=Smoke&limit=1`, { headers }).then((r) => r.json());
  assert.equal(result.results.length, 1);
  assert.equal(result.pagination.nextOffset, 1);
  const second = await fetch(`${f.apiUrl}/api/knowledge/search?q=Smoke&limit=1&offset=1`, { headers }).then((r) => r.json());
  assert.equal(second.results[0].id, "p2");
  const note = await fetch(`${f.apiUrl}/api/knowledge/search?q=private-marker&includeNotes=true`, { headers }).then((r) => r.json());
  assert.equal(note.results.length, 0);
  assert.equal(note.scope.personalNotes, false);
  const paper = await fetch(`${f.apiUrl}/api/knowledge/papers/p1?includeNotes=true`, { headers }).then((r) => r.json());
  assert.equal(Object.hasOwn(paper.paper, "note"), false);
  const beforeWrites = f.readCount();
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
    const response = await fetch(`${f.apiUrl}/api/knowledge/papers/p1`, { method, headers });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET");
  }
  assert.equal(f.readCount(), beforeWrites);
  for (const query of ["q=Smoke&q=Updated", "limit=51", "includeNotes=maybe", "sql=SELECT"]) {
    const response = await fetch(`${f.apiUrl}/api/knowledge/search?${query}`, { headers });
    assert.equal(response.status, 400);
  }
});

test("MCP connection restrictions, global notes scope and errors never echo connection secrets", async (t) => {
  const f = await fixture(t);
  const client = createLibraryMcpClient({ env: { LIBRARY_MCP_INCLUDE_NOTES: "false" }, runtimePath: f.runtimePath });
  assert.equal((await client.callTool("search_papers", { query: "private-marker", includeNotes: true })).results.length, 0);
  assert.equal(Object.hasOwn((await client.callTool("get_paper", { id: "p1", includeNotes: true })).paper, "note"), false);
  for (const apiUrl of ["https://example.com", "http://127.0.0.1:4317/anything", "http://secret@127.0.0.1:4317", "http://127.0.0.1:4317?token=secret"]) {
    await assert.rejects(resolveLibraryConnection({ env: { LIBRARY_API_URL: apiUrl } }), { code: "LIBRARY_CONNECTION_INVALID" });
  }
  const wrongKeyClient = createLibraryMcpClient({ env: { LIBRARY_API_URL: f.apiUrl, LIBRARY_MCP_TOKEN: "incorrect-sensitive-token" } });
  await assert.rejects(wrongKeyClient.callTool("get_library_overview"), (error) => {
    assert.equal(error.code, "LIBRARY_CONNECTION_UNAUTHORIZED");
    assert.equal(error.message.includes("incorrect-sensitive-token"), false);
    return true;
  });
  const disconnected = createLibraryMcpClient({ env: { LIBRARY_API_URL: "http://127.0.0.1:1" }, timeoutMs: 100 });
  await assert.rejects(disconnected.callTool("get_library_overview"), { code: "LIBRARY_SERVICE_UNAVAILABLE" });
  await chmod(f.runtimePath, 0o644);
  await assert.rejects(resolveLibraryConnection({ env: {}, runtimePath: f.runtimePath }), { code: "LIBRARY_RUNTIME_INVALID" });
});

test("JSON-RPC MCP negotiates versions, initializes and returns structured results and execution errors", async () => {
  const server = createLibraryMcpServer({ client: { callTool: async () => ({ scope: { readOnly: true }, results: [] }) } });
  assert.equal((await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })).error.code, -32002);
  const init = await server.handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2026-01-01", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const list = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ["get_library_overview", "search_papers", "get_paper"]);
  assert.ok(list.result.tools.every((tool) => tool.annotations.readOnlyHint && !tool.annotations.openWorldHint));
  const result = await server.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "search_papers", arguments: { query: "Smoke" } } });
  assert.equal(result.result.structuredContent.scope.readOnly, true);
  assert.equal(result.result.isError, false);
  assert.equal((await server.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "delete_paper" } })).error.code, -32602);
  assert.equal((await server.handle({ jsonrpc: "2.0", id: 6, method: "unknown" })).error.code, -32601);
  assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/unknown" }), null);
});

test("STDIO executable emits only newline-delimited MCP JSON and exits after stdin closes", async (t) => {
  const f = await fixture(t);
  const child = spawn(process.execPath, [resolve("scripts/library-mcp.mjs")], {
    env: { ...process.env, LIBRARY_API_URL: f.apiUrl, LIBRARY_MCP_TOKEN: f.token },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  let outputCount = 0;
  lines.on("line", (line) => {
    outputCount += 1;
    const message = JSON.parse(line);
    assert.equal(message.jsonrpc, "2.0");
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  function request(id, method, params) {
    const response = new Promise((done) => pending.set(id, done));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }
  const initialized = await request(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(initialized.result.protocolVersion, "2024-11-05");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const listed = await request(2, "tools/list");
  assert.equal(listed.result.tools.length, 3);
  const result = await request(3, "tools/call", { name: "search_papers", arguments: { query: "Smoke" } });
  assert.equal(JSON.parse(result.result.content[0].text).results[0].id, "p1");
  assert.equal(Object.hasOwn(result.result, "structuredContent"), false);
  assert.equal(JSON.stringify(result).includes(f.token), false);
  const error = await request(4, "tools/call", { name: "get_paper", arguments: { id: "missing" } });
  assert.equal(error.result.isError, true);
  child.stdin.end();
  const [exitCode] = await once(child, "exit");
  assert.equal(exitCode, 0);
  assert.equal(stderr, "");
  assert.equal(outputCount, 4);
});
