import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createLibraryRepository } from "../scripts/library-repository.mjs";
import { createLibraryApi } from "../scripts/library-api.mjs";
import { createPaperIntakeService } from "../scripts/paper-intake.mjs";
import { createAiService } from "../scripts/ai/ai-service.mjs";
import { MemoryCredentialStore } from "../scripts/ai/credential-store.mjs";
import { createAiProviders } from "../scripts/ai/providers.mjs";
import { readPaperSources, PaperSourceError } from "../scripts/paper-source-reader.mjs";
import { PAPER_INTAKE_RESPONSE_FORMAT } from "../scripts/paper-intake-schema.mjs";
import {
  DEFAULT_PAPER_INTAKE_PROMPT_TEMPLATE,
  MAX_PAPER_INTAKE_PROMPT_LENGTH,
} from "../scripts/paper-intake-prompt.mjs";

const PAPER_URL = "https://papers.example/smoke";
const SOURCE_FIELDS = ["title", "authors", "institution", "source", "date", "aiSummary", "originalUrl", "pdfUrl", "codeUrl", "projectUrl", "identifiers"];

function researchResult(paperPatch = {}) {
  return {
    status: "ready",
    matchReason: "标题、作者和项目主页一致。",
    warnings: [],
    paper: {
      title: "A Test Paper",
      zhTitle: "烟雾体重建",
      authors: "Alice Researcher; Bob Researcher",
      institution: "Tsinghua University, Department of Computer Science and Technology",
      source: "2025 IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)",
      date: "2025-06-12",
      aiSummary: "本文研究烟雾体的三维重建，结合物理约束恢复体积结构。",
      categoryIds: ["SMOKE001", "UNKNOWN", "SMOKE001"],
      originalUrl: PAPER_URL,
      pdfUrl: "https://papers.example/smoke.pdf",
      codeUrl: "https://github.com/example/smoke",
      projectUrl: "https://project.example/smoke",
      publicationStatus: "published",
      identifiers: [{ kind: "doi", value: "10.1145/1234.5678" }, { kind: "arxiv", value: "2501.12345v2" }],
      ...paperPatch,
    },
    sources: [{ title: "论文原文", url: PAPER_URL, fields: [...SOURCE_FIELDS] }],
  };
}

async function makeFixture(t, { result = researchResult(), generateText, webSearchUsed = true, webSources, getResearchCapabilities, sourceReader } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "paper-research-"));
  const seedPath = join(directory, "seed.json");
  await writeFile(seedPath, JSON.stringify({
    categoryRecords: [
      { id: "ROOT0001", name: "计算机视觉", parentId: null, sortOrder: 0 },
      { id: "SMOKE001", name: "烟雾重建", parentId: "ROOT0001", sortOrder: 1 },
    ],
    papers: [],
  }));
  const repository = await createLibraryRepository({
    dbPath: join(directory, "library.sqlite3"),
    backupDir: join(directory, "backups"),
    seedPath,
  });
  t.after(async () => {
    await repository.close();
    await rm(directory, { recursive: true, force: true });
  });
  const requests = [];
  const aiService = {
    ...(getResearchCapabilities ? { getResearchCapabilities } : {}),
    async generateText(request) {
      requests.push(request);
      if (generateText) return generateText(request);
      return {
        text: typeof result === "string" ? result : JSON.stringify(result),
        resolvedModel: "research-model",
        webSearchUsed,
        webSources: webSources ?? [{ url: PAPER_URL, title: "联网工具返回的论文标题" }],
      };
    },
  };
  return { repository, requests, aiService, directory, seedPath, service: createPaperIntakeService({ repository, aiService, ...(sourceReader ? { sourceReader } : {}) }) };
}

test("DeepSeek 使用预读项目页和结构化单次请求，固定模型并只记录真正读取来源", async (t) => {
  const reference = "https://jna-358.github.io/gaussians_on_fire/";
  const evidence = {
    pages: [{ url: reference, title: "Gaussians on Fire", text: "Gaussians on Fire: High-Frequency Reconstruction of Flames", links: [{ url: "https://arxiv.org/abs/2511.22459", title: "Paper" }] }],
    warnings: ["关联页读取失败。"],
  };
  let readCount = 0;
  const fixture = await makeFixture(t, {
    getResearchCapabilities: async (options) => { assert.deepEqual(options, { modelId: "chosen-model" }); return { mode: "linked_pages", modelId: "chosen-model" }; },
    sourceReader: async (value) => { assert.equal(value, reference); readCount += 1; return evidence; },
    result: researchResult({ title: evidence.pages[0].text }),
    webSearchUsed: false,
  });
  const custom = "我的自定义填写偏好：作者使用分号。";
  await fixture.service.savePromptTemplate(custom);
  const result = await fixture.service.analyze({ reference, modelId: "chosen-model" });
  assert.equal(result.status, "ready");
  assert.equal(readCount, 1);
  assert.equal(fixture.requests.length, 1);
  const request = fixture.requests[0];
  assert.equal(request.modelId, "chosen-model");
  assert.equal(request.webSearch, false);
  assert.match(request.instructions, /没有可调用的联网工具/u);
  assert.equal(request.responseFormat, PAPER_INTAKE_RESPONSE_FORMAT);
  assert.equal(request.input.startsWith(custom), true);
  assert.equal(request.input.includes(DEFAULT_PAPER_INTAKE_PROMPT_TEMPLATE), false);
  assert.equal(request.input.endsWith(JSON.stringify(evidence)), true);
  assert.deepEqual(result.metadata.sources, [{ url: reference, title: "Gaussians on Fire" }]);
  assert.equal(result.metadata.metadataSource, "AI 公开页面整理");
  assert.match(result.metadata.warnings.join(" "), /关联页读取失败.*未进行全网检索/u);
  assert.equal(fixture.repository.getLibrary().papers.length, 0);
});

