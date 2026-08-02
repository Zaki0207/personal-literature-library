import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLibraryRepository } from "../scripts/library-repository.mjs";
import { createPaperIntakeService } from "../scripts/paper-intake.mjs";

async function makeFixture(t, name, { aiService, fetchImpl } = {}) {
  const directory = await mkdtemp(join(tmpdir(), `paper-intake-${name}-`));
  const seedPath = join(directory, "seed.json");
  await writeFile(
    seedPath,
    JSON.stringify({
      categoryRecords: [
        {
          id: "ROOT0001",
          name: "计算机视觉",
          parentId: null,
          sourceKind: "test",
          sortOrder: 0,
          sidebarVisible: true,
        },
        {
          id: "SMOKE001",
          name: "烟雾重建",
          parentId: "ROOT0001",
          sourceKind: "test",
          sortOrder: 1,
          sidebarVisible: true,
        },
      ],
      papers: [],
    }),
    "utf8",
  );
  const repository = await createLibraryRepository({
    dbPath: join(directory, "database", "library.sqlite3"),
    backupDir: join(directory, "backups"),
    seedPath,
  });
  t.after(async () => {
    await repository.close();
    await rm(directory, { recursive: true, force: true });
  });
  const resolvedAiService =
    aiService ??
    {
      async generateText() {
        return {
          resolvedModel: "test-model",
          text: JSON.stringify({
            zhTitle: "用于烟雾重建的测试论文",
            institution: "Example University",
            source: "CVPR 2025",
            aiSummary: "本文研究烟雾场景的三维重建，并提出一种基于测试数据的稳定方法。",
            categoryIds: ["SMOKE001", "NOT_ALLOWED"],
          }),
        };
      },
    };
  return {
    repository,
    service: createPaperIntakeService({
      repository,
      aiService: resolvedAiService,
      fetchImpl,
    }),
  };
}

