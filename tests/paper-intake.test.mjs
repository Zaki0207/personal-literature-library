import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLibraryRepository } from "../scripts/library-repository.mjs";
import { createLibraryApi } from "../scripts/library-api.mjs";
import { createPaperIntakeService } from "../scripts/paper-intake.mjs";

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

async function makeFixture(t, { result = researchResult(), generateText, webSearchUsed = true, webSources } = {}) {
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
  return { repository, requests, aiService, service: createPaperIntakeService({ repository, aiService }) };
}

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