test("DeepSeek 纯题目或来源失败在付费请求之前停止且不写库", async (t) => {
  for (const code of ["PAPER_SOURCE_REQUIRED", "PAPER_SOURCE_UNAVAILABLE"]) {
    const fixture = await makeFixture(t, {
      getResearchCapabilities: async () => ({ mode: "linked_pages", modelId: "snapshot" }),
      sourceReader: code === "PAPER_SOURCE_REQUIRED" ? readPaperSources : async () => { throw new PaperSourceError("来源读取失败", code); },
    });
    await assert.rejects(fixture.service.analyze({ reference: "只有论文题目" }), { code });
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.repository.getLibrary().papers.length, 0);
  }
});

test("DeepSeek 预读后非 ready 状态保留来源，不能强制转成可添加论文", async (t) => {
  const fixture = await makeFixture(t, {
    getResearchCapabilities: async () => ({ mode: "linked_pages", modelId: "snapshot" }),
    sourceReader: async () => ({ pages: [{ url: PAPER_URL, title: "多个候选", text: "A / B", links: [] }], warnings: [] }),
    result: { status: "needs_clarification", message: "请确认哪篇论文", sources: [{ url: "https://unread.example", title: "未读取" }] },
  });
  const result = await fixture.service.analyze({ reference: PAPER_URL });
  assert.equal(result.status, "needs_clarification");
  assert.deepEqual(result.sources, [{ url: PAPER_URL, title: "多个候选" }]);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].modelId, "snapshot");
  assert.equal(fixture.repository.getLibrary().papers.length, 0);
});

test("格式失败只暴露有界最终答复诊断，不包含输入或自动重试", async (t) => {
  for (const output of ["", '<script>alert("x")</script>', `BEGIN-${"a".repeat(5_000)}-END`]) {
    const fixture = await makeFixture(t, { result: output });
    await assert.rejects(fixture.service.analyze({ reference: "私有用户线索不应出现在诊断" }), (error) => {
      const diagnostic = error.details.intakeDiagnostic;
      assert.deepEqual(Object.keys(error.details), ["intakeDiagnostic"]);
      assert.deepEqual(Object.keys(diagnostic).sort(), ["model", "outputLength", "outputPreview", "reason", "truncated"]);
      assert.equal(diagnostic.outputLength, output.length);
      assert.equal(diagnostic.truncated, output.length > 4_000);
      assert.equal(diagnostic.model, "research-model");
      assert.ok(diagnostic.outputPreview.length < 4_100);
      assert.equal(diagnostic.outputPreview.includes("私有用户线索"), false);
      if (output.length > 4_000) {
        assert.equal(diagnostic.outputPreview.startsWith("BEGIN-"), true);
        assert.equal(diagnostic.outputPreview.endsWith("-END"), true);
      } else assert.equal(diagnostic.outputPreview, output);
      return true;
    });
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.repository.getLibrary().papers.length, 0);
  }
});

test("真实 AiService 识别官方 DeepSeek 并把预读来源作为单次 Responses JSON schema 请求", async (t) => {
  const fixture = await makeFixture(t);
  const requests = [];
  const result = researchResult();
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url: String(url), body });
    return Response.json({ status: "completed", model: "deepseek-flash", output: [{
      type: "message", role: "assistant", content: [{ type: "output_text", text: body.text ? JSON.stringify(result) : "OK" }],
    }] });
  };
  const aiService = createAiService({ repository: fixture.repository, credentialStore: new MemoryCredentialStore(), providers: createAiProviders({ fetchImpl }) });
  await aiService.verifyAndSave(null, { baseUrl: "https://api.deepseek.com", apiKey: "fixture-only", model: "deepseek-flash" });
  const service = createPaperIntakeService({ repository: fixture.repository, aiService, sourceReader: async () => ({
    pages: [{ url: PAPER_URL, title: result.paper.title, text: "Actual public page evidence", links: [] }], warnings: [],
  }) });
  const ready = await service.analyze({ reference: PAPER_URL });
  assert.equal(ready.status, "ready");
  assert.equal(requests.length, 2); // Credential verification plus one analysis.
  assert.equal(requests[1].url, "https://api.deepseek.com/responses");
  assert.equal(requests[1].body.tools, undefined);
  assert.equal(requests[1].body.include, undefined);
  assert.deepEqual(requests[1].body.text.format, PAPER_INTAKE_RESPONSE_FORMAT);
  assert.match(requests[1].body.instructions, /应用已代你读取/u);
  assert.match(requests[1].body.input, /Actual public page evidence/u);
  assert.equal(fixture.repository.getLibrary().papers.length, 0);
});

test("HTTP 错误返回最终答复诊断，分析失败只调用一次且不写库", async (t) => {
  const fixture = await makeFixture(t, { result: "模型只给出一段说明" });
  const api = await createLibraryApi({ repository: fixture.repository, aiService: fixture.aiService, port: 0 });
  const address = await api.listen();
  t.after(() => api.close());
  const response = await fetch(`${address.url}/api/paper-intake/analyze`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reference: PAPER_URL }),
  });
  assert.equal(response.status, 502);
  const { error } = await response.json();
  assert.equal(error.code, "INVALID_AI_RESULT");
  assert.equal(error.details.intakeDiagnostic.outputPreview, "模型只给出一段说明");
  assert.equal(error.details.intakeDiagnostic.model, "research-model");
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.repository.getLibrary().papers.length, 0);
});

