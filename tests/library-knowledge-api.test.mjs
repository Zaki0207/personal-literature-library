import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLibraryApi } from "../scripts/library-api.mjs";
import { createLibraryMcpClient } from "../scripts/library-mcp.mjs";

test("real knowledge API requires desktop token, enforces notes scope and leaves database/backup untouched", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "library-knowledge-api-"));
  const backupDir = join(directory, "backups");
  const token = "desktop-test-authorization-token";
  let aiCalls = 0;
  const api = await createLibraryApi({
    port: 0,
    dbPath: join(directory, "library.sqlite3"),
    backupDir,
    seedPath: null,
    requestToken: token,
    allowKnowledgeNotes: false,
    aiFetch: async () => { aiCalls += 1; throw new Error("knowledge must not invoke AI"); },
  });
  const { url } = await api.listen();
  t.after(async () => { await api.close(); await rm(directory, { recursive: true, force: true }); });
  const { paper } = await api.repository.createPaper({
    title: "Known Synthetic Paper",
    zhTitle: "已知测试文献",
    authors: "Synthetic Author",
    institution: "Synthetic Institution",
    source: "CVPR",
    date: "2024",
    categoryIds: [],
    aiSummary: "合成元数据，不涉及付费检索。",
    note: "private-scope-marker",
    favorite: false,
    watchLater: false,
    hasPdf: false,
  });
  const before = api.repository.getLibrary();
  const backupBefore = await readdir(backupDir);
  for (const headers of [{}, { Authorization: "Bearer wrong-authorization-token" }]) {
    const response = await fetch(`${url}/api/knowledge/overview`, { headers });
    assert.equal(response.status, 401);
    const body = await response.text();
    assert.equal(body.includes(token), false);
    assert.equal(body.includes("wrong-authorization-token"), false);
  }
  const client = createLibraryMcpClient({ env: { LIBRARY_API_URL: url, LIBRARY_MCP_TOKEN: token } });
  const overview = await client.callTool("get_library_overview");
  assert.equal(overview.counts.papers, 1);
  assert.equal(overview.scope.personalNotes, false);
  const search = await client.callTool("search_papers", { query: "Known", includeNotes: true });
  assert.equal(search.results[0].id, paper.id);
  const noteSearch = await client.callTool("search_papers", { query: "private-scope-marker", includeNotes: true });
  assert.equal(noteSearch.results.length, 0);
  const record = await client.callTool("get_paper", { id: paper.id, includeNotes: true });
  assert.equal(Object.hasOwn(record.paper, "note"), false);
  assert.equal(JSON.stringify(record).includes("private-scope-marker"), false);
  assert.deepEqual(api.repository.getLibrary(), before);
  assert.deepEqual(await readdir(backupDir), backupBefore);
  assert.equal(aiCalls, 0);
  await api.repository.updatePaper(paper.id, { title: "Freshly Updated Paper" });
  const fresh = await client.callTool("search_papers", { query: "Freshly" });
  assert.equal(fresh.results[0].id, paper.id);
  assert.equal(fresh.results[0].title, "Freshly Updated Paper");
});
