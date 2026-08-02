import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryCredentialStore } from "../scripts/ai/credential-store.mjs";
import { createLibraryApi } from "../scripts/library-api.mjs";

function aiResponse(model, text) {
  return new Response(
    JSON.stringify({
      status: "completed",
      model,
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text }],
        },
      ],
      usage: { input_tokens: 20, output_tokens: 40, total_tokens: 60 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function paper({ title, doi, summary = "论文摘要" }) {
  return {
    title,
    zhTitle: `${title} 中文题目`,
    authors: "Test Author",
    institution: "Test Lab",
    source: "Test Conference",
    date: "2026",
    aiSummary: summary,
    recommendationReason: "与研究范围直接相关。",
    originalUrl: `https://doi.org/${doi}`,
    identifiers: [{ kind: "doi", value: doi }],
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

test("文献雷达把知识库和已丢弃论文作为永久排重源", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "literature-radar-"));
  const seedPath = join(directory, "seed.json");
  await writeFile(
    seedPath,
    JSON.stringify({ categoryRecords: [], papers: [] }),
    "utf8",
  );

  const webSearchBodies = [];
  let radarCall = 0;
  const radarResponses = [
    [
      paper({ title: "Existing Paper", doi: "10.1000/existing" }),
      paper({ title: "New Paper A", doi: "10.1000/new-a" }),
    ],
    [paper({ title: "New Paper B", doi: "10.1000/new-b" })],
    [paper({ title: "New Paper A", doi: "10.1000/new-a" })],
    [paper({ title: "New Paper C", doi: "10.1000/new-c" })],
  ];
  const aiFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (!body.tools) return aiResponse(`${body.model}-resolved`, "OK");
    webSearchBodies.push(body);
    const papers = radarResponses[radarCall++] ?? [];
    return aiResponse(body.model, JSON.stringify({ papers }));
  };

  const api = await createLibraryApi({
    port: 0,
    dbPath: join(directory, "library.sqlite3"),
    backupDir: join(directory, "backups"),
    seedPath,
    credentialStore: new MemoryCredentialStore(),
    aiFetch,
  });
  const { url: baseUrl } = await api.listen();
  t.after(async () => {
    await api.close();
    await rm(directory, { recursive: true, force: true });
  });

  const configured = await jsonRequest(baseUrl, "/api/ai/connections", {
    method: "POST",
    body: JSON.stringify({
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-test",
      apiKey: "sk-test-only",
    }),
  });
  assert.equal(configured.response.status, 200);

  const existing = await jsonRequest(baseUrl, "/api/papers", {
    method: "POST",
    body: JSON.stringify({
      title: "Existing Paper",
      originalUrl: "https://doi.org/10.1000/existing",
      identifiers: [{ kind: "doi", value: "10.1000/existing" }],
    }),
  });
  assert.equal(existing.response.status, 201);

  const firstRun = await jsonRequest(baseUrl, "/api/radar/run", {
    method: "POST",
    body: JSON.stringify({ prompt: "检索测试方向的论文", count: 2 }),
  });
  assert.equal(firstRun.response.status, 200);
  assert.equal(firstRun.body.pending.length, 2);
  assert.deepEqual(
    firstRun.body.pending.map((item) => item.title).sort(),
    ["New Paper A", "New Paper B"],
  );
  assert.equal(firstRun.body.lastRun.excludedLibrary, 1);
  assert.equal(firstRun.body.lastRun.added, 2);
  assert.equal(firstRun.body.lastRun.insufficient, false);
  assert.equal(webSearchBodies.length, 2);
  assert.deepEqual(webSearchBodies[0].tools, [{ type: "web_search" }]);
  assert.equal(webSearchBodies[0].tool_choice, "required");
  assert.match(webSearchBodies[0].input, /Existing Paper/u);

  const paperA = firstRun.body.pending.find((item) => item.title === "New Paper A");
  const discarded = await jsonRequest(
    baseUrl,
    `/api/radar/items/${paperA.id}/discard`,
    { method: "POST", body: "{}" },
  );
  assert.equal(discarded.response.status, 200);
  assert.equal(discarded.body.discarded[0].title, "New Paper A");

  const secondRun = await jsonRequest(baseUrl, "/api/radar/run", {
    method: "POST",
    body: JSON.stringify({ prompt: "检索测试方向的论文", count: 1 }),
  });
  assert.equal(secondRun.response.status, 200);
  assert.equal(secondRun.body.lastRun.excludedHistory, 1);
  assert.equal(secondRun.body.pending.some((item) => item.title === "New Paper A"), false);
  assert.equal(secondRun.body.pending.some((item) => item.title === "New Paper C"), true);

  const paperB = secondRun.body.pending.find((item) => item.title === "New Paper B");
  const added = await jsonRequest(
    baseUrl,
    `/api/radar/items/${paperB.id}/add`,
    { method: "POST", body: "{}" },
  );
  assert.equal(added.response.status, 201);
  assert.equal(added.body.paper.title, "New Paper B");
  assert.equal(added.body.library.papers.length, 2);
  assert.equal(added.body.radar.counts.added, 1);
  assert.equal(added.body.radar.counts.discarded, 1);

  const state = await jsonRequest(baseUrl, "/api/radar");
  assert.equal(state.response.status, 200);
  assert.equal(state.body.settings.prompt, "检索测试方向的论文");
  assert.equal(state.body.counts.library, 2);
  assert.equal(state.body.pending.some((item) => item.title === "New Paper B"), false);
});