test("默认添加论文提示词完整可读，与原有模板一致且不调用 AI", async (t) => {
  const fixture = await makeFixture(t, {
    generateText: async () => { throw new Error("查看提示词不应调用 AI"); },
  });
  const original = (await readFile(new URL("../scripts/prompts/paper-intake.txt", import.meta.url), "utf8")).trim();
  assert.deepEqual(fixture.service.getPromptTemplate(), {
    promptTemplate: original,
    defaultPromptTemplate: original,
    usingDefault: true,
  });
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.repository.getLibrary().papers.length, 0);
});

test("完整自定义提示词发送给 AI，保留用户线索和分类数据及原有查重行为", async (t) => {
  const fixture = await makeFixture(t);
  const custom = "  我的自定义研究任务\n优先核对官方项目页，并使用原有 JSON 输出结构。\n  ";
  const saved = await fixture.service.savePromptTemplate(custom);
  assert.equal(saved.promptTemplate, custom);
  assert.equal(saved.usingDefault, false);
  assert.equal(saved.backup.ok, true);
  assert.equal(fixture.requests.length, 0);

  const ready = await fixture.service.analyze({ reference: "我的论文线索", modelId: "chosen-model" });
  assert.equal(ready.status, "ready");
  assert.equal(ready.draft.title, researchResult().paper.title);
  assert.equal(fixture.requests[0].input, [
    custom, "", "用户线索（JSON 字符串）：", JSON.stringify("我的论文线索"), "", "现有分类：",
    JSON.stringify([
      { id: "ROOT0001", path: "计算机视觉" },
      { id: "SMOKE001", path: "计算机视觉 › 烟雾重建" },
    ]),
  ].join("\n"));
  assert.equal(fixture.requests[0].input.includes(DEFAULT_PAPER_INTAKE_PROMPT_TEMPLATE), false);
  assert.equal(fixture.requests[0].webSearch, true);
  assert.equal(fixture.requests[0].modelId, "chosen-model");
  await fixture.repository.createPaper(ready.draft);
  assert.equal((await fixture.service.analyze({ reference: "再次寻找同一篇论文" })).status, "duplicate");
  assert.equal(fixture.requests[1].input.startsWith(custom), true);
});

test("提示词通过 SQLite 写入队列保存并在重启后恢复，恢复默认不固化旧模板", async (t) => {
  const fixture = await makeFixture(t);
  const first = "第一份自定义提示词";
  const last = "最后保存的自定义提示词";
  const writes = await Promise.all([
    fixture.service.savePromptTemplate(first),
    fixture.service.savePromptTemplate(last),
  ]);
  assert.equal(writes.every((result) => result.backup.ok), true);
  assert.equal(fixture.service.getPromptTemplate().promptTemplate, last);
  const options = {
    dbPath: fixture.repository.dbPath,
    backupDir: fixture.repository.backupDir,
    seedPath: fixture.seedPath,
  };
  await fixture.repository.close();
  const reopened = await createLibraryRepository(options);
  t.after(() => reopened.close());
  const service = createPaperIntakeService({ repository: reopened, aiService: fixture.aiService });
  assert.deepEqual(service.getPromptTemplate(), {
    promptTemplate: last,
    defaultPromptTemplate: DEFAULT_PAPER_INTAKE_PROMPT_TEMPLATE,
    usingDefault: false,
  });
  const reset = await service.resetPromptTemplate();
  assert.equal(reset.usingDefault, true);
  assert.equal(reset.promptTemplate, DEFAULT_PAPER_INTAKE_PROMPT_TEMPLATE);
  assert.equal(reset.backup.ok, true);
  assert.equal(reopened.db.prepare("SELECT prompt_template AS value FROM paper_intake_settings WHERE id = 'default'").get().value, "");
  await reopened.close();
  const afterReset = await createLibraryRepository(options);
  t.after(() => afterReset.close());
  assert.equal(afterReset.getPaperIntakePromptTemplate().usingDefault, true);
  assert.equal(afterReset.getPaperIntakePromptTemplate().promptTemplate, DEFAULT_PAPER_INTAKE_PROMPT_TEMPLATE);
  assert.equal(fixture.requests.length, 0);
});

test("无效和超长提示词不修改原有设置，40000 字符上限可保存", async (t) => {
  const fixture = await makeFixture(t);
  await fixture.service.savePromptTemplate("保留这份提示词");
  const previous = fixture.repository.db.prepare("SELECT * FROM paper_intake_settings").get();
  for (const value of [undefined, null, true, 42, [], {}, "", " \n\t ", "a".repeat(MAX_PAPER_INTAKE_PROMPT_LENGTH + 1)]) {
    await assert.rejects(fixture.service.savePromptTemplate(value), { code: "VALIDATION_ERROR", statusCode: 400 });
    assert.deepEqual(fixture.repository.db.prepare("SELECT * FROM paper_intake_settings").get(), previous);
  }
  const accepted = "a".repeat(MAX_PAPER_INTAKE_PROMPT_LENGTH);
  assert.equal((await fixture.service.savePromptTemplate(accepted)).promptTemplate, accepted);
  assert.equal((await fixture.service.savePromptTemplate(DEFAULT_PAPER_INTAKE_PROMPT_TEMPLATE)).usingDefault, true);
  assert.equal(fixture.requests.length, 0);
});

