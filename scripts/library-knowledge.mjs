import { createHash } from "node:crypto";
import {
  comparePaperSearchMatches,
  matchPaperSearch,
  normalizeSearchText,
} from "../lib/paper-search.mjs";

export const KNOWLEDGE_SEARCH_LIMIT = 50;
export const KNOWLEDGE_QUERY_LIMIT = 500;

export class KnowledgeError extends Error {
  constructor(message, { code = "KNOWLEDGE_INVALID_INPUT", statusCode = 400 } = {}) {
    super(message);
    this.name = "KnowledgeError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

const string = (value) => typeof value === "string" ? value : "";
const optionalString = (value) => string(value) || undefined;

function publicLink(value) {
  try {
    const url = new URL(string(value));
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function knowledgeIncludeNotes(value, defaultValue = true) {
  if (value === undefined || value === null) return defaultValue;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new KnowledgeError("includeNotes 必须是 true 或 false。");
}

function integer(value, name, defaultValue, maximum) {
  if (value === undefined) return defaultValue;
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/u.test(value))) {
    throw new KnowledgeError(`${name} 必须是整数。`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (name === "limit" ? 1 : 0) || parsed > maximum) {
    throw new KnowledgeError(`${name} 超出允许范围。`);
  }
  return parsed;
}

export function validateKnowledgeSearch(input = {}, { allowNotes = true } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new KnowledgeError("搜索参数必须是对象。");
  }
  const allowed = ["query", "limit", "offset", "categoryId", "favorite", "watchLater", "includeNotes"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new KnowledgeError("搜索中包含不支持的参数。");
  }
  if (input.query !== undefined && typeof input.query !== "string") {
    throw new KnowledgeError("query 必须是字符串。");
  }
  const query = string(input.query).trim();
  if (query.length > KNOWLEDGE_QUERY_LIMIT) {
    throw new KnowledgeError(`query 不能超过 ${KNOWLEDGE_QUERY_LIMIT} 个字符。`);
  }
  if (input.categoryId !== undefined && (typeof input.categoryId !== "string" || !input.categoryId.trim() || input.categoryId.length > 256)) {
    throw new KnowledgeError("categoryId 必须是有效的分类 ID。");
  }
  return {
    query,
    limit: integer(input.limit, "limit", 10, KNOWLEDGE_SEARCH_LIMIT),
    offset: integer(input.offset, "offset", 0, 100_000),
    categoryId: input.categoryId,
    favorite: input.favorite === undefined ? undefined : knowledgeIncludeNotes(input.favorite),
    watchLater: input.watchLater === undefined ? undefined : knowledgeIncludeNotes(input.watchLater),
    includeNotes: knowledgeIncludeNotes(input.includeNotes) && allowNotes,
  };
}

function categoryModel(categories) {
  const records = [];
  const byId = new Map();
  function visit(nodes, path = [], ancestorIds = [], seen = new Set()) {
    for (const category of nodes ?? []) {
      if (!category || typeof category.id !== "string" || seen.has(category.id) || category.deletedAt) continue;
      seen.add(category.id);
      const names = [...path, string(category.name)];
      const record = {
        id: category.id,
        name: string(category.name),
        path: names,
        ancestorIds: [...ancestorIds],
        count: Number.isSafeInteger(category.count) ? category.count : 0,
        children: [],
      };
      byId.set(record.id, record);
      visit(category.children, names, [...ancestorIds, record.id], seen);
      record.children = (category.children ?? []).map((child) => byId.get(child.id)).filter(Boolean);
      if (!ancestorIds.length) records.push(record);
    }
  }
  visit(categories);
  return { records, byId };
}

function paperCategories(paper, model) {
  return (Array.isArray(paper.categoryIds) ? paper.categoryIds : [])
    .map((id) => model.byId.get(id))
    .filter(Boolean)
    .map(({ id, name, path }) => ({ id, name, path }));
}

function pdfStatus(paper) {
  const status = ["ready", "failed", "stale"].includes(paper.pdfArchive?.status)
    ? paper.pdfArchive.status : "not_archived";
  return {
    status,
    hasSource: Boolean(publicLink(paper.pdfUrl)),
    markedAvailable: Boolean(paper.hasPdf),
    ...(Number.isSafeInteger(paper.pdfArchive?.sizeBytes) ? { sizeBytes: paper.pdfArchive.sizeBytes } : {}),
    ...(optionalString(paper.pdfArchive?.downloadedAt) ? { downloadedAt: paper.pdfArchive.downloadedAt } : {}),
    fullTextIndexed: false,
  };
}

function provenance(paper, includeNotes) {
  return {
    paperId: string(paper.id),
    uri: `paper-library://papers/${encodeURIComponent(string(paper.id))}`,
    metadata: "library_metadata",
    aiSummary: "ai_generated_summary",
    ...(includeNotes ? { note: "personal_note" } : {}),
    pdf: "archive_status_only",
    fullTextRetrieved: false,
  };
}

function metadata(paper, model, includeNotes) {
  return {
    id: string(paper.id),
    title: string(paper.title),
    zhTitle: string(paper.zhTitle),
    authors: string(paper.authors),
    institution: string(paper.institution),
    source: string(paper.source),
    date: string(paper.date),
    categories: paperCategories(paper, model),
    identifiers: (Array.isArray(paper.identifiers) ? paper.identifiers : [])
      .filter((item) => ["doi", "arxiv", "url"].includes(item?.kind) && typeof item.value === "string")
      .filter((item) => item.kind !== "url" || publicLink(item.value))
      .map(({ kind, value }) => ({ kind, value: kind === "url" ? publicLink(value) : value })),
    ...(publicLink(paper.originalUrl) ? { originalUrl: publicLink(paper.originalUrl) } : {}),
    ...(publicLink(paper.pdfUrl) ? { pdfUrl: publicLink(paper.pdfUrl) } : {}),
    ...(publicLink(paper.codeUrl) ? { codeUrl: publicLink(paper.codeUrl) } : {}),
    ...(publicLink(paper.projectUrl) ? { projectUrl: publicLink(paper.projectUrl) } : {}),
    pdf: pdfStatus(paper),
    favorite: paper.favorite === true,
    watchLater: paper.watchLater === true,
    ...(optionalString(paper.updatedAt) ? { updatedAt: paper.updatedAt } : {}),
    provenance: provenance(paper, includeNotes),
  };
}

function scope(includeNotes) {
  return {
    metadata: true,
    aiSummaries: true,
    personalNotes: includeNotes,
    pdfFullText: false,
    searchMode: "keyword_with_aliases",
    readOnly: true,
    triggersAiRequests: false,
  };
}

function snapshotInfo(library) {
  const papers = (library.papers ?? []).filter((paper) => !paper.deletedAt);
  const timestamps = papers.map((paper) => paper.updatedAt).filter((value) => typeof value === "string").sort();
  return {
    revision: createHash("sha256")
      .update(JSON.stringify({ papers: papers.map(({ id, updatedAt }) => [id, updatedAt]), categories: library.categories ?? [] }))
      .digest("hex").slice(0, 20),
    ...(timestamps.length ? { updatedAt: timestamps.at(-1) } : {}),
  };
}

export function getKnowledgeOverview(library, { includeNotes = true } = {}) {
  const papers = (library.papers ?? []).filter((paper) => !paper.deletedAt);
  return {
    library: "我的论文库",
    ...snapshotInfo(library),
    counts: {
      papers: papers.length,
      favorites: papers.filter((paper) => paper.favorite).length,
      watchLater: papers.filter((paper) => paper.watchLater).length,
      uncategorized: papers.filter((paper) => !paper.categoryIds?.length).length,
      archivedPdfs: papers.filter((paper) => paper.pdfArchive?.status === "ready").length,
    },
    categories: categoryModel(library.categories).records,
    scope: scope(includeNotes),
    limits: { defaultResults: 10, maxResults: KNOWLEDGE_SEARCH_LIMIT, maxQueryCharacters: KNOWLEDGE_QUERY_LIMIT },
    evidence: "元数据、AI 总结与个人笔记来自本地文献库。PDF 尚未建立全文索引，不能据此声称已阅读全文。",
  };
}

function excerpt(value, query, field, maxLength = 240) {
  const raw = string(value);
  if (raw.length <= maxLength) return { text: raw, truncated: false };
  const terms = [normalizeSearchText(query), ...normalizeSearchText(query).split(" ")].filter(Boolean);
  const lower = raw.toLocaleLowerCase("zh-CN");
  const indexes = terms.map((term) => lower.indexOf(term.toLocaleLowerCase("zh-CN"))).filter((index) => index >= 0);
  if (!indexes.length && field !== "categories") {
    for (let offset = 0; offset < raw.length; offset += 120) {
      const fragment = { id: "excerpt", [field]: raw.slice(offset, offset + maxLength) };
      if (terms.some((term) => matchPaperSearch(fragment, term).matched)) {
        indexes.push(offset);
        break;
      }
    }
  }
  const start = Math.max(0, (indexes.length ? Math.min(...indexes) : 0) - 60);
  return { text: `${start ? "…" : ""}${raw.slice(start, start + maxLength)}${start + maxLength < raw.length ? "…" : ""}`, truncated: true };
}

function fieldValue(paper, field, categories) {
  if (field === "categories") return categories.map((category) => category.path.join(" › ")).join("；");
  if (field === "year") return string(paper.date);
  if (field === "identifier") return (paper.identifiers ?? []).map((item) => `${item.kind}:${item.value}`).concat([paper.originalUrl, paper.pdfUrl].filter(Boolean)).join("；");
  if (field === "resources") return [paper.codeProvider, publicLink(paper.codeUrl), paper.projectProvider, publicLink(paper.projectUrl)].filter(Boolean).join("；");
  return string(paper[field]);
}

export function searchKnowledgePapers(library, input = {}, { allowNotes = true } = {}) {
  const options = validateKnowledgeSearch(input, { allowNotes });
  const model = categoryModel(library.categories);
  const matched = (library.papers ?? [])
    .filter((paper) => !paper.deletedAt)
    .filter((paper) => options.favorite === undefined || Boolean(paper.favorite) === options.favorite)
    .filter((paper) => options.watchLater === undefined || Boolean(paper.watchLater) === options.watchLater)
    .filter((paper) => !options.categoryId || paper.categoryIds?.some((id) => id === options.categoryId || model.byId.get(id)?.ancestorIds.includes(options.categoryId)) || paper.scopes?.includes(options.categoryId))
    .map((paper) => {
      const projected = options.includeNotes ? paper : { ...paper, note: "" };
      const categories = paperCategories(paper, model);
      return {
        paper: projected,
        categories,
        match: matchPaperSearch(projected, options.query, { categoryNames: categories.flatMap((category) => [...category.path, category.path.join(" › ")]) }),
      };
    })
    .filter(({ match }) => match.matched)
    .sort((left, right) => comparePaperSearchMatches(left.match, right.match) || string(left.paper.id).localeCompare(string(right.paper.id), "en"));
  const results = matched.slice(options.offset, options.offset + options.limit).map(({ paper, categories, match }) => ({
    ...metadata(paper, model, options.includeNotes),
    matchedFields: match.matchedFields,
    score: match.score,
    excerpts: match.matchedFields.slice(0, 4).map((field) => ({
      field,
      source: field === "aiSummary" ? "ai_generated_summary" : field === "note" ? "personal_note" : "library_metadata",
      ...excerpt(fieldValue(paper, field, categories), options.query, field),
    })),
  }));
  const nextOffset = options.offset + results.length < matched.length ? options.offset + results.length : null;
  return {
    query: options.query,
    ...snapshotInfo(library),
    results,
    pagination: { total: matched.length, limit: options.limit, offset: options.offset, nextOffset },
    scope: scope(options.includeNotes),
  };
}

export function getKnowledgePaper(library, id, { includeNotes = true } = {}) {
  if (typeof id !== "string" || !id.trim() || id.length > 256) {
    throw new KnowledgeError("论文 ID 无效。");
  }
  const paper = (library.papers ?? []).find((item) => item.id === id && !item.deletedAt);
  if (!paper) throw new KnowledgeError("未找到该论文，入库状态尚未核实。", { code: "KNOWLEDGE_PAPER_NOT_FOUND", statusCode: 404 });
  return {
    paper: {
      ...metadata(paper, categoryModel(library.categories), includeNotes),
      aiSummary: string(paper.aiSummary),
      ...(includeNotes ? { note: string(paper.note) } : {}),
      ...(optionalString(paper.dateAdded) ? { dateAdded: paper.dateAdded } : {}),
    },
    scope: scope(includeNotes),
    ...snapshotInfo(library),
  };
}
