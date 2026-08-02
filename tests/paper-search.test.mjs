import assert from "node:assert/strict";
import test from "node:test";
import {
  comparePaperSearchMatches,
  matchPaperSearch,
  normalizeSearchText,
} from "../lib/paper-search.mjs";

function paper(overrides = {}) {
  return {
    id: "paper",
    title: "A Synthetic Paper",
    zhTitle: "一篇测试论文",
    authors: "Alice Example",
    institution: "Example University",
    source: "Journal of Examples",
    date: "2024-06",
    aiSummary: "",
    note: "",
    tags: [],
    originalUrl: undefined,
    pdfUrl: undefined,
    codeProvider: undefined,
    codeUrl: undefined,
    projectProvider: undefined,
    projectUrl: undefined,
    ...overrides,
  };
}

function search(entries, query) {
  return entries
    .map(({ item, categoryNames = [] }) => ({
      item,
      match: matchPaperSearch(item, query, { categoryNames }),
    }))
    .filter(({ match }) => match.matched)
    .sort((left, right) =>
      comparePaperSearchMatches(left.match, right.match),
    );
}

test("来源名称按会议字段精确解释，不被笔记中的提及污染", () => {
  const entries = [
    {
      item: paper({ id: "cvpr-2024", source: "CVPR 2024" }),
    },
    {
      item: paper({ id: "cvpr-oral", source: "CVPR 2025（Oral）" }),
    },
    {
      item: paper({
        id: "not-cvpr",
        source: "SIGGRAPH 2024",
        note: "与 CVPR 工作进行比较。",
      }),
    },
  ];

  assert.deepEqual(
    search(entries, "ＣＶＰＲ").map(({ item }) => item.id),
    ["cvpr-2024", "cvpr-oral"],
  );
});

test("两个汉字的主题词能跨中英文标题和总结匹配", () => {
  const entries = [
    {
      item: paper({
        id: "chinese-smoke",
        zhTitle: "烟雾重建与渲染",
      }),
    },
    {
      item: paper({
        id: "english-smoke",
        title: "Neural Smoke Reconstruction",
        zhTitle: "神经体积重建",
      }),
    },
    {
      item: paper({
        id: "summary-smoke",
        aiSummary: "This work reconstructs volumetric smoke from images.",
      }),
    },
    {
      item: paper({
        id: "fog-only",
        title: "Outdoor Fog Removal",
        zhTitle: "室外雾霾去除",
      }),
    },
  ];

  assert.deepEqual(
    search(entries, "烟雾").map(({ item }) => item.id),
    ["chinese-smoke", "english-smoke", "summary-smoke"],
  );
});

test("发表年份只按 publication date 命中，不依赖来源是否包含年份", () => {
  const entry = paper({
    id: "year-only",
    source: "ACM Transactions on Graphics",
    date: "2023-07",
  });
  const match = matchPaperSearch(entry, "2023");

  assert.equal(match.matched, true);
  assert.deepEqual(match.matchedFields, ["year"]);
  assert.equal(matchPaperSearch(entry, "2024").matched, false);
});

test("多个搜索条件采用 AND 逻辑并允许跨来源、题目和年份匹配", () => {
  const smokeCvpr = paper({
    id: "smoke-cvpr",
    title: "Physics-based Smoke Reconstruction",
    source: "CVPR 2024",
    date: "2024-06",
  });
  const surfaceCvpr = paper({
    id: "surface-cvpr",
    title: "Surface Reconstruction",
    source: "CVPR 2024",
    date: "2024-06",
  });

  assert.equal(matchPaperSearch(smokeCvpr, "CVPR 烟雾 2024").matched, true);
  assert.equal(matchPaperSearch(surfaceCvpr, "CVPR 烟雾 2024").matched, false);
});

test("标题、作者、机构、总结、分类和 DOI 均可从同一入口检索", () => {
  const entry = paper({
    id: "metadata",
    title: "Divergence-Free Flow Reconstruction",
    authors: "Tero Karras; Jane Researcher",
    institution: "Aalto University",
    aiSummary: "A physics simulation method for reconstructing fluid flow.",
    originalUrl: "https://doi.org/10.1145/1234.5678",
  });
  const options = { categoryNames: ["流体重建", "物理仿真"] };

  for (const query of [
    "Divergence-Free",
    "Tero Karras",
    "Aalto",
    "physics simulation",
    "流体重建",
    "10.1145/1234.5678",
    "https://doi.org/10.1145/1234.5678",
  ]) {
    assert.equal(
      matchPaperSearch(entry, query, options).matched,
      true,
      `${query} 应命中论文`,
    );
  }
});

test("标题直接命中的排序高于总结或笔记中的弱命中", () => {
  const titleHit = paper({ id: "title", title: "Smoke Reconstruction" });
  const noteHit = paper({
    id: "note",
    title: "Unrelated Paper",
    note: "后续可以研究 smoke reconstruction。",
  });
  const titleMatch = matchPaperSearch(titleHit, "smoke reconstruction");
  const noteMatch = matchPaperSearch(noteHit, "smoke reconstruction");

  assert.equal(titleMatch.matched, true);
  assert.equal(noteMatch.matched, true);
  assert.ok(titleMatch.score > noteMatch.score);
});

test("搜索文本统一全角、大小写、标点和多余空格", () => {
  assert.equal(normalizeSearchText("  ＣＶＰＲ（2024）  "), "cvpr 2024");
  assert.equal(normalizeSearchText("ETH Zürich"), "eth zurich");
  assert.equal(
    normalizeSearchText("Gaussian—Splatting"),
    "gaussian splatting",
  );
});