test("旧数据库自动创建提示词设置表，保留论文分类并可重复打开", async (t) => {
  const fixture = await makeFixture(t);
  const created = await fixture.repository.createPaper({ title: "旧数据库中的论文", categoryIds: ["SMOKE001"] });
  const dbPath = fixture.repository.dbPath;
  const options = { dbPath, backupDir: fixture.repository.backupDir, seedPath: fixture.seedPath };
  await fixture.repository.close();
  const legacy = new DatabaseSync(dbPath);
  legacy.exec("DROP TABLE paper_intake_settings");
  legacy.close();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const reopened = await createLibraryRepository(options);
    try {
      assert.equal(reopened.getPaper(created.paper.id).title, "旧数据库中的论文");
      assert.deepEqual(reopened.getPaper(created.paper.id).categoryIds, ["SMOKE001"]);
      assert.equal(reopened.getPaperIntakePromptTemplate().usingDefault, true);
      assert.deepEqual(reopened.integrityCheck(), ["ok"]);
    } finally {
      await reopened.close();
    }
  }
  assert.equal(fixture.requests.length, 0);
});

test("HTTP 提示词可在未配置 AI 时查看编辑恢复，鉴权和来源校验阻止越界请求", async (t) => {
  const fixture = await makeFixture(t, {
    generateText: async () => { throw Object.assign(new Error("未配置 AI"), { code: "AI_NOT_CONFIGURED" }); },
  });
  const requestToken = "paper-intake-prompt-test-token";
  const api = await createLibraryApi({ repository: fixture.repository, aiService: fixture.aiService, requestToken, port: 0 });
  const address = await api.listen();
  t.after(() => api.close());
  const path = address.url + "/api/paper-intake/prompt-template";
  const headers = { Authorization: `Bearer ${requestToken}`, Origin: "http://localhost:3000", "Content-Type": "application/json" };
  const initial = await fetch(path, { headers });
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).usingDefault, true);
  const edited = await fetch(path, { method: "PUT", headers, body: JSON.stringify({ promptTemplate: "HTTP 自定义提示词" }) });
  assert.equal(edited.status, 200);
  assert.equal((await edited.json()).promptTemplate, "HTTP 自定义提示词");
  for (const input of [null, [], {}, { promptTemplate: "" }, { promptTemplate: 123 }, { promptTemplate: "其他", hidden: "不要保存" }]) {
    const rejected = await fetch(path, { method: "PUT", headers, body: JSON.stringify(input) });
    assert.equal(rejected.status, 400);
    assert.equal(fixture.service.getPromptTemplate().promptTemplate, "HTTP 自定义提示词");
  }
  for (const [method, suffix] of [["GET", ""], ["PUT", ""], ["POST", "/reset"]]) {
    const options = {
      method,
      headers: { ...headers, Origin: "https://untrusted.example" },
      ...(method !== "GET" ? { body: JSON.stringify(method === "PUT" ? { promptTemplate: "禁止保存" } : {}) } : {}),
    };
    assert.equal((await fetch(path + suffix, options)).status, 403);
    assert.equal((await fetch(path + suffix, { ...options, headers: { ...headers, Authorization: "Bearer invalid" } })).status, 401);
    assert.equal(fixture.service.getPromptTemplate().promptTemplate, "HTTP 自定义提示词");
  }
  assert.equal((await fetch(path + "/reset", { method: "POST", headers, body: JSON.stringify({ wrong: true }) })).status, 400);
  const reset = await fetch(path + "/reset", { method: "POST", headers });
  assert.equal(reset.status, 200);
  assert.equal((await reset.json()).usingDefault, true);
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.repository.getLibrary().papers.length, 0);
});

test("名称、项目主页、DOI、arXiv、PDF 和自然语言线索均由 AI 联网完成，分析不入库", async (t) => {
  const fixture = await makeFixture(t);
  for (const reference of [
    "A Test Paper",
    "https://project.example/smoke",
    "https://github.com/example/smoke",
    "10.1145/1234.5678",
    "https://arxiv.org/abs/2501.12345v4",
    "https://papers.example/smoke.pdf",
    "Alice 那篇利用物理约束重建烟雾的论文，发表于 2025 年",
    "这是项目的介绍：请查这篇论文 https://project.example/smoke",
    "  项目线索\nhttps://github.com/example/smoke\n保留完整输入  ",
  ]) {
    const result = await fixture.service.analyze({ reference });
    assert.equal(result.status, "ready", reference);
    assert.equal(result.draft.title, "A Test Paper");
    assert.equal(result.draft.institution, researchResult().paper.institution);
    assert.equal(result.draft.source, researchResult().paper.source);
    assert.equal(result.draft.zhTitle, "烟雾体重建");
    assert.deepEqual(result.draft.categoryIds, ["SMOKE001"]);
    assert.equal(result.draft.hasPdf, true);
    assert.equal(result.draft.codeProvider, "GitHub");
    assert.equal(result.draft.projectUrl, "https://project.example/smoke");
    assert.equal(result.metadata.sources[0].title, "论文原文");
    assert.equal(result.ai.model, "research-model");
    assert.equal(fixture.requests.at(-1).webSearch, true);
    assert.ok(fixture.requests.at(-1).input.includes(JSON.stringify(reference)));
    assert.equal(result.reference, reference);
  }
  assert.equal(fixture.repository.getLibrary().papers.length, 0);
  const prompt = fixture.requests[0].input;
  assert.match(prompt, /不能新建分类/u);
  assert.match(prompt, /计算机视觉 › 烟雾重建/u);
});

test("已有明确标识或标题也先交给 AI，识别结果返回后查重", async (t) => {
  const fixture = await makeFixture(t);
  const created = await fixture.repository.createPaper({
    title: "A Test Paper",
    identifiers: [{ kind: "doi", value: "10.1145/1234.5678" }],
  });
  for (const reference of ["https://doi.org/10.1145/1234.5678", "a TEST paper!"]) {
    const result = await fixture.service.analyze({ reference });
    assert.equal(result.status, "duplicate");
    assert.equal(result.duplicates[0].paper.id, created.paper.id);
  }
  assert.equal(fixture.requests.length, 2);
});

