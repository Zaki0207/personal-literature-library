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
  const webSearchReplies = [];
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
    const reply = JSON.stringify({ papers });
    webSearchReplies.push(reply);
    return aiResponse(body.model, reply);
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
  assert.match(firstRun.body.settings.promptTemplate, /SIGGRAPH/u);
  assert.match(firstRun.body.settings.promptTemplate, /CVPR/u);
  assert.match(firstRun.body.settings.promptTemplate, /IEEE TPAMI/u);
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

  const firstTrace = await jsonRequest(baseUrl, "/api/radar/ai-trace");
  assert.equal(firstTrace.response.status, 200);
  assert.equal(firstTrace.body.trace.status, "completed");
  assert.equal(firstTrace.body.trace.requestedCount, 2);
  assert.equal(firstTrace.body.trace.exchanges.length, 2);
  assert.equal(
    firstTrace.body.trace.exchanges[0].prompt,
    webSearchBodies[0].input,
  );
  assert.equal(
    firstTrace.body.trace.exchanges[0].response,
    webSearchReplies[0],
  );
  assert.match(firstTrace.body.trace.exchanges[0].prompt, /Existing Paper/u);
  assert.match(firstTrace.body.trace.exchanges[0].prompt, /SIGGRAPH/u);

  const invalidTemplate = await jsonRequest(
    baseUrl,
    "/api/radar/prompt-template",
    {
      method: "PUT",
      body: JSON.stringify({
        promptTemplate: "只有 {{research_scope}}，缺少其他变量",
      }),
    },
  );
  assert.equal(invalidTemplate.response.status, 400);
  assert.match(invalidTemplate.body.error.message, /exclusions_json/u);

  const defaultTemplate = await jsonRequest(
    baseUrl,
    "/api/radar/prompt-template/default",
  );
  assert.equal(defaultTemplate.response.status, 200);
  assert.match(defaultTemplate.body.promptTemplate, /SIGGRAPH Asia/u);

  const customTemplate = [
    "研究范围={{research_scope}}",
    "第{{round}}轮；返回{{requested_count}}篇。",
    "排除={{exclusions_json}}",
    '只输出 {"papers":[]} 结构。',
  ].join("\n");
  const savedTemplate = await jsonRequest(
    baseUrl,
    "/api/radar/prompt-template",
    {
      method: "PUT",
      body: JSON.stringify({ promptTemplate: customTemplate }),
    },
  );
  assert.equal(savedTemplate.response.status, 200);
  assert.equal(savedTemplate.body.settings.promptTemplate, customTemplate);

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
  assert.match(webSearchBodies[2].input, /研究范围=检索测试方向的论文/u);
  assert.match(webSearchBodies[2].input, /第1轮；返回2篇/u);
  assert.match(webSearchBodies[2].input, /New Paper A/u);
  assert.doesNotMatch(webSearchBodies[2].input, /\{\{research_scope\}\}/u);

  const paperB = secondRun.body.pending.find((item) => item.title === "New Paper B");
  const unreviewedAdd = await jsonRequest(
    baseUrl,
    `/api/radar/items/${paperB.id}/add`,
    { method: "POST", body: "{}" },
  );
  assert.equal(unreviewedAdd.response.status, 400);
  assert.match(unreviewedAdd.body.error.message, /(title|标题)/u);

  const added = await jsonRequest(
    baseUrl,
    `/api/radar/items/${paperB.id}/add`,
    {
      method: "POST",
      body: JSON.stringify({
        title: "New Paper B — Manually Reviewed",
        zhTitle: "人工修改后的中文标题",
        authors: paperB.authors,
        institution: "Reviewed Lab",
        source: paperB.source,
        date: paperB.date,
        aiSummary: "人工修改后的摘要",
        originalUrl: paperB.originalUrl,
        identifiers: paperB.identifiers,
      }),
    },
  );
  assert.equal(added.response.status, 201);
  assert.equal(added.body.paper.title, "New Paper B — Manually Reviewed");
  assert.equal(added.body.paper.zhTitle, "人工修改后的中文标题");
  assert.equal(added.body.paper.institution, "Reviewed Lab");
  assert.equal(added.body.library.papers.length, 2);
  assert.equal(added.body.radar.counts.added, 1);
  assert.equal(added.body.radar.counts.discarded, 1);

  const state = await jsonRequest(baseUrl, "/api/radar");
  assert.equal(state.response.status, 200);
  assert.equal(state.body.settings.prompt, "检索测试方向的论文");
  assert.equal(state.body.settings.promptTemplate, customTemplate);
  assert.equal(state.body.counts.library, 2);
  assert.equal(state.body.pending.some((item) => item.title === "New Paper B"), false);
});

test("DeepSeek V4 Flash 通过 Responses API 执行联网检索", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "literature-radar-deepseek-"));
  const seedPath = join(directory, "seed.json");
  await writeFile(
    seedPath,
    JSON.stringify({ categoryRecords: [], papers: [] }),
    "utf8",
  );
  const calls = [];
  let radarAttempts = 0;
  const aiFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    if (body.tools && radarAttempts++ === 0) {
      return aiResponse(
        "deepseek-v4-flash",
        "检索已完成，但本次响应不是合法 JSON：{'papers': []}",
      );
    }
    return aiResponse(
      "deepseek-v4-flash",
      body.tools
        ? `检索结果如下：${JSON.stringify({
            papers: [
              paper({
                title: "DeepSeek Radar Paper",
                doi: "10.1000/deepseek-radar",
              }),
            ],
          })}\n核查记录：{"verified":true}`
        : "OK",
    );
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
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      apiKey: "ds-test-only",
    }),
  });
  assert.equal(configured.response.status, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/responses$/u);

  const radar = await jsonRequest(baseUrl, "/api/radar/run", {
    method: "POST",
    body: JSON.stringify({ prompt: "检索测试方向论文", count: 1 }),
  });
  assert.equal(radar.response.status, 200);
  assert.equal(radar.body.pending.length, 1);
  assert.equal(radar.body.pending[0].title, "DeepSeek Radar Paper");
  assert.equal(radar.body.lastRun.rounds, 2);
  assert.equal(radar.body.lastRun.invalidResponses, 1);
  assert.equal(calls.length, 3);
  assert.match(calls[1].url, /\/responses$/u);
  assert.deepEqual(calls[1].body.tools, [{ type: "web_search" }]);
  assert.equal(calls[1].body.tool_choice, "required");
  assert.deepEqual(calls[2].body.tools, [{ type: "web_search" }]);

  const trace = await jsonRequest(baseUrl, "/api/radar/ai-trace");
  assert.equal(trace.response.status, 200);
  assert.equal(trace.body.trace.status, "completed");
  assert.equal(trace.body.trace.exchanges.length, 2);
  assert.equal(
    trace.body.trace.exchanges[0].response,
    "检索已完成，但本次响应不是合法 JSON：{'papers': []}",
  );
  assert.match(trace.body.trace.exchanges[0].errorMessage, /格式无效/u);
  assert.match(trace.body.trace.exchanges[1].response, /DeepSeek Radar Paper/u);
});