function crossrefResponse({
  doi = "10.1145/1234.5678",
  title = "A Test Paper",
  institution = "Example University",
  source = "CVPR",
  abstract = "<jats:p>We reconstruct volumetric smoke.</jats:p>",
  published = [2025, 6, 12],
} = {}) {
  return new Response(
    JSON.stringify({
      status: "ok",
      message: {
        DOI: doi,
        title: [title],
        author: [
          {
            given: "Alice",
            family: "Researcher",
            affiliation: [{ name: institution }],
          },
        ],
        "container-title": [source],
        published: { "date-parts": [published] },
        abstract,
        URL: `https://doi.org/${doi}`,
        link: [
          {
            "content-type": "application/pdf",
            URL: "https://publisher.example/paper.pdf",
          },
        ],
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function emptyCrossrefSearchResponse() {
  return new Response(JSON.stringify({ message: { items: [] } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("DOI 先获取权威元数据，再让 AI 只补全知识库需要的字段", async (t) => {
  const prompts = [];
  const fixture = await makeFixture(t, "doi", {
    fetchImpl: async (url) => {
      const href = String(url);
      if (/api\.crossref\.org\/works\/10\.1145%2F1234\.5678/u.test(href)) {
        return crossrefResponse({
          institution:
            "Tsinghua University, Beijing National Research Center for Information Science and Technology (BNRist), Department of Computer Science and Technology; Hong Kong University of Science and Technology",
        });
      }
      if (href === "https://doi.org/10.1145/1234.5678") {
        return new Response(
          '<a href="https://github.com/example/smoke-reconstruction">Code</a><a href="https://project.example/smoke">Project Page</a>',
          { status: 200, headers: { "Content-Type": "text/html" } },
        );
      }
      throw new Error(`未预期的请求：${href}`);
    },
    aiService: {
      async generateText({ input }) {
        prompts.push(input);
        return {
          resolvedModel: "deepseek-v4-pro",
          text: '{"zhTitle":"烟雾体重建","institution":"Tsinghua University, Beijing National Research Center for Information Science and Technology (BNRist), Department of Computer Science and Technology","source":"2025 IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)","aiSummary":"本文研究烟雾体的三维重建方法，并依据论文摘要整理其问题、方法与贡献。","categoryIds":["SMOKE001","UNKNOWN"]}',
        };
      },
    },
  });

  const result = await fixture.service.analyze({ reference: "10.1145/1234.5678" });
  assert.equal(result.status, "ready");
  assert.equal(result.draft.title, "A Test Paper");
  assert.equal(result.draft.authors, "Alice Researcher");
  assert.equal(result.draft.institution, "Tsinghua University");
  assert.match(result.metadata.institution, /Beijing National Research Center/u);
  assert.equal(result.draft.source, "CVPR 2025");
  assert.equal(result.draft.date, "2025-06-12");
  assert.equal(result.draft.zhTitle, "烟雾体重建");
  assert.deepEqual(result.draft.categoryIds, ["SMOKE001"]);
  assert.deepEqual(
    result.draft.identifiers.filter((item) => item.kind === "doi"),
    [{ kind: "doi", value: "10.1145/1234.5678" }],
  );
  assert.equal(
    result.draft.identifiers.some((item) => item.kind === "arxiv"),
    false,
    "DOI 尾部的年份与编号不能被误判为 arXiv",
  );
  assert.equal(result.ai.model, "deepseek-v4-pro");
  assert.equal(result.ai.institution, "Tsinghua University");
  assert.equal(result.ai.source, "CVPR 2025");
  assert.equal(result.draft.codeUrl, "https://github.com/example/smoke-reconstruction");
  assert.equal(result.draft.projectUrl, "https://project.example/smoke");
  assert.equal(result.metadata.codeEvidence, "论文页面直接链接");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /只返回一个 JSON 对象/u);
  assert.match(
    prompts[0],
    /"zhTitle":"","institution":"","source":"","aiSummary":"","categoryIds":\[\]/u,
  );
  assert.match(prompts[0], /只保留第一作者的首个顶层机构/u);
  assert.match(prompts[0], /CVPR 2025 \(Oral\)/u);
  assert.match(prompts[0], /"publicationStatus":"published"/u);
  assert.doesNotMatch(prompts[0], /keywords|关键词/iu);
  assert.doesNotMatch(prompts[0], /zotero/iu);
});

test("arXiv 链接会规范化版本号，并按标题与作者匹配正式发表版本", async (t) => {
  const fixture = await makeFixture(t, "arxiv", {
    fetchImpl: async (url) => {
      const href = String(url);
      if (/export\.arxiv\.org\/api\/query\?id_list=2401\.01234/u.test(href)) {
        return new Response(
          `<?xml version="1.0"?><feed xmlns:arxiv="http://arxiv.org/schemas/atom"><entry>
            <id>https://arxiv.org/abs/2401.01234v2</id>
            <published>2024-01-03T00:00:00Z</published>
            <title>Learning Smoke Reconstruction</title>
            <summary>We introduce a smoke reconstruction method.</summary>
            <author><name>Alice Example</name></author>
            <author><name>Bob Example</name></author>
            <arxiv:primary_category term="cs.CV" />
            <link title="pdf" href="https://arxiv.org/pdf/2401.01234v2" />
          </entry></feed>`,
          { status: 200, headers: { "Content-Type": "application/atom+xml" } },
        );
      }
      if (/api\.crossref\.org\/works\?/u.test(href)) {
        return new Response(
          JSON.stringify({
            message: {
              items: [
                {
                  DOI: "10.1109/CVPR.2025.01234",
                  title: ["Learning Smoke Reconstruction"],
                  author: [
                    { given: "Alice", family: "Example" },
                    { given: "Bob", family: "Example" },
                  ],
                  "container-title": ["CVPR"],
                  published: { "date-parts": [[2025, 6]] },
                  abstract: "The published smoke reconstruction paper.",
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (href === "https://arxiv.org/abs/2401.01234") {
        return new Response("<html></html>", { status: 200 });
      }
      if (href === "https://doi.org/10.1109/cvpr.2025.01234") {
        return new Response(
          '<a href="https://github.com/example/published-smoke">Official code</a>',
          { status: 200 },
        );
      }
      throw new Error(`未预期的请求：${href}`);
    },
  });

  const result = await fixture.service.analyze({
    reference: "https://arxiv.org/abs/2401.01234v2",
  });
  assert.equal(result.status, "ready");
  assert.equal(result.draft.title, "Learning Smoke Reconstruction");
  assert.equal(result.draft.authors, "Alice Example; Bob Example");
  assert.equal(result.draft.date, "2025-06");
  assert.equal(result.draft.source, "CVPR 2025");
  assert.equal(result.draft.originalUrl, "https://doi.org/10.1109/cvpr.2025.01234");
  assert.equal(result.draft.pdfUrl, "https://arxiv.org/pdf/2401.01234v2");
  assert.equal(result.metadata.publicationStatus, "published");
  assert.equal(result.metadata.publicationMatch.method, "title-author");
  assert.equal(result.metadata.preprint.arxivId, "2401.01234");
  assert.equal(result.draft.codeUrl, "https://github.com/example/published-smoke");
  assert.ok(
    result.draft.identifiers.some(
      (identifier) =>
        identifier.kind === "arxiv" && identifier.value === "2401.01234",
    ),
  );
  assert.ok(
    result.draft.identifiers.some(
      (identifier) =>
        identifier.kind === "doi" &&
        identifier.value === "10.1109/cvpr.2025.01234",
    ),
  );
});

test("论文页面无资源链接时，会用论文标识验证 GitHub 仓库和项目主页", async (t) => {
  const fixture = await makeFixture(t, "github-resource", {
    fetchImpl: async (url) => {
      const href = String(url);
      if (/export\.arxiv\.org\/api\/query\?id_list=2501\.09999/u.test(href)) {
        return new Response(
          `<?xml version="1.0"?><feed><entry>
            <id>https://arxiv.org/abs/2501.09999</id>
            <published>2025-01-20T00:00:00Z</published>
            <title>Verified Neural Smoke</title>
            <summary>Smoke reconstruction.</summary>
            <author><name>Alice Example</name></author>
            <link title="pdf" href="https://arxiv.org/pdf/2501.09999" />
          </entry></feed>`,
          { status: 200 },
        );
      }
      if (/api\.crossref\.org\/works\?/u.test(href)) {
        return emptyCrossrefSearchResponse();
      }
      if (href === "https://arxiv.org/abs/2501.09999") {
        return new Response("<html><body>No resource link</body></html>", {
          status: 200,
        });
      }
      if (/api\.github\.com\/search\/repositories/u.test(href)) {
        return new Response(
          JSON.stringify({
            items: [
              {
                full_name: "research/verified-neural-smoke",
                name: "verified-neural-smoke",
                html_url: "https://github.com/research/verified-neural-smoke",
                homepage: "https://research.example/verified-smoke",
                description: "Official implementation",
                archived: false,
                fork: false,
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (href === "https://api.github.com/repos/research/verified-neural-smoke/readme") {
        return new Response("Official code for arXiv:2501.09999", { status: 200 });
      }
      throw new Error(`未预期的请求：${href}`);
    },
  });

  const result = await fixture.service.analyze({ reference: "arXiv:2501.09999" });
  assert.equal(result.status, "ready");
  assert.equal(
    result.draft.codeUrl,
    "https://github.com/research/verified-neural-smoke",
  );
  assert.equal(result.draft.projectUrl, "https://research.example/verified-smoke");
  assert.match(result.metadata.codeEvidence, /README 引用了论文标识/u);
});

test("已存在的 DOI 在访问外部元数据和 AI 前就停止", async (t) => {
  let metadataCalls = 0;
  let aiCalls = 0;
  const fixture = await makeFixture(t, "duplicate", {
    fetchImpl: async () => {
      metadataCalls += 1;
      return crossrefResponse();
    },
    aiService: {
      async generateText() {
        aiCalls += 1;
        throw new Error("不应调用 AI");
      },
    },
  });
  await fixture.repository.createPaper({
    title: "Existing Paper",
    originalUrl: "https://doi.org/10.1145/1234.5678",
    identifiers: [{ kind: "doi", value: "10.1145/1234.5678" }],
  });

  const result = await fixture.service.analyze({
    reference: "https://doi.org/10.1145/1234.5678",
  });
  assert.equal(result.status, "duplicate");
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].paper.title, "Existing Paper");
  assert.equal(metadataCalls, 0);
  assert.equal(aiCalls, 0);
});

test("已删除的论文不参与查重，可以重新分析并添加", async (t) => {
  const fixture = await makeFixture(t, "deleted-duplicate", {
    fetchImpl: async (url) => {
      const href = String(url);
      if (/api\.crossref\.org\/works\/10\.1145%2F1234\.5678/u.test(href)) {
        return crossrefResponse();
      }
      if (href === "https://doi.org/10.1145/1234.5678") {
        return new Response(
          '<a href="https://github.com/example/smoke-reconstruction">Code</a>',
          { status: 200, headers: { "Content-Type": "text/html" } },
        );
      }
      throw new Error(`未预期的请求：${href}`);
    },
  });
  const original = await fixture.repository.createPaper({
    title: "A Test Paper",
    identifiers: [{ kind: "doi", value: "10.1145/1234.5678" }],
  });
  await fixture.repository.deletePaper(original.paper.id);

  const analyzed = await fixture.service.analyze({
    reference: "https://doi.org/10.1145/1234.5678",
  });
  assert.equal(analyzed.status, "ready");

  const replacement = await fixture.repository.createPaper(analyzed.draft);
  assert.equal(fixture.repository.getLibrary().papers.length, 1);
  assert.equal(replacement.paper.title, "A Test Paper");

  await assert.rejects(
    fixture.repository.restorePaper(original.paper.id),
    (error) =>
      error?.code === "CONFLICT" &&
      error.details?.duplicates?.[0]?.paper.id === replacement.paper.id,
  );
});

test("网页元数据解析后会再次按规范化标题查重", async (t) => {
  let aiCalls = 0;
  const fixture = await makeFixture(t, "title-duplicate", {
    fetchImpl: async () =>
      new Response(
        '<html><head><meta name="citation_title" content="Exact Paper: A Study"><meta name="citation_author" content="Bob"><meta name="citation_conference_title" content="CVPR"></head></html>',
        { status: 200, headers: { "Content-Type": "text/html" } },
      ),
    aiService: {
      async generateText() {
        aiCalls += 1;
        throw new Error("不应调用 AI");
      },
    },
  });
  await fixture.repository.createPaper({ title: "Exact Paper — A Study" });

  const result = await fixture.service.analyze({
    reference: "https://papers.example/new-url",
  });
  assert.equal(result.status, "duplicate");
  assert.equal(result.duplicates[0].reasons[0].type, "title");
  assert.equal(aiCalls, 0);
});

test("PDF 直链不会按网页大小拒绝，并会从对应论文页补全元数据", async (t) => {
  const pdfUrl = "https://pranav-jain.github.io/projects/nmcfs/nmcfs.pdf";
  const projectUrl = "https://pranav-jain.github.io/projects/nmcfs/";
  const prompts = [];
  const fixture = await makeFixture(t, "direct-pdf", {
    aiService: {
      async generateText({ input }) {
        prompts.push(input);
        return {
          resolvedModel: "test-model",
          text: JSON.stringify({
            zhTitle: "神经蒙特卡罗流体模拟",
            institution: "University of Southern California",
            source: "SIGGRAPH 2024",
            aiSummary: "本文提出结合神经场与蒙特卡罗压力求解的无网格流体模拟方法。",
            categoryIds: ["SMOKE001"],
          }),
        };
      },
    },
    fetchImpl: async (url) => {
      const href = String(url);
      if (href === pdfUrl) {
        return new Response("%PDF", {
          status: 200,
          headers: {
            "Content-Type": "application/pdf",
            "Content-Length": "38123376",
          },
        });
      }
      if (href === projectUrl || href === projectUrl.slice(0, -1)) {
        return new Response(
          `<html><head><title>Neural Monte Carlo Fluid Simulation</title></head>
           <body><p class="venue">SIGGRAPH 2024</p>
           <section class="abstract"><h2>Abstract</h2><p>A mesh-free neural fluid method with a Monte Carlo pressure solver.</p></section>
           <a href="https://dl.acm.org/doi/10.1145/3641519.3657438">ACM Library</a>
           <a href="./nmcfs.pdf">Paper</a>
           <a href="https://github.com/Pranav-Jain/Neural-Monte-Carlo-Fluid-Simulation">Code</a></body></html>`,
          { status: 200, headers: { "Content-Type": "text/html" } },
        );
      }
      if (
        /api\.crossref\.org\/works\/10\.1145%2F3641519\.3657438/u.test(
          href,
        )
      ) {
        return crossrefResponse({
          doi: "10.1145/3641519.3657438",
          title: "Neural Monte Carlo Fluid Simulation",
          institution: "University of Southern California",
          source:
            "Special Interest Group on Computer Graphics and Interactive Techniques Conference Conference Papers",
          abstract: "",
          published: [2024, 7, 13],
        });
      }
      if (href === "https://doi.org/10.1145/3641519.3657438") {
        return new Response("<html></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      throw new Error(`未预期的请求：${href}`);
    },
  });

  const result = await fixture.service.analyze({ reference: pdfUrl });

  assert.equal(result.status, "ready");
  assert.equal(result.draft.title, "Neural Monte Carlo Fluid Simulation");
  assert.equal(result.draft.source, "SIGGRAPH 2024");
  assert.equal(result.draft.pdfUrl, pdfUrl);
  assert.equal(result.draft.hasPdf, true);
  assert.equal(result.draft.originalUrl, "https://doi.org/10.1145/3641519.3657438");
  assert.equal(
    result.draft.codeUrl,
    "https://github.com/Pranav-Jain/Neural-Monte-Carlo-Fluid-Simulation",
  );
  assert.equal(result.draft.projectUrl, projectUrl.slice(0, -1));
  assert.ok(
    result.draft.identifiers.some(
      (identifier) =>
        identifier.kind === "doi" &&
        identifier.value === "10.1145/3641519.3657438",
    ),
  );
  assert.match(prompts[0], /mesh-free neural fluid method/u);
});

test("超过安全上限的普通网页仍会被拒绝", async (t) => {
  const fixture = await makeFixture(t, "oversized-html", {
    fetchImpl: async () =>
      new Response("<html></html>", {
        status: 200,
        headers: {
          "Content-Type": "text/html",
          "Content-Length": String(3 * 1_024 * 1_024),
        },
      }),
  });

  await assert.rejects(
    fixture.service.analyze({ reference: "https://papers.example/large" }),
    (error) => error?.code === "METADATA_TOO_LARGE",
  );
});

test("AI 失败时保留元数据草稿，允许人工审核后继续添加", async (t) => {
  const rawInstitution =
    "Tsinghua University, Beijing National Research Center for Information Science and Technology (BNRist), Department of Computer Science and Technology; Hong Kong University of Science and Technology";
  const fixture = await makeFixture(t, "ai-fallback", {
    fetchImpl: async () =>
      crossrefResponse({
        doi: "10.5555/9876.5432",
        institution: rawInstitution,
      }),
    aiService: {
      async generateText() {
        const error = new Error("AI 服务暂时不可用。");
        error.code = "PROVIDER_UNAVAILABLE";
        error.details = { action: "请稍后重试。" };
        throw error;
      },
    },
  });

  const result = await fixture.service.analyze({ reference: "10.5555/9876.5432" });
  assert.equal(result.status, "ready");
  assert.equal(result.draft.title, "A Test Paper");
  assert.equal(result.draft.institution, "Tsinghua University");
  assert.equal(result.metadata.institution, rawInstitution);
  assert.equal(result.draft.zhTitle, "");
  assert.equal(result.ai, null);
  assert.equal(result.aiError.code, "PROVIDER_UNAVAILABLE");
  assert.equal(result.aiError.action, "请稍后重试。");
});

test("保存接口会再次检查标识和标题，阻止并发或绕过审核造成的重复", async (t) => {
  const fixture = await makeFixture(t, "save-guard", {
    fetchImpl: async () => crossrefResponse(),
  });
  await fixture.repository.createPaper({
    title: "First Copy",
    identifiers: [{ kind: "doi", value: "10.1145/1234.5678" }],
  });

  await assert.rejects(
    fixture.repository.createPaper({
      title: "Second Copy",
      identifiers: [{ kind: "doi", value: "https://doi.org/10.1145/1234.5678" }],
    }),
    (error) => error?.code === "CONFLICT" && error.details?.duplicates?.length === 1,
  );
  assert.equal(fixture.repository.getLibrary().papers.length, 1);
});