test("从描述识别出已有论文后再次查重", async (t) => {
  const fixture = await makeFixture(t);
  await fixture.repository.createPaper({ title: "a test paper!" });
  const result = await fixture.service.analyze({ reference: "Alice 的烟雾重建论文" });
  assert.equal(result.status, "duplicate");
  assert.equal(fixture.requests.length, 1);
});

test("已删除论文不参与查重，可以重新分析", async (t) => {
  const fixture = await makeFixture(t);
  const created = await fixture.repository.createPaper({ title: "A Test Paper" });
  await fixture.repository.deletePaper(created.paper.id);
  assert.equal((await fixture.service.analyze({ reference: "A Test Paper" })).status, "ready");
});

test("真正模糊或冲突的线索要求补充，不生成可保存草稿或反复检索", async (t) => {
  for (const clarificationReason of ["ambiguous", "conflicting", "insufficient_input"]) {
    const fixture = await makeFixture(t, { result: {
      status: "needs_clarification", clarificationReason, message: "请补充作者或年份。", sources: [],
    } });
    const result = await fixture.service.analyze({ reference: "NeRF 的改进方法" });
    assert.equal(result.status, "needs_clarification");
    assert.equal(result.reference, "NeRF 的改进方法");
    assert.equal(result.message, "请补充作者或年份。");
    assert.equal(result.draft, undefined);
    assert.equal(fixture.requests.length, 1);
  }
});

test("直接展示 AI 返回的未找到、未完成和需补充状态，不自动补查或改写判断", async (t) => {
  for (const status of ["not_found", "research_incomplete", "needs_clarification"]) {
    const fixture = await makeFixture(t, { result: {
      status, clarificationReason: "insufficient_input", message: "请提供论文标题。", sources: [],
    } });
    const result = await fixture.service.analyze({ reference: "https://yvette256.github.io/thermalnerf/" });
    assert.equal(result.status, status);
    assert.equal(fixture.requests.length, 1);
    assert.equal(result.reference, "https://yvette256.github.io/thermalnerf/");
    assert.equal(result.draft, undefined);
    assert.equal(result.message, "请提供论文标题。");
    assert.equal(fixture.repository.getLibrary().papers.length, 0);
  }
});

test("直接采用 AI 列出的来源，不要求来源与工具记录逐条匹配", async (t) => {
  const fixture = await makeFixture(t, { webSources: [{ url: "https://unrelated.example/", title: "无关页面" }] });
  const result = await fixture.service.analyze({ reference: "烟雾论文" });
  assert.equal(result.status, "ready");
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(result.metadata.sources, [{ url: PAPER_URL, title: "论文原文" }]);
  assert.equal(result.draft.title, "A Test Paper");
});

test("AI 确认论文后，来源字段标注或可选作者缺失不会阻止草稿", async (t) => {
  const onlyTitle = researchResult();
  onlyTitle.sources[0].fields = ["title"];
  for (const result of [onlyTitle, researchResult({ authors: "" })]) {
    const fixture = await makeFixture(t, { result });
    const response = await fixture.service.analyze({ reference: "烟雾论文" });
    assert.equal(response.status, "ready");
    assert.equal(response.draft.authors, result.paper.authors);
    assert.equal(fixture.requests.length, 1);
  }
});

test("ThermalNeRF 项目页可支持标题、作者和其链接的 arXiv 原文，无需重复索要线索", async (t) => {
  const projectUrl = "https://yvette256.github.io/thermalnerf/";
  const result = researchResult({
    title: "ThermalNeRF: Thermal Radiance Fields",
    zhTitle: "ThermalNeRF：热辐射场",
    authors: "Yvette Y. Lin; Xin-Yi Pan; Sara Fridovich-Keil; Gordon Wetzstein",
    institution: "Stanford University",
    source: "ICCP 2024", date: "2024",
    originalUrl: "https://arxiv.org/abs/2407.15337",
    pdfUrl: "https://arxiv.org/pdf/2407.15337",
    aiSummary: "使用可见光和长波红外图像构建多光谱辐射场，以重建热场景。",
    codeUrl: "https://github.com/yvette256/nerfstudio-thermal", projectUrl,
    identifiers: [{ kind: "arxiv", value: "2407.15337" }],
  });
  result.sources = [{ url: projectUrl, title: result.paper.title, fields: [...SOURCE_FIELDS] }];
  const fixture = await makeFixture(t, { result, webSources: [{ url: projectUrl, title: result.paper.title }] });
  const response = await fixture.service.analyze({ reference: projectUrl });
  assert.equal(response.status, "ready");
  assert.equal(response.draft.title, result.paper.title);
  assert.equal(response.draft.authors, result.paper.authors);
  assert.equal(response.draft.originalUrl, "https://arxiv.org/abs/2407.15337");
  assert.equal(response.draft.source, "ICCP 2024");
  assert.equal(response.metadata.sources[0].url, projectUrl);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.repository.getLibrary().papers.length, 0);
});

test("保留 AI 返回的原文链接，不用来源页面覆盖", async (t) => {
  const result = researchResult({ originalUrl: "https://other.example/unverified" });
  result.sources[0].fields = ["title", "authors"];
  const fixture = await makeFixture(t, { result });
  const response = await fixture.service.analyze({ reference: "烟雾论文" });
  assert.equal(response.status, "ready");
  assert.equal(response.draft.originalUrl, result.paper.originalUrl);
  assert.deepEqual(response.metadata.warnings, []);
});

