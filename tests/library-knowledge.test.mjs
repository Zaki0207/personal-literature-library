import assert from "node:assert/strict";
import test from "node:test";
import {
  getKnowledgeOverview,
  getKnowledgePaper,
  searchKnowledgePapers,
} from "../scripts/library-knowledge.mjs";

function library() {
  return {
    categories: [{ id: "3dv", name: "3DV", count: 3, children: [{ id: "flow", name: "流体重建", count: 3, children: [{ id: "smoke", name: "烟雾", count: 3 }] }] }],
    papers: [
      { id: "title", title: "Smoke Reconstruction", zhTitle: "烟雾重建", authors: "Alice", institution: "Aalto", source: "CVPR", date: "2024", categoryIds: ["smoke"], scopes: ["smoke", "flow", "3dv"], aiSummary: "利用物理约束重建流体。", note: "研究备忘。", favorite: true, pdfUrl: "https://arxiv.org/pdf/2401.12345", originalUrl: "https://doi.org/10.1145/1234.5678", identifiers: [{ kind: "doi", value: "10.1145/1234.5678" }], pdfArchive: { status: "ready", storageKey: "/private/secret.pdf", errorMessage: "secret-provider-key", sizeBytes: 1000 }, updatedAt: "2026-10-11T12:00:00Z", apiKey: "secret-provider-key" },
      { id: "summary", title: "Fluid Dynamics", aiSummary: "Research on smoke reconstruction.", source: "SIGGRAPH", date: "2025", categoryIds: ["flow"], scopes: ["flow", "3dv"], updatedAt: "2026-10-11T11:00:00Z" },
      { id: "note", title: "Surface Method", aiSummary: "不相关的主题。", note: "smoke reconstruction；private-only-find。", categoryIds: [], scopes: ["uncategorized"], updatedAt: "2026-10-11T10:00:00Z" },
      { id: "deleted", title: "Smoke Deleted", deletedAt: "2026-10-11" },
    ],
    backup: { localPath: "/private/library.sqlite3", aiKey: "secret-provider-key" },
  };
}

test("knowledge searches reuse aliases and rank title above summaries and notes with stable pagination", () => {
  const data = library();
  const first = searchKnowledgePapers(data, { query: "烟雾 重建", limit: 1 });
  assert.equal(first.results[0].id, "title");
  assert.equal(first.pagination.total, 3);
  assert.equal(first.pagination.nextOffset, 1);
  assert.ok(first.results[0].matchedFields.includes("title"));
  assert.ok(first.results[0].excerpts.some((item) => item.text.includes("Smoke")));
  const second = searchKnowledgePapers(data, { query: "烟雾 重建", limit: 1, offset: first.pagination.nextOffset });
  assert.equal(second.results[0].id, "summary");
  assert.ok(second.results[0].excerpts.some((item) => item.source === "ai_generated_summary"));
  const last = searchKnowledgePapers(data, { query: "烟雾 重建", limit: 1, offset: 2 });
  assert.equal(last.results[0].id, "note");
  assert.equal(last.pagination.nextOffset, null);
  assert.equal(last.results[0].excerpts[0].source, "personal_note");
  assert.deepEqual(data, library(), "search must not mutate its source");
});

test("knowledge identifies DOI, venue/year, ancestors and excludes deleted records", () => {
  const data = library();
  for (const query of ["10.1145/1234.5678", "CVPR 2024", "3DV 烟雾", "Aalto"]) {
    assert.equal(searchKnowledgePapers(data, { query }).results[0].id, "title");
  }
  assert.deepEqual(searchKnowledgePapers(data, { categoryId: "3dv" }).results.map((item) => item.id), ["summary", "title"]);
  for (const paper of data.papers) delete paper.scopes;
  assert.deepEqual(searchKnowledgePapers(data, { categoryId: "3dv" }).results.map((item) => item.id), ["summary", "title"], "ancestor filtering must also work without cached scopes");
  assert.deepEqual(searchKnowledgePapers(data, { favorite: true }).results.map((item) => item.id), ["title"]);
  assert.equal(searchKnowledgePapers(data).pagination.total, 3);
  assert.throws(() => getKnowledgePaper(data, "deleted"), { code: "KNOWLEDGE_PAPER_NOT_FOUND" });
});

test("notes scope prevents search hits and returned personal-note content, even when requested", () => {
  const data = library();
  for (const options of [{ query: "private-only-find", includeNotes: false }, { query: "private-only-find", includeNotes: true }]) {
    const result = searchKnowledgePapers(data, options, { allowNotes: false });
    assert.equal(result.results.length, 0);
    assert.equal(result.scope.personalNotes, false);
  }
  const record = getKnowledgePaper(data, "note", { includeNotes: false });
  assert.equal(Object.hasOwn(record.paper, "note"), false);
  assert.equal(Object.hasOwn(record.paper.provenance, "note"), false);
  assert.equal(JSON.stringify(record).includes("private-only-find"), false);
});

test("overview and records return allowlisted provenance without credentials or filesystem paths", () => {
  const data = library();
  const overview = getKnowledgeOverview(data);
  assert.equal(overview.counts.papers, 3);
  assert.equal(overview.categories[0].children[0].children[0].path.join(" › "), "3DV › 流体重建 › 烟雾");
  assert.equal(overview.scope.pdfFullText, false);
  assert.equal(overview.scope.triggersAiRequests, false);
  const record = getKnowledgePaper(data, "title");
  assert.equal(record.paper.provenance.aiSummary, "ai_generated_summary");
  assert.equal(record.paper.provenance.fullTextRetrieved, false);
  assert.equal(record.paper.pdf.status, "ready");
  assert.equal(record.paper.provenance.uri, "paper-library://papers/title");
  for (const result of [overview, record, searchKnowledgePapers(data)]) {
    assert.equal(JSON.stringify(result).includes("secret-provider-key"), false);
    assert.equal(JSON.stringify(result).includes("/private/"), false);
  }
});

test("search validates and bounds inputs and returns a bounded excerpt around the match", () => {
  const data = library();
  data.papers[2].note = `${"前文".repeat(500)} private-only-find ${"后文".repeat(500)}`;
  const result = searchKnowledgePapers(data, { query: "private-only-find" });
  assert.equal(result.results[0].excerpts[0].truncated, true);
  assert.ok(result.results[0].excerpts[0].text.includes("private-only-find"));
  assert.ok(result.results[0].excerpts[0].text.length <= 242);
  for (const input of [{ limit: 0 }, { limit: 51 }, { offset: -1 }, { offset: "1.5" }, { query: "a".repeat(501) }, { includeNotes: "no" }, { sql: "SELECT *" }]) {
    assert.throws(() => searchKnowledgePapers(data, input), { code: "KNOWLEDGE_INVALID_INPUT" });
  }
});