test("完整检索交给一次 AI 任务，选定模型透传，未完成时由用户重试", async (t) => {
  const fixture = await makeFixture(t, { generateText: async () => {
    return {
      text: JSON.stringify({ status: "research_incomplete", message: "网页未读完。", sources: [] }),
      webSearchUsed: true,
      webSources: [{ url: PAPER_URL, title: "工具来源" }],
      resolvedModel: "research-model",
    };
  } });
  const response = await fixture.service.analyze({ reference: "https://project.example/smoke", modelId: "selected" });
  assert.equal(response.status, "research_incomplete");
  assert.equal(response.message, "网页未读完。");
  assert.equal(fixture.requests.length, 1);
  assert.ok(fixture.requests.every((request) => request.modelId === "selected" && request.webSearch));
  assert.match(fixture.requests[0].input, /一次任务内完成必要的补查/u);
});

test("项目页确实存在多篇候选时仍允许询问，不强行选取一篇", async (t) => {
  const fixture = await makeFixture(t, { result: {
    status: "needs_clarification", clarificationReason: "ambiguous",
    message: "该页有两篇不同论文，你指的是哪一篇？", sources: [],
  } });
  const result = await fixture.service.analyze({ reference: "https://project.example/two-papers" });
  assert.equal(result.status, "needs_clarification");
  assert.equal(fixture.requests.length, 1);
});

test("事实核对交给 AI，不因缺少字段级证据标记清空返回资料", async (t) => {
  const result = researchResult();
  result.sources[0].fields = ["title", "authors", "source", "date"];
  const fixture = await makeFixture(t, { result });
  const response = await fixture.service.analyze({ reference: "烟雾论文" });
  assert.equal(response.status, "ready");
  for (const field of ["institution", "source", "date", "aiSummary", "codeUrl", "projectUrl", "pdfUrl"]) {
    assert.equal(response.draft[field], result.paper[field]);
  }
  assert.equal(response.draft.hasPdf, true);
  assert.deepEqual(response.metadata.warnings, []);
});

test("私网、带凭据、非 HTTP 的资源不会被保存；畸形标识不会导致崩溃", async (t) => {
  const fixture = await makeFixture(t, { result: researchResult({
    pdfUrl: "http://127.0.0.1/private.pdf",
    codeUrl: "javascript:alert(1)",
    projectUrl: "https://user:secret@project.example/",
    identifiers: [{ kind: "doi", value: "%invalid" }, { kind: "url", value: "http://[::1]/private" }],
  }) });
  const response = await fixture.service.analyze({ reference: "烟雾论文" });
  assert.equal(response.status, "ready");
  assert.equal(response.draft.pdfUrl, "");
  assert.equal(response.draft.codeUrl, "");
  assert.equal(response.draft.projectUrl, "");
  assert.deepEqual(response.draft.identifiers, []);
});

test("保留 AI 提供的来源链接及参数", async (t) => {
  const result = researchResult();
  result.sources = [
    { url: PAPER_URL + "?utm_source=search", title: "原文", fields: ["title"] },
    { url: PAPER_URL, title: "原文", fields: ["authors", "source", "date"] },
  ];
  const fixture = await makeFixture(t, { result });
  const response = await fixture.service.analyze({ reference: "烟雾论文" });
  assert.equal(response.status, "ready");
  assert.equal(response.metadata.sources.length, 2);
  assert.equal(response.metadata.sources[0].url, PAPER_URL + "?utm_source=search");
});

test("输入标识识别和一致性判断交给 AI，本地采用返回的论文标识", async (t) => {
  const fixture = await makeFixture(t);
  const response = await fixture.service.analyze({ reference: "10.1145/9999.9999" });
  assert.equal(response.status, "ready");
  assert.ok(fixture.requests[0].input.includes("10.1145/9999.9999"));
  assert.ok(response.draft.identifiers.some((id) => id.value === "10.1145/1234.5678"));
});

test("用户描述中其他论文的标识不会混入已确认论文", async (t) => {
  const fixture = await makeFixture(t);
  const response = await fixture.service.analyze({ reference: "找引用了 10.1234/other 的那篇烟雾重建论文" });
  assert.equal(response.status, "ready");
  assert.equal(response.draft.identifiers.some((id) => id.value === "10.1234/other"), false);
});

test("AI 返回有效资料即可生成草稿，不依赖服务商额外的联网记录字段", async (t) => {
  const fixture = await makeFixture(t, { webSearchUsed: false });
  assert.equal((await fixture.service.analyze({ reference: "烟雾论文" })).status, "ready");
  assert.equal(fixture.requests[0].webSearch, true);
});

test("未配置、联网不支持或超时不退回凭记忆填写", async (t) => {
  for (const code of ["AI_NOT_CONFIGURED", "WEB_SEARCH_UNSUPPORTED", "TIMEOUT"]) {
    const fixture = await makeFixture(t, { generateText: async () => { throw Object.assign(new Error(code), { code }); } });
    await assert.rejects(fixture.service.analyze({ reference: "烟雾论文" }), { code });
    assert.equal(fixture.repository.getLibrary().papers.length, 0);
  }
});

test("无效 AI JSON 拒绝，允许正文后附带完整 JSON 和引用", async (t) => {
  const invalid = await makeFixture(t, { result: "not JSON" });
  await assert.rejects(invalid.service.analyze({ reference: "烟雾论文" }), { code: "INVALID_AI_RESULT" });
  const valid = await makeFixture(t, { result: "检索结果\n\`\`\`json\n" + JSON.stringify(researchResult()) + "\n\`\`\`\n来源说明" });
  assert.equal((await valid.service.analyze({ reference: "烟雾论文" })).status, "ready");
});

test("JSON 之前正文中的未闭合引号不会导致有效论文结果被漏读", async (t) => {
  const fixture = await makeFixture(t, {
    result: '对输入 "https://github.com/JiaxiongQ/NeuSmoke 的检索结果：\n' + JSON.stringify(researchResult()),
  });
  const response = await fixture.service.analyze({ reference: "https://github.com/JiaxiongQ/NeuSmoke" });
  assert.equal(response.status, "ready");
  assert.equal(response.draft.title, "A Test Paper");
  assert.equal(fixture.requests.length, 1);
});

test("前导残缺括号、坏 ready 占位及较早状态不会遮挡最终完整论文 JSON", async (t) => {
  for (const prefix of [
    "检索计划：{项目主页，论文链接\n",
    '{"计划":"尚未闭合的说明\n',
    '{"status":"ready"}\n最终论文资料：\n',
    '{"status":"research_incomplete","message":"正在检索"}\n最终论文资料：\n',
  ]) {
    const fixture = await makeFixture(t, { result: prefix + JSON.stringify(researchResult()) });
    const result = await fixture.service.analyze({ reference: "https://jna-358.github.io/gaussians_on_fire/" });
    assert.equal(result.status, "ready");
    assert.equal(result.draft.title, researchResult().paper.title);
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.repository.getLibrary().papers.length, 0);
  }
});

test("包装 JSON 的字符串括号、转义和代码块保持论文文本完整", async (t) => {
  const paper = researchResult({ title: 'A {Flame} with "Escaped Quotes"', aiSummary: '包含 \\ 路径和 {括号} 的资料。' });
  const fixture = await makeFixture(t, { result: "最终资料：\n```json\n" + JSON.stringify(paper) + "\n```\n" });
  const result = await fixture.service.analyze({ reference: "火焰重建论文" });
  assert.equal(result.draft.title, paper.paper.title);
  assert.equal(result.draft.aiSummary, paper.paper.aiSummary);
  assert.equal(fixture.requests.length, 1);
});

test("完整结果内部的 status 不是另一份最终答复，明确未完成也不会升格为 ready", async (t) => {
  const ready = researchResult({ extra: { status: "not_found" } });
  ready.sources[0].extra = { status: "research_incomplete" };
  for (const prefix of ["", "最终资料：\n```json\n"]) {
    const fixture = await makeFixture(t, { result: prefix + JSON.stringify(ready) });
    const response = await fixture.service.analyze({ reference: "项目主页" });
    assert.equal(response.status, "ready");
    assert.equal(response.draft.title, ready.paper.title);
  }
  const incomplete = { status: "research_incomplete", message: "尚未核实", example: researchResult() };
  const fixture = await makeFixture(t, { result: "最终资料：\n" + JSON.stringify(incomplete) });
  const response = await fixture.service.analyze({ reference: "项目主页" });
  assert.equal(response.status, "research_incomplete");
  assert.equal(response.draft, undefined);
  assert.equal(fixture.repository.getLibrary().papers.length, 0);
});

test("最终未知状态或无标题对象不能回退到之前的 ready 或内部示例", async (t) => {
  const invalid = { ...researchResult(), status: "success", example: { status: "not_found" } };
  for (const result of [invalid, "最终资料：\n" + JSON.stringify(invalid), JSON.stringify(researchResult()) + '\n{"status":"ready"}']) {
    const fixture = await makeFixture(t, { result });
    await assert.rejects(fixture.service.analyze({ reference: "项目主页" }), { code: "INVALID_AI_RESULT" });
    assert.equal(fixture.repository.getLibrary().papers.length, 0);
  }
});

test("未知枚举和不完整资料仍拒绝，不猜测题目也不写入论文库", async (t) => {
  for (const result of [
    { ...researchResult(), status: "ready|needs_clarification|research_incomplete|not_found" },
    { ...researchResult(), status: "success" },
    { status: "ready", paper: [] },
    researchResult({ title: " \n " }),
    '{"status":"ready","paper":{"title":"未完成的 JSON',
  ]) {
    const fixture = await makeFixture(t, { result });
    await assert.rejects(fixture.service.analyze({ reference: "https://jna-358.github.io/gaussians_on_fire/" }), { code: "INVALID_AI_RESULT" });
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.repository.getLibrary().papers.length, 0);
  }
});

test("默认模板的结构示例本身是合法 JSON，枚举值不会被当作管道字符串照抄", () => {
  const example = DEFAULT_PAPER_INTAKE_PROMPT_TEMPLATE.split("\n").find((line) => line.startsWith('{"status"'));
  const parsed = JSON.parse(example);
  assert.equal(parsed.status, "ready");
  assert.equal(parsed.paper.publicationStatus, "unknown");
  assert.deepEqual(parsed.paper.identifiers, []);
  assert.equal(DEFAULT_PAPER_INTAKE_PROMPT_TEMPLATE.includes('"ready|'), false);
  assert.equal(DEFAULT_PAPER_INTAKE_PROMPT_TEMPLATE.includes('"published|'), false);
  assert.equal(DEFAULT_PAPER_INTAKE_PROMPT_TEMPLATE.includes('"doi|'), false);
});

test("Gaussians on Fire 项目链接通过真实 Provider 的 JSON／SSE 最终答复生成草稿并查重", async (t) => {
  const projectUrl = "https://jna-358.github.io/gaussians_on_fire/";
  const paper = researchResult({
    title: "Gaussians on Fire: High-Frequency Reconstruction of Flames",
    authors: "Jakob Nazarenus; Dominik Michels; Wojtek Palubicki; Simin Kou; Fang-Lue Zhang; Sören Pirk; Reinhard Koch",
    institution: "Kiel University",
    source: "ECCV 2026", date: "2026",
    originalUrl: "https://arxiv.org/abs/2511.22459",
    pdfUrl: "https://arxiv.org/pdf/2511.22459",
    codeUrl: "https://github.com/jna-358/gaussians_on_fire", projectUrl,
    identifiers: [{ kind: "arxiv", value: "2511.22459" }],
  });
  paper.sources = [{ url: projectUrl, title: paper.paper.title }];
  for (const stream of [false, true]) {
    const fixture = await makeFixture(t);
    const requests = [];
    const fetchImpl = async (url, init) => {
      const request = JSON.parse(init.body);
      requests.push({ url: String(url), body: request });
      const output = request.tools ? [
        { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: '正在检查项目链接：{\n{"status":"ready"}' }] },
        { type: "web_search_call", action: { type: "open_page", url: projectUrl } },
        { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: JSON.stringify(paper) }] },
      ] : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }];
      const payload = { status: "completed", model: "research-model", output };
      return new Response(stream ? `data: ${JSON.stringify({ type: "response.completed", response: payload })}\n\n` : JSON.stringify(payload), {
        headers: { "Content-Type": stream ? "text/event-stream" : "application/json" },
      });
    };
    const aiService = createAiService({ repository: fixture.repository, credentialStore: new MemoryCredentialStore(), providers: createAiProviders({ fetchImpl }) });
    await aiService.verifyAndSave(null, { baseUrl: "https://gateway.example/v1", apiKey: "sk-fixture-only", model: "research-model" });
    const api = await createLibraryApi({ repository: fixture.repository, aiService, port: 0 });
    t.after(() => api.close());
    const address = await api.listen();
    const response = await fetch(address.url + "/api/paper-intake/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reference: projectUrl }) });
    assert.equal(response.status, 200);
    const ready = await response.json();
    assert.equal(ready.status, "ready");
    assert.equal(ready.draft.title, paper.paper.title);
    assert.equal(ready.draft.projectUrl, projectUrl);
    assert.equal(ready.draft.codeUrl, paper.paper.codeUrl);
    assert.equal(ready.draft.pdfUrl, paper.paper.pdfUrl);
    assert.equal(ready.metadata.sources[0].url, projectUrl);
    assert.equal(fixture.repository.getLibrary().papers.length, 0);
    assert.equal(requests.length, 2); // One credential verification, one research task.
    assert.ok(requests[1].body.input.includes(JSON.stringify(projectUrl)));
    assert.deepEqual(requests[1].body.tools, [{ type: "web_search" }]);
    assert.equal(requests[1].body.input.startsWith(DEFAULT_PAPER_INTAKE_PROMPT_TEMPLATE), true);
    await fixture.repository.createPaper(ready.draft);
    const duplicates = await api.paperIntakeService.analyze({ reference: projectUrl });
    assert.equal(duplicates.status, "duplicate");
    assert.equal(fixture.repository.getLibrary().papers.length, 1);
    assert.equal(requests.length, 3);
  }
});

test("空白最终答复明确报告服务未返回内容，不误报论文 JSON 格式错误", async (t) => {
  const fixture = await makeFixture(t, { result: " " });
  await assert.rejects(fixture.service.analyze({ reference: "https://github.com/JiaxiongQ/NeuSmoke" }), {
    code: "EMPTY_AI_RESPONSE", message: "AI 服务未返回最终答复，请重试。",
  });
  assert.equal(fixture.repository.getLibrary().papers.length, 0);
});

test("缺少可保存标题或返回错误的数据类型时，展示格式错误而不保存", async (t) => {
  for (const result of [{ status: "ready" }, researchResult({ title: "" }), researchResult({ title: 42 })]) {
    const fixture = await makeFixture(t, { result });
    await assert.rejects(fixture.service.analyze({ reference: "烟雾论文" }), { code: "INVALID_AI_RESULT" });
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.repository.getLibrary().papers.length, 0);
  }
});

test("空白和超长线索在 AI 请求前拒绝，明确模型选择会透传", async (t) => {
  const fixture = await makeFixture(t);
  for (const reference of ["   ", "a".repeat(12_001)]) await assert.rejects(fixture.service.analyze({ reference }));
  assert.equal(fixture.requests.length, 0);
  await fixture.service.analyze({ reference: "烟雾论文", modelId: "selected-model" });
  assert.equal(fixture.requests[0].modelId, "selected-model");
});

test("HTTP 分析返回来源但不写入；确认保存、再次保存查重均生效", async (t) => {
  const fixture = await makeFixture(t);
  const api = await createLibraryApi({ repository: fixture.repository, aiService: fixture.aiService, port: 0 });
  const address = await api.listen();
  t.after(() => api.close());
  const request = (path, body) => fetch(address.url + "/api" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
    body: JSON.stringify(body),
  });
  const analyzed = await request("/paper-intake/analyze", { reference: "Alice 的烟雾论文" });
  assert.equal(analyzed.status, 200);
  const result = await analyzed.json();
  assert.equal(result.status, "ready");
  assert.equal(result.metadata.sources.length, 1);
  assert.equal(fixture.repository.getLibrary().papers.length, 0);
  const saved = await request("/papers", result.draft);
  assert.equal(saved.status, 201);
  const payload = await saved.json();
  assert.equal(payload.paper.title, "A Test Paper");
  assert.equal(payload.backup.ok, true);
  assert.equal((await request("/papers", result.draft)).status, 409);
  assert.equal(fixture.repository.getLibrary().papers.length, 1);
});
