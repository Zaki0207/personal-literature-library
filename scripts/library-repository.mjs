import { randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import {
  dedupePaperIdentifiers,
  identifiersFromReference,
  normalizePaperTitle,
} from "./paper-identifiers.mjs";
import { normalizePublicationSource } from "../lib/publication-source.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_DATABASE_PATH = join(
  homedir(),
  "Library",
  "Application Support",
  "个人文献库",
  "library.sqlite3",
);

export const DEFAULT_BACKUP_DIRECTORY = join(
  homedir(),
  "Library",
  "Mobile Documents",
  "com~apple~CloudDocs",
  "个人文献库备份",
);

export const DEFAULT_SEED_PATH = resolve(
  SCRIPT_DIRECTORY,
  "..",
  "local-data",
  "library-data.json",
);

const LEGACY_INTERNAL_PAPER_STATUS = "待读";
const LEGACY_WATCH_LATER_CATEGORY_ID = "BGPSP4JY";
const WATCH_LATER_MIGRATION_ID = "legacy-watch-later-category-v1";
const AI_CONNECTIONS_MIGRATION_ID = "ai-connections-to-services-v1";
const PAPER_IDENTIFIERS_MIGRATION_ID = "paper-identifiers-normalization-v2";
const PAPER_KEYWORDS_REMOVAL_MIGRATION_ID = "remove-paper-keywords-v1";
const PAPER_SOURCES_NORMALIZATION_MIGRATION_ID =
  "normalize-paper-publication-sources-v1";
export const DEFAULT_RADAR_PROMPT =
  "请检索与我的研究方向高度相关、近期值得阅读的论文。优先推荐有明确学术来源、可核验原文链接，并说明每篇论文为什么值得我关注。";
const RADAR_ITEM_STATUSES = new Set(["pending", "added", "discarded"]);
const MAX_CATEGORY_DEPTH = 3;
const PDF_ARCHIVE_STATUSES = new Set(["ready", "failed", "stale"]);
const LEGACY_AI_BASE_URLS = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com",
};
const LEGACY_AI_NAMES = {
  openai: "OpenAI",
  deepseek: "DeepSeek",
};
const URL_FIELDS = new Set([
  "pdfUrl",
  "originalUrl",
  "codeUrl",
  "projectUrl",
]);
const PAPER_INPUT_FIELDS = new Set([
  "id",
  "zoteroKey",
  "title",
  "zhTitle",
  "authors",
  "institution",
  "source",
  "date",
  "dateAdded",
  "tags",
  "aiSummary",
  "note",
  "noteCount",
  "scopes",
  "categoryIds",
  "favorite",
  "watchLater",
  "hasPdf",
  "pdfAttachmentKey",
  "pdfUrl",
  "originalUrl",
  "codeProvider",
  "codeUrl",
  "projectProvider",
  "projectUrl",
  "createdAt",
  "updatedAt",
  "deletedAt",
  "identifiers",
]);

const PAPER_COLUMNS = {
  zoteroKey: "zotero_key",
  title: "title",
  zhTitle: "zh_title",
  authors: "authors",
  institution: "institution",
  source: "source",
  date: "publication_date",
  dateAdded: "date_added",
  aiSummary: "ai_summary",
  note: "note",
  noteCount: "note_count",
  favorite: "favorite",
  watchLater: "watch_later",
  hasPdf: "has_pdf",
  pdfAttachmentKey: "pdf_attachment_key",
  pdfUrl: "pdf_url",
  originalUrl: "original_url",
  codeProvider: "code_provider",
  codeUrl: "code_url",
  projectProvider: "project_provider",
  projectUrl: "project_url",
};

export class ValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ValidationError";
    this.statusCode = 400;
    this.code = "VALIDATION_ERROR";
    this.details = details;
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotFoundError";
    this.statusCode = 404;
    this.code = "NOT_FOUND";
  }
}

export class ConflictError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ConflictError";
    this.statusCode = 409;
    this.code = "CONFLICT";
    this.details = details;
  }
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function requiredTitle(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError("title 必须是非空字符串。", {
      field: "title",
    });
  }
  if (value.trim().length > 2_000) {
    throw new ValidationError("title 不能超过 2000 个字符。", {
      field: "title",
    });
  }
  return value.trim();
}

function validateHttpUrl(value, fieldName) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new ValidationError(`${fieldName} 必须是 http(s) URL。`, {
      field: fieldName,
    });
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Unsupported protocol");
    }
    return parsed.href;
  } catch {
    throw new ValidationError(`${fieldName} 必须是有效的 http(s) URL。`, {
      field: fieldName,
    });
  }
}

function validateString(value, fieldName, { nullable = false } = {}) {
  if (value === undefined) return undefined;
  if (value === null && nullable) return null;
  if (typeof value !== "string") {
    throw new ValidationError(`${fieldName} 必须是字符串。`, {
      field: fieldName,
    });
  }
  return value.trim();
}

function validateBoolean(value, fieldName) {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new ValidationError(`${fieldName} 必须是布尔值。`, {
      field: fieldName,
    });
  }
  return value;
}

function validateNoteCount(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError("noteCount 必须是非负整数。", {
      field: "noteCount",
    });
  }
  return value;
}

function validatePdfArchiveStatus(value) {
  if (!PDF_ARCHIVE_STATUSES.has(value)) {
    throw new ValidationError("PDF 本地归档状态无效。", {
      field: "status",
    });
  }
  return value;
}

function validatePdfStorageKey(value) {
  if (typeof value !== "string" || !/^pdf-[a-f0-9]{64}\.pdf$/u.test(value)) {
    throw new ValidationError("PDF 本地文件标识无效。", {
      field: "storageKey",
    });
  }
  return value;
}

function validatePdfSha256(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new ValidationError("PDF 文件校验值无效。", {
      field: "sha256",
    });
  }
  return value;
}

function validatePdfSize(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError("PDF 文件大小无效。", {
      field: "sizeBytes",
    });
  }
  return value;
}

function validatePdfErrorMessage(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError("PDF 下载错误信息无效。", {
      field: "errorMessage",
    });
  }
  return value.trim().slice(0, 500);
}

function validatePdfArchiveSourceUrl(value) {
  if (value === "" || value === null || value === undefined) return "";
  return validateHttpUrl(value, "sourceUrl") ?? "";
}

function pdfArchiveForClient(row) {
  if (!row) return undefined;
  return {
    status: validatePdfArchiveStatus(row.status),
    ...(row.downloadedAt ? { downloadedAt: row.downloadedAt } : {}),
    ...(row.sizeBytes !== null && row.sizeBytes !== undefined
      ? { sizeBytes: Number(row.sizeBytes) }
      : {}),
    ...(row.lastErrorCode ? { errorCode: row.lastErrorCode } : {}),
    ...(row.lastErrorMessage ? { errorMessage: row.lastErrorMessage } : {}),
  };
}

function validatePaperIdentifiers(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ValidationError("identifiers 必须是论文标识数组。", {
      field: "identifiers",
    });
  }
  if (
    value.some(
      (item) =>
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        dedupePaperIdentifiers([item]).length !== 1,
    )
  ) {
    throw new ValidationError("identifiers 中包含无效的 DOI、arXiv 或 URL。", {
      field: "identifiers",
    });
  }
  const normalized = dedupePaperIdentifiers(value);
  return normalized;
}

function validateRadarPrompt(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError("文献雷达提示词不能为空。", {
      field: "prompt",
    });
  }
  const prompt = value.trim();
  if (prompt.length > 10_000) {
    throw new ValidationError("文献雷达提示词不能超过 10000 个字符。", {
      field: "prompt",
    });
  }
  return prompt;
}

function validateRadarCount(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 30) {
    throw new ValidationError("每次推送数量必须是 1 到 30 之间的整数。", {
      field: "count",
    });
  }
  return value;
}

function validateRadarItemStatus(value) {
  if (!RADAR_ITEM_STATUSES.has(value)) {
    throw new ValidationError("文献雷达条目状态无效。", {
      field: "status",
    });
  }
  return value;
}

function validateRadarCandidate(value) {
  if (!isPlainObject(value)) {
    throw new ValidationError("文献雷达候选条目必须是对象。");
  }
  const title = requiredTitle(value.title);
  const originalUrl = validateHttpUrl(value.originalUrl, "originalUrl") ?? null;
  const pdfUrl = validateHttpUrl(value.pdfUrl, "pdfUrl") ?? null;
  const identifiers = validatePaperIdentifiers(value.identifiers ?? []);
  if (!identifiers.length) {
    throw new ValidationError("文献雷达候选条目必须包含 DOI、arXiv 或原文 URL。", {
      field: "identifiers",
    });
  }
  return {
    title,
    normalizedTitle: normalizePaperTitle(title),
    zhTitle: validateString(value.zhTitle ?? "", "zhTitle"),
    authors: validateString(value.authors ?? "", "authors"),
    institution: validateString(value.institution ?? "", "institution"),
    source: normalizePublicationSource(
      validateString(value.source ?? "", "source"),
      validateString(value.date ?? "", "date"),
      { title },
    ),
    date: validateString(value.date ?? "", "date"),
    aiSummary: validateString(value.aiSummary ?? "", "aiSummary"),
    recommendationReason: validateString(
      value.recommendationReason ?? "",
      "recommendationReason",
    ),
    originalUrl,
    pdfUrl,
    identifiers,
  };
}

function validateCategoryIds(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ValidationError("categoryIds 必须是字符串数组。", {
      field: "categoryIds",
    });
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function validatePaperId(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  ) {
    throw new ValidationError(
      "id 必须以字母或数字开头，且只能包含字母、数字、点、下划线、冒号或连字符。",
      { field: "id" },
    );
  }
  return value;
}

function validateCategoryId(value, fieldName = "id") {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  ) {
    throw new ValidationError(
      `${fieldName} 必须以字母或数字开头，且只能包含字母、数字、点、下划线、冒号或连字符。`,
      { field: fieldName },
    );
  }
  return value;
}

function validateAiEntityId(value, fieldName = "id") {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
  ) {
    throw new ValidationError(`${fieldName} 格式无效。`, {
      field: fieldName,
    });
  }
  return value;
}

function validateAiServiceName(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 100 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ValidationError("服务名称必须是 1 到 100 个字符。", {
      field: "name",
    });
  }
  return value.trim();
}

function validateAiModel(value, fieldName = "model") {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 200 ||
    /[\s\u0000-\u001f\u007f]/u.test(value.trim())
  ) {
    throw new ValidationError(
      `${fieldName} 必须是 1 到 200 个字符，且不能包含空格或控制字符。`,
      { field: fieldName },
    );
  }
  return value.trim();
}

function validateCategoryName(value) {
  const name = validateString(value, "name");
  if (!name) {
    throw new ValidationError("分类名称不能为空。", { field: "name" });
  }
  if (name.length > 100) {
    throw new ValidationError("分类名称不能超过 100 个字符。", {
      field: "name",
    });
  }
  if (name.includes("/")) {
    throw new ValidationError("分类名称不能包含“/”。", { field: "name" });
  }
  return name;
}

function validateCategoryInput(input, { creating = false } = {}) {
  if (!isPlainObject(input)) {
    throw new ValidationError("请求正文必须是 JSON 对象。");
  }
  const unknownFields = Object.keys(input).filter(
    (field) =>
      !["name", "parentId", "sidebarVisible"].includes(field),
  );
  if (unknownFields.length) {
    throw new ValidationError(
      `不支持的字段：${unknownFields.join("、")}。`,
      { fields: unknownFields },
    );
  }
  if (
    !creating &&
    !Object.hasOwn(input, "name") &&
    !Object.hasOwn(input, "parentId") &&
    !Object.hasOwn(input, "sidebarVisible")
  ) {
    throw new ValidationError(
      "至少需要提供 name、parentId 或 sidebarVisible。",
    );
  }

  const normalized = {};
  if (creating || Object.hasOwn(input, "name")) {
    normalized.name = validateCategoryName(input.name);
  }
  if (creating || Object.hasOwn(input, "parentId")) {
    normalized.parentId =
      input.parentId === undefined || input.parentId === null
        ? null
        : validateCategoryId(input.parentId, "parentId");
  }
  if (Object.hasOwn(input, "sidebarVisible")) {
    normalized.sidebarVisible = validateBoolean(
      input.sidebarVisible,
      "sidebarVisible",
    );
  } else if (creating) {
    normalized.sidebarVisible = true;
  }
  return normalized;
}

function validateCategoryReorderInput(input) {
  if (!isPlainObject(input)) {
    throw new ValidationError("请求正文必须是 JSON 对象。");
  }
  const unknownFields = Object.keys(input).filter(
    (field) => !["parentId", "orderedIds"].includes(field),
  );
  if (unknownFields.length) {
    throw new ValidationError(
      `不支持的字段：${unknownFields.join("、")}。`,
      { fields: unknownFields },
    );
  }
  if (!Object.hasOwn(input, "orderedIds")) {
    throw new ValidationError("至少需要提供 orderedIds。", {
      field: "orderedIds",
    });
  }
  if (!Array.isArray(input.orderedIds)) {
    throw new ValidationError("orderedIds 必须是分类 ID 数组。", {
      field: "orderedIds",
    });
  }

  const orderedIds = input.orderedIds.map((id) =>
    validateCategoryId(id, "orderedIds"),
  );
  if (new Set(orderedIds).size !== orderedIds.length) {
    throw new ValidationError("orderedIds 不能包含重复的分类 ID。", {
      field: "orderedIds",
    });
  }

  return {
    parentId:
      input.parentId === undefined || input.parentId === null
        ? null
        : validateCategoryId(input.parentId, "parentId"),
    orderedIds,
  };
}

function validatePaperInput(input, { creating = false } = {}) {
  if (!isPlainObject(input)) {
    throw new ValidationError("请求正文必须是 JSON 对象。");
  }

  const unknownFields = Object.keys(input).filter(
    (field) => !PAPER_INPUT_FIELDS.has(field),
  );
  if (unknownFields.length) {
    throw new ValidationError(
      `不支持的字段：${unknownFields.join("、")}。`,
      { fields: unknownFields },
    );
  }

  const normalized = {};

  if (creating || Object.hasOwn(input, "title")) {
    normalized.title = requiredTitle(input.title);
  }
  if (Object.hasOwn(input, "id")) {
    normalized.id = validatePaperId(input.id);
  }

  for (const fieldName of [
    "zoteroKey",
    "zhTitle",
    "authors",
    "institution",
    "source",
    "date",
    "dateAdded",
    "aiSummary",
    "note",
    "pdfAttachmentKey",
    "codeProvider",
    "projectProvider",
  ]) {
    if (Object.hasOwn(input, fieldName)) {
      normalized[fieldName] = validateString(input[fieldName], fieldName, {
        nullable: [
          "zoteroKey",
          "pdfAttachmentKey",
          "codeProvider",
          "projectProvider",
        ].includes(fieldName),
      });
    }
  }

  for (const fieldName of URL_FIELDS) {
    if (Object.hasOwn(input, fieldName)) {
      normalized[fieldName] = validateHttpUrl(input[fieldName], fieldName);
    }
  }

  if (Object.hasOwn(input, "identifiers")) {
    normalized.identifiers = validatePaperIdentifiers(input.identifiers);
  }
  if (Object.hasOwn(input, "noteCount")) {
    normalized.noteCount = validateNoteCount(input.noteCount);
  }
  if (Object.hasOwn(input, "favorite")) {
    normalized.favorite = validateBoolean(input.favorite, "favorite");
  }
  if (Object.hasOwn(input, "watchLater")) {
    normalized.watchLater = validateBoolean(
      input.watchLater,
      "watchLater",
    );
  }
  if (Object.hasOwn(input, "hasPdf")) {
    normalized.hasPdf = validateBoolean(input.hasPdf, "hasPdf");
  }
  if (Object.hasOwn(input, "categoryIds")) {
    normalized.categoryIds = validateCategoryIds(input.categoryIds);
  } else if (creating && Array.isArray(input.tags)) {
    normalized.categoryIds = validateCategoryIds(
      input.tags.map((tag) => tag?.scope).filter(Boolean),
    );
  }

  return normalized;
}

function seedCategoryRecords(seed) {
  if (Array.isArray(seed.categoryRecords)) return seed.categoryRecords;

  const records = [];
  let sortOrder = 0;
  const visit = (category, parentId = null) => {
    records.push({
      id: category.id,
      name: category.name,
      parentId,
      sourceKind: "seed",
      sourceKey: category.id,
      sourceParentId: parentId,
      sortOrder: sortOrder++,
      sidebarVisible: category.sidebarVisible ?? true,
    });
    for (const child of category.children ?? []) visit(child, category.id);
  };
  for (const category of seed.categories ?? []) visit(category);
  return records;
}

function sortCategoriesParentFirst(records) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const depthMemo = new Map();

  const depth = (record, seen = new Set()) => {
    if (depthMemo.has(record.id)) return depthMemo.get(record.id);
    if (!record.parentId || !byId.has(record.parentId)) return 0;
    if (seen.has(record.id)) {
      throw new ValidationError("种子分类中存在循环父子关系。");
    }
    const nextSeen = new Set(seen).add(record.id);
    const value = 1 + depth(byId.get(record.parentId), nextSeen);
    depthMemo.set(record.id, value);
    return value;
  };

  return [...records].sort(
    (left, right) =>
      depth(left) - depth(right) ||
      (left.sortOrder ?? 0) - (right.sortOrder ?? 0),
  );
}

function toNullableText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function paperInsertValues(paper, now, sortOrder) {
  const categoryIds =
    validateCategoryIds(paper.categoryIds) ??
    validateCategoryIds(
      (paper.tags ?? []).map((tag) => tag?.scope).filter(Boolean),
    ) ??
    [];
  const title = requiredTitle(paper.title);
  const date = validateString(paper.date ?? "", "date");
  const pdfUrl = validateHttpUrl(paper.pdfUrl, "pdfUrl") ?? null;

  return {
    id: validatePaperId(paper.id),
    zoteroKey: toNullableText(paper.zoteroKey),
    title,
    zhTitle: validateString(paper.zhTitle ?? "", "zhTitle"),
    authors: validateString(paper.authors ?? "", "authors"),
    institution: validateString(paper.institution ?? "", "institution"),
    source: normalizePublicationSource(
      validateString(paper.source ?? "", "source"),
      date,
      { title },
    ),
    date,
    dateAdded: validateString(paper.dateAdded ?? now, "dateAdded"),
    status: LEGACY_INTERNAL_PAPER_STATUS,
    aiSummary: validateString(paper.aiSummary ?? "", "aiSummary"),
    note: validateString(paper.note ?? "", "note"),
    noteCount: validateNoteCount(paper.noteCount ?? null),
    favorite: validateBoolean(paper.favorite ?? false, "favorite"),
    watchLater: validateBoolean(
      paper.watchLater ?? false,
      "watchLater",
    ),
    hasPdf: Boolean(validateBoolean(paper.hasPdf ?? false, "hasPdf") || pdfUrl),
    pdfAttachmentKey: toNullableText(paper.pdfAttachmentKey),
    pdfUrl,
    originalUrl: validateHttpUrl(paper.originalUrl, "originalUrl") ?? null,
    codeProvider: toNullableText(paper.codeProvider),
    codeUrl: validateHttpUrl(paper.codeUrl, "codeUrl") ?? null,
    projectProvider: toNullableText(paper.projectProvider),
    projectUrl: validateHttpUrl(paper.projectUrl, "projectUrl") ?? null,
    identifiers: validatePaperIdentifiers(paper.identifiers ?? []),
    categoryIds,
    createdAt: now,
    updatedAt: now,
    sortOrder,
  };
}

function sqliteBoolean(value) {
  return value ? 1 : 0;
}

function isoFileTimestamp(date) {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function backupStatusMessage(error) {
  const detail =
    error instanceof Error && error.message
      ? error.message
      : "未知文件系统错误";
  return `本地修改已保存，但 iCloud 备份失败：${detail}`;
}

export class LibraryRepository {
  constructor({
    dbPath = DEFAULT_DATABASE_PATH,
    backupDir = DEFAULT_BACKUP_DIRECTORY,
    seedPath = DEFAULT_SEED_PATH,
    now = () => new Date(),
  } = {}) {
    this.dbPath = resolve(dbPath);
    this.backupDir = resolve(backupDir);
    this.seedPath = seedPath ? resolve(seedPath) : null;
    this.now = now;
    this.closed = false;
    this.mutationQueue = Promise.resolve();
    this.backupStatus = { ok: true };
    this.schemaMigrated = false;

    mkdirSync(dirname(this.dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.dbPath);
    this.#configureDatabase();
    this.#createSchema();
    this.seededOnOpen = this.#seedIfEmpty();
    this.#migrateLegacyWatchLaterCategory();
    this.#backfillPaperIdentifiers();
  }

  async initializeBackupStatus() {
    try {
      const latestPath = join(this.backupDir, "library-latest.sqlite3");
      const latest = await stat(latestPath);
      await this.#verifyDatabaseFile(latestPath);
      this.backupStatus = {
        ok: true,
        lastBackupAt: latest.mtime.toISOString(),
      };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.backupStatus = {
          ok: false,
          message: `无法读取 iCloud 备份状态：${error.message}`,
        };
      }
    }
    if (this.seededOnOpen || this.schemaMigrated) {
      await this.#createBackup();
    }
    return this;
  }

  #configureDatabase() {
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = DELETE");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("PRAGMA busy_timeout = 5000");
  }

  #createSchema() {
    const hadMigrationTable = Boolean(
      this.db
        .prepare(
          `SELECT 1
           FROM sqlite_master
           WHERE type = 'table' AND name = 'repository_migrations'`,
        )
        .get(),
    );
    const hadAiConnectionsTable = Boolean(
      this.db
        .prepare(
          `SELECT 1
           FROM sqlite_master
           WHERE type = 'table' AND name = 'ai_connections'`,
        )
        .get(),
    );
    const hadAiServicesTable = Boolean(
      this.db
        .prepare(
          `SELECT 1
           FROM sqlite_master
           WHERE type = 'table' AND name = 'ai_services'`,
        )
        .get(),
    );
    const hadAiModelsTable = Boolean(
      this.db
        .prepare(
          `SELECT 1
           FROM sqlite_master
           WHERE type = 'table' AND name = 'ai_models'`,
        )
        .get(),
    );
    const hadPaperIdentifiersTable = Boolean(
      this.db
        .prepare(
          `SELECT 1
           FROM sqlite_master
           WHERE type = 'table' AND name = 'paper_identifiers'`,
        )
        .get(),
    );
    const hadPaperPdfArchivesTable = Boolean(
      this.db
        .prepare(
          `SELECT 1
           FROM sqlite_master
           WHERE type = 'table' AND name = 'paper_pdf_archives'`,
        )
        .get(),
    );
    const hadRadarSettingsTable = Boolean(
      this.db
        .prepare(
          `SELECT 1
           FROM sqlite_master
           WHERE type = 'table' AND name = 'radar_settings'`,
        )
        .get(),
    );
    const hadRadarItemsTable = Boolean(
      this.db
        .prepare(
          `SELECT 1
           FROM sqlite_master
           WHERE type = 'table' AND name = 'radar_items'`,
        )
        .get(),
    );
    const legacyAiConnectionColumns = hadAiConnectionsTable
      ? this.db
          .prepare("PRAGMA table_info(ai_connections)")
          .all()
          .map((column) => column.name)
      : [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_id TEXT REFERENCES categories(id) ON DELETE RESTRICT,
        source_kind TEXT NOT NULL DEFAULT 'local',
        source_key TEXT,
        source_parent_id TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        sidebar_visible INTEGER NOT NULL DEFAULT 1
          CHECK (sidebar_visible IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS categories_parent_order_idx
        ON categories(parent_id, sort_order, id);

      CREATE TABLE IF NOT EXISTS papers (
        id TEXT PRIMARY KEY,
        zotero_key TEXT,
        title TEXT NOT NULL,
        zh_title TEXT NOT NULL DEFAULT '',
        authors TEXT NOT NULL DEFAULT '',
        institution TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        publication_date TEXT NOT NULL DEFAULT '',
        date_added TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('待读', '在读', '已读')),
        ai_summary TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        note_count INTEGER CHECK (note_count IS NULL OR note_count >= 0),
        favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
        watch_later INTEGER NOT NULL DEFAULT 0
          CHECK (watch_later IN (0, 1)),
        has_pdf INTEGER NOT NULL DEFAULT 0 CHECK (has_pdf IN (0, 1)),
        pdf_attachment_key TEXT,
        pdf_url TEXT,
        original_url TEXT,
        code_provider TEXT,
        code_url TEXT,
        project_provider TEXT,
        project_url TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS papers_active_order_idx
        ON papers(deleted_at, sort_order, id);

      CREATE TABLE IF NOT EXISTS paper_categories (
        paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (paper_id, category_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS paper_categories_category_idx
        ON paper_categories(category_id, paper_id);

      CREATE TABLE IF NOT EXISTS paper_identifiers (
        paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('doi', 'arxiv', 'url')),
        normalized_value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (paper_id, kind, normalized_value)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS paper_identifiers_lookup_idx
        ON paper_identifiers(kind, normalized_value, paper_id);

      CREATE TABLE IF NOT EXISTS paper_pdf_archives (
        paper_id TEXT PRIMARY KEY
          REFERENCES papers(id) ON DELETE CASCADE,
        status TEXT NOT NULL
          CHECK (status IN ('ready', 'failed', 'stale')),
        source_url TEXT NOT NULL DEFAULT '',
        storage_key TEXT,
        sha256 TEXT,
        size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes > 0),
        downloaded_at TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        updated_at TEXT NOT NULL,
        CHECK (
          status <> 'ready'
          OR (
            storage_key IS NOT NULL
            AND sha256 IS NOT NULL
            AND size_bytes IS NOT NULL
            AND downloaded_at IS NOT NULL
          )
        )
      ) STRICT;

      CREATE INDEX IF NOT EXISTS paper_pdf_archives_status_idx
        ON paper_pdf_archives(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS repository_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}'
      ) STRICT;

      CREATE TABLE IF NOT EXISTS ai_services (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        credential_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS ai_services_base_url_idx
        ON ai_services(base_url);

      CREATE TABLE IF NOT EXISTS ai_models (
        id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL
          REFERENCES ai_services(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        resolved_model TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
        verified_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(service_id, model)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS ai_models_service_idx
        ON ai_models(service_id, verified_at DESC, id);

      CREATE UNIQUE INDEX IF NOT EXISTS ai_models_one_active_idx
        ON ai_models(active)
        WHERE active = 1;

      CREATE TABLE IF NOT EXISTS radar_settings (
        id TEXT PRIMARY KEY CHECK (id = 'default'),
        prompt TEXT NOT NULL,
        requested_count INTEGER NOT NULL
          CHECK (requested_count BETWEEN 1 AND 30),
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS radar_items (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        normalized_title TEXT NOT NULL,
        zh_title TEXT NOT NULL DEFAULT '',
        authors TEXT NOT NULL DEFAULT '',
        institution TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        publication_date TEXT NOT NULL DEFAULT '',
        ai_summary TEXT NOT NULL DEFAULT '',
        recommendation_reason TEXT NOT NULL DEFAULT '',
        original_url TEXT,
        pdf_url TEXT,
        status TEXT NOT NULL
          CHECK (status IN ('pending', 'added', 'discarded')),
        added_paper_id TEXT REFERENCES papers(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS radar_items_title_idx
        ON radar_items(normalized_title);

      CREATE INDEX IF NOT EXISTS radar_items_status_updated_idx
        ON radar_items(status, updated_at DESC, id);

      CREATE TABLE IF NOT EXISTS radar_item_identifiers (
        item_id TEXT NOT NULL REFERENCES radar_items(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('doi', 'arxiv', 'url')),
        normalized_value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (item_id, kind, normalized_value),
        UNIQUE (kind, normalized_value)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS radar_item_identifiers_lookup_idx
        ON radar_item_identifiers(kind, normalized_value, item_id);
      `);

      this.db
        .prepare(
          `INSERT OR IGNORE INTO radar_settings (
             id, prompt, requested_count, updated_at
           ) VALUES ('default', ?, 5, ?)`,
        )
        .run(DEFAULT_RADAR_PROMPT, this.now().toISOString());

      const categoryColumns = this.db
        .prepare("PRAGMA table_info(categories)")
        .all()
        .map((column) => column.name);
      const paperColumns = this.db
        .prepare("PRAGMA table_info(papers)")
        .all()
        .map((column) => column.name);
      const alterations = [];
      if (!categoryColumns.includes("deleted_at")) {
        alterations.push(
          "ALTER TABLE categories ADD COLUMN deleted_at TEXT",
        );
      }
      if (!categoryColumns.includes("sidebar_visible")) {
        alterations.push(
          `ALTER TABLE categories
           ADD COLUMN sidebar_visible INTEGER NOT NULL DEFAULT 1
             CHECK (sidebar_visible IN (0, 1))`,
        );
      }
      if (!paperColumns.includes("watch_later")) {
        alterations.push(
          `ALTER TABLE papers
           ADD COLUMN watch_later INTEGER NOT NULL DEFAULT 0
             CHECK (watch_later IN (0, 1))`,
        );
      }
      const removedKeywords = paperColumns.includes("keywords_json");
      if (removedKeywords) {
        alterations.push("ALTER TABLE papers DROP COLUMN keywords_json");
      }
      for (const statement of alterations) this.db.exec(statement);
      if (alterations.length) this.schemaMigrated = true;
      if (removedKeywords) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO repository_migrations (
               id, applied_at, details_json
             ) VALUES (?, ?, ?)`,
          )
          .run(
            PAPER_KEYWORDS_REMOVAL_MIGRATION_ID,
            this.now().toISOString(),
            JSON.stringify({ removedColumn: "keywords_json" }),
          );
      }

      const paperSourcesMigrationApplied = Boolean(
        this.db
          .prepare("SELECT 1 FROM repository_migrations WHERE id = ?")
          .get(PAPER_SOURCES_NORMALIZATION_MIGRATION_ID),
      );
      if (!paperSourcesMigrationApplied) {
        const papers = this.db
          .prepare(
            `SELECT id, title, source, publication_date AS date
             FROM papers`,
          )
          .all();
        const updateSource = this.db.prepare(
          "UPDATE papers SET source = ?, updated_at = ? WHERE id = ?",
        );
        const appliedAt = this.now().toISOString();
        let updatedPapers = 0;
        for (const paper of papers) {
          const source = normalizePublicationSource(paper.source, paper.date, {
            title: paper.title,
          });
          if (source === paper.source) continue;
          updateSource.run(source, appliedAt, paper.id);
          updatedPapers += 1;
        }
        this.db
          .prepare(
            `INSERT INTO repository_migrations (
               id, applied_at, details_json
             ) VALUES (?, ?, ?)`,
          )
          .run(
            PAPER_SOURCES_NORMALIZATION_MIGRATION_ID,
            appliedAt,
            JSON.stringify({ updatedPapers }),
          );
        if (updatedPapers) this.schemaMigrated = true;
      }

      const aiConnectionsMigrationApplied = Boolean(
        this.db
          .prepare("SELECT 1 FROM repository_migrations WHERE id = ?")
          .get(AI_CONNECTIONS_MIGRATION_ID),
      );
      if (hadAiConnectionsTable && !aiConnectionsMigrationApplied) {
        const baseUrlExpression = legacyAiConnectionColumns.includes(
          "base_url",
        )
          ? "base_url"
          : "''";
        const legacyConnections = this.db
          .prepare(
            `SELECT provider, model, ${baseUrlExpression} AS baseUrl,
                    resolved_model AS resolvedModel, active,
                    verified_at AS verifiedAt,
                    created_at AS createdAt, updated_at AS updatedAt
             FROM ai_connections
             ORDER BY provider`,
          )
          .all();
        for (const connection of legacyConnections) {
          const baseUrl =
            connection.baseUrl ||
            LEGACY_AI_BASE_URLS[connection.provider] ||
            "https://api.openai.com/v1";
          this.db
            .prepare(
              `INSERT OR IGNORE INTO ai_services (
                 id, name, base_url, credential_key, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(
              connection.provider,
              LEGACY_AI_NAMES[connection.provider] || connection.provider,
              baseUrl,
              connection.provider,
              connection.createdAt,
              connection.updatedAt,
            );
          this.db
            .prepare(
              `INSERT OR IGNORE INTO ai_models (
                 id, service_id, model, resolved_model, active,
                 verified_at, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              randomUUID(),
              connection.provider,
              connection.model,
              connection.resolvedModel,
              connection.active,
              connection.verifiedAt,
              connection.createdAt,
              connection.updatedAt,
            );
        }
        this.db
          .prepare(
            `INSERT INTO repository_migrations (id, applied_at, details_json)
             VALUES (?, ?, ?)`,
          )
          .run(
            AI_CONNECTIONS_MIGRATION_ID,
            this.now().toISOString(),
            JSON.stringify({ migratedConnections: legacyConnections.length }),
          );
        this.schemaMigrated = true;
      }
      const normalizedChildren = this.db
        .prepare(
          `UPDATE categories
           SET sidebar_visible = 1, updated_at = ?
           WHERE parent_id IS NOT NULL AND sidebar_visible <> 1`,
        )
        .run(this.now().toISOString());
      if (normalizedChildren.changes) this.schemaMigrated = true;
      if (!hadMigrationTable) this.schemaMigrated = true;
      if (!hadAiServicesTable || !hadAiModelsTable) {
        this.schemaMigrated = true;
      }
      if (!hadPaperIdentifiersTable) this.schemaMigrated = true;
      if (!hadPaperPdfArchivesTable) this.schemaMigrated = true;
      if (!hadRadarSettingsTable || !hadRadarItemsTable) {
        this.schemaMigrated = true;
      }
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS categories_active_parent_order_idx
          ON categories(deleted_at, parent_id, sort_order, id)
      `);
      this.db.exec("COMMIT");
      this.db.exec("PRAGMA optimize");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  #seedIfEmpty() {
    const paperCount = Number(
      this.db.prepare("SELECT COUNT(*) AS count FROM papers").get().count,
    );
    const categoryCount = Number(
      this.db.prepare("SELECT COUNT(*) AS count FROM categories").get().count,
    );
    if (
      paperCount ||
      categoryCount ||
      !this.seedPath ||
      !existsSync(this.seedPath)
    ) {
      return false;
    }

    const seed = JSON.parse(readFileSync(this.seedPath, "utf8"));
    const categories = sortCategoriesParentFirst(seedCategoryRecords(seed));
    const now = this.now().toISOString();
    const insertCategory = this.db.prepare(`
      INSERT INTO categories (
        id, name, parent_id, source_kind, source_key, source_parent_id,
        sort_order, sidebar_visible, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertPaper = this.db.prepare(`
      INSERT INTO papers (
        id, zotero_key, title, zh_title, authors, institution, source,
        publication_date, date_added, status, ai_summary, note,
        note_count, favorite, watch_later, has_pdf, pdf_attachment_key, pdf_url,
        original_url, code_provider, code_url, project_provider, project_url,
        sort_order, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);
    const insertPaperCategory = this.db.prepare(`
      INSERT INTO paper_categories (paper_id, category_id, sort_order)
      VALUES (?, ?, ?)
    `);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [index, category] of categories.entries()) {
        const id = validatePaperId(category.id);
        const name = validateString(category.name, "category.name");
        if (!name) {
          throw new ValidationError("种子分类名称不能为空。");
        }
        const sidebarVisible = validateBoolean(
          category.sidebarVisible ?? true,
          "category.sidebarVisible",
        );
        insertCategory.run(
          id,
          name,
          category.parentId ?? null,
          category.sourceKind ?? "seed",
          category.sourceKey ?? id,
          category.sourceParentId ?? category.parentId ?? null,
          Number.isSafeInteger(category.sortOrder)
            ? category.sortOrder
            : index,
          sqliteBoolean(
            category.parentId === null ||
              category.parentId === undefined
              ? sidebarVisible
              : true,
          ),
          now,
          now,
        );
      }

      const categoryIds = new Set(categories.map((category) => category.id));
      for (const [index, rawPaper] of (seed.papers ?? []).entries()) {
        const paper = paperInsertValues(rawPaper, now, index);
        insertPaper.run(
          paper.id,
          paper.zoteroKey,
          paper.title,
          paper.zhTitle,
          paper.authors,
          paper.institution,
          paper.source,
          paper.date,
          paper.dateAdded,
          paper.status,
          paper.aiSummary,
          paper.note,
          paper.noteCount,
          sqliteBoolean(paper.favorite),
          sqliteBoolean(paper.watchLater),
          sqliteBoolean(paper.hasPdf),
          paper.pdfAttachmentKey,
          paper.pdfUrl,
          paper.originalUrl,
          paper.codeProvider,
          paper.codeUrl,
          paper.projectProvider,
          paper.projectUrl,
          paper.sortOrder,
          paper.createdAt,
          paper.updatedAt,
        );

        for (const [categoryOrder, categoryId] of paper.categoryIds.entries()) {
          if (!categoryIds.has(categoryId)) {
            throw new ValidationError(
              `论文 ${paper.id} 引用了不存在的分类 ${categoryId}。`,
            );
          }
          insertPaperCategory.run(paper.id, categoryId, categoryOrder);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return true;
  }

  #backfillPaperIdentifiers() {
    const applied = this.db
      .prepare("SELECT 1 FROM repository_migrations WHERE id = ?")
      .get(PAPER_IDENTIFIERS_MIGRATION_ID);
    if (applied) return;

    const papers = this.db
      .prepare(
        `SELECT id, original_url AS originalUrl, pdf_url AS pdfUrl
         FROM papers`,
      )
      .all();
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO paper_identifiers (
         paper_id, kind, normalized_value, created_at
       ) VALUES (?, ?, ?, ?)`,
    );
    const now = this.now().toISOString();
    let identifierCount = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM paper_identifiers").run();
      for (const paper of papers) {
        const identifiers = dedupePaperIdentifiers([
          ...identifiersFromReference(paper.originalUrl ?? ""),
          ...identifiersFromReference(paper.pdfUrl ?? ""),
        ]);
        for (const identifier of identifiers) {
          identifierCount += Number(
            insert.run(
              paper.id,
              identifier.kind,
              identifier.value,
              now,
            ).changes,
          );
        }
      }
      this.db
        .prepare(
          `INSERT INTO repository_migrations (id, applied_at, details_json)
           VALUES (?, ?, ?)`,
        )
        .run(
          PAPER_IDENTIFIERS_MIGRATION_ID,
          now,
          JSON.stringify({ papers: papers.length, identifiers: identifierCount }),
        );
      this.db.exec("COMMIT");
      this.schemaMigrated = true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  #migrateLegacyWatchLaterCategory() {
    const alreadyApplied = this.db
      .prepare("SELECT 1 FROM repository_migrations WHERE id = ?")
      .get(WATCH_LATER_MIGRATION_ID);
    if (alreadyApplied) return false;

    const legacyCategories = this.db
      .prepare(
        `SELECT
          id,
          name,
          parent_id AS parentId,
          source_kind AS sourceKind,
          source_key AS sourceKey,
          source_parent_id AS sourceParentId,
          sort_order AS sortOrder,
          sidebar_visible AS sidebarVisible,
          created_at AS createdAt,
          updated_at AS updatedAt,
          deleted_at AS deletedAt
         FROM categories
         WHERE parent_id IS NULL
           AND name = '待看'
           AND (
             id = ?
             OR source_kind IN ('zotero', 'seed')
           )
         ORDER BY sort_order, id`,
      )
      .all(LEGACY_WATCH_LATER_CATEGORY_ID);
    const categoryIds = legacyCategories.map((category) => category.id);
    const categoryIdSet = new Set(categoryIds);
    const links = categoryIds.length
      ? this.db
          .prepare(
            `SELECT
              pc.paper_id AS paperId,
              pc.category_id AS categoryId,
              pc.sort_order AS sortOrder
             FROM paper_categories pc
             WHERE pc.category_id IN (
               SELECT id
               FROM categories
               WHERE parent_id IS NULL
                 AND name = '待看'
                 AND (
                   id = ?
                   OR source_kind IN ('zotero', 'seed')
                 )
             )
             ORDER BY pc.category_id, pc.sort_order, pc.paper_id`,
          )
          .all(LEGACY_WATCH_LATER_CATEGORY_ID)
      : [];
    const children = categoryIds.length
      ? this.db
          .prepare(
            `SELECT id, parent_id AS parentId, sort_order AS sortOrder
             FROM categories
             WHERE parent_id IN (
               SELECT id
               FROM categories
               WHERE parent_id IS NULL
                 AND name = '待看'
                 AND (
                   id = ?
                   OR source_kind IN ('zotero', 'seed')
                 )
             )
             ORDER BY sort_order, id`,
          )
          .all(LEGACY_WATCH_LATER_CATEGORY_ID)
      : [];
    const migratedPaperIds = [
      ...new Set(links.map((link) => link.paperId)),
    ];
    const appliedAt = this.now().toISOString();
    const details = {
      legacyCategories,
      migratedPaperIds,
      removedLinks: links,
      reparentedChildren: children,
    };

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const markPaper = this.db.prepare(
        `UPDATE papers
         SET watch_later = 1, updated_at = ?
         WHERE id IN (
           SELECT paper_id
           FROM paper_categories
           WHERE category_id = ?
         )`,
      );
      const reparentChild = this.db.prepare(
        `UPDATE categories
         SET parent_id = NULL, updated_at = ?
         WHERE id = ? AND parent_id = ?`,
      );
      const removeLinks = this.db.prepare(
        "DELETE FROM paper_categories WHERE category_id = ?",
      );
      const removeCategory = this.db.prepare(
        "DELETE FROM categories WHERE id = ?",
      );

      for (const categoryId of categoryIds) {
        markPaper.run(appliedAt, categoryId);
        for (const child of children) {
          if (
            child.parentId === categoryId &&
            !categoryIdSet.has(child.id)
          ) {
            reparentChild.run(appliedAt, child.id, categoryId);
          }
        }
        removeLinks.run(categoryId);
        removeCategory.run(categoryId);
      }
      this.db
        .prepare(
          `INSERT INTO repository_migrations (
            id, applied_at, details_json
          ) VALUES (?, ?, ?)`,
        )
        .run(
          WATCH_LATER_MIGRATION_ID,
          appliedAt,
          JSON.stringify(details),
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.schemaMigrated = true;
    return true;
  }

  #assertOpen() {
    if (this.closed) throw new Error("LibraryRepository 已关闭。");
  }

  #categoryRows({ includeDeleted = false } = {}) {
    return this.db
      .prepare(
        `SELECT
          id,
          name,
          parent_id AS parentId,
          source_kind AS sourceKind,
          source_key AS sourceKey,
          source_parent_id AS sourceParentId,
          sort_order AS sortOrder,
          sidebar_visible AS sidebarVisible,
          created_at AS createdAt,
          updated_at AS updatedAt,
          deleted_at AS deletedAt
        FROM categories
        ${includeDeleted ? "" : "WHERE deleted_at IS NULL"}
        ORDER BY sort_order, id`,
      )
      .all();
  }

  #categoryModel({ includeDeleted = false } = {}) {
    const rows = this.#categoryRows({ includeDeleted });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ancestorMemo = new Map();

    const ancestorsFor = (categoryId) => {
      if (ancestorMemo.has(categoryId)) {
        return ancestorMemo.get(categoryId);
      }
      const ancestors = [];
      const seen = new Set([categoryId]);
      let parentId = byId.get(categoryId)?.parentId;
      while (parentId && byId.has(parentId) && !seen.has(parentId)) {
        ancestors.push(parentId);
        seen.add(parentId);
        parentId = byId.get(parentId)?.parentId;
      }
      ancestorMemo.set(categoryId, ancestors);
      return ancestors;
    };

    return { rows, byId, ancestorsFor };
  }

  #directCategoriesByPaper() {
    const rows = this.db
      .prepare(
        `SELECT
          pc.paper_id AS paperId,
          c.id,
          c.name
        FROM paper_categories pc
        JOIN categories c ON c.id = pc.category_id
        WHERE c.deleted_at IS NULL
        ORDER BY pc.paper_id, pc.sort_order, c.sort_order, c.id`,
      )
      .all();
    const byPaper = new Map();
    for (const row of rows) {
      const values = byPaper.get(row.paperId) ?? [];
      values.push({ id: row.id, name: row.name });
      byPaper.set(row.paperId, values);
    }
    return byPaper;
  }

  #identifiersByPaper() {
    const rows = this.db
      .prepare(
        `SELECT paper_id AS paperId, kind, normalized_value AS value
         FROM paper_identifiers
         ORDER BY paper_id, kind, normalized_value`,
      )
      .all();
    const byPaper = new Map();
    for (const row of rows) {
      const identifiers = byPaper.get(row.paperId) ?? [];
      identifiers.push({ kind: row.kind, value: row.value });
      byPaper.set(row.paperId, identifiers);
    }
    return byPaper;
  }

  #pdfArchivesByPaper() {
    const rows = this.db
      .prepare(
        `SELECT
           paper_id AS paperId,
           status,
           source_url AS sourceUrl,
           storage_key AS storageKey,
           sha256,
           size_bytes AS sizeBytes,
           downloaded_at AS downloadedAt,
           last_error_code AS lastErrorCode,
           last_error_message AS lastErrorMessage,
           updated_at AS updatedAt
         FROM paper_pdf_archives`,
      )
      .all();
    return new Map(rows.map((row) => [row.paperId, pdfArchiveForClient(row)]));
  }

  #paperFromRow(
    row,
    directCategories,
    categoryModel,
    identifiers = [],
    pdfArchive,
  ) {
    const tags = directCategories.map((category) => ({
      label: category.name,
      scope: category.id,
    }));
    const scopes = [];
    const seenScopes = new Set();
    for (const category of directCategories) {
      for (const scope of [
        category.id,
        ...categoryModel.ancestorsFor(category.id),
      ]) {
        if (!seenScopes.has(scope)) {
          seenScopes.add(scope);
          scopes.push(scope);
        }
      }
    }
    if (!scopes.length) scopes.push("uncategorized");

    return {
      id: row.id,
      ...(row.zoteroKey ? { zoteroKey: row.zoteroKey } : {}),
      title: row.title,
      zhTitle: row.zhTitle,
      authors: row.authors,
      institution: row.institution,
      source: row.source,
      date: row.date,
      dateAdded: row.dateAdded,
      tags,
      aiSummary: row.aiSummary,
      note: row.note,
      ...(row.noteCount !== null ? { noteCount: row.noteCount } : {}),
      scopes,
      categoryIds: directCategories.map((category) => category.id),
      favorite: Boolean(row.favorite),
      watchLater: Boolean(row.watchLater),
      hasPdf: Boolean(row.hasPdf),
      ...(pdfArchive ? { pdfArchive } : {}),
      ...(row.pdfAttachmentKey
        ? { pdfAttachmentKey: row.pdfAttachmentKey }
        : {}),
      ...(row.pdfUrl ? { pdfUrl: row.pdfUrl } : {}),
      ...(row.originalUrl ? { originalUrl: row.originalUrl } : {}),
      ...(row.codeProvider ? { codeProvider: row.codeProvider } : {}),
      ...(row.codeUrl ? { codeUrl: row.codeUrl } : {}),
      ...(row.projectProvider
        ? { projectProvider: row.projectProvider }
        : {}),
      ...(row.projectUrl ? { projectUrl: row.projectUrl } : {}),
      identifiers,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.deletedAt ? { deletedAt: row.deletedAt } : {}),
    };
  }

  #paperRows({ includeDeleted = false, id } = {}) {
    const conditions = [];
    const parameters = [];
    if (!includeDeleted) conditions.push("deleted_at IS NULL");
    if (id !== undefined) {
      conditions.push("id = ?");
      parameters.push(id);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.db
      .prepare(
        `SELECT
          id,
          zotero_key AS zoteroKey,
          title,
          zh_title AS zhTitle,
          authors,
          institution,
          source,
          publication_date AS date,
          date_added AS dateAdded,
          ai_summary AS aiSummary,
          note,
          note_count AS noteCount,
          favorite,
          watch_later AS watchLater,
          has_pdf AS hasPdf,
          pdf_attachment_key AS pdfAttachmentKey,
          pdf_url AS pdfUrl,
          original_url AS originalUrl,
          code_provider AS codeProvider,
          code_url AS codeUrl,
          project_provider AS projectProvider,
          project_url AS projectUrl,
          created_at AS createdAt,
          updated_at AS updatedAt,
          deleted_at AS deletedAt
        FROM papers
        ${where}
        ORDER BY sort_order, id`,
      )
      .all(...parameters);
  }

  #papers({ includeDeleted = false, id } = {}) {
    const categoryModel = this.#categoryModel();
    const directByPaper = this.#directCategoriesByPaper();
    const identifiersByPaper = this.#identifiersByPaper();
    const pdfArchivesByPaper = this.#pdfArchivesByPaper();
    return this.#paperRows({ includeDeleted, id }).map((row) =>
      this.#paperFromRow(
        row,
        directByPaper.get(row.id) ?? [],
        categoryModel,
        identifiersByPaper.get(row.id) ?? [],
        pdfArchivesByPaper.get(row.id),
      ),
    );
  }

  #categories(papers) {
    const model = this.#categoryModel();
    const countFor = (categoryId) =>
      papers.reduce(
        (count, paper) => count + Number(paper.scopes.includes(categoryId)),
        0,
      );
    const childrenByParent = new Map();
    for (const category of model.rows) {
      const parentId = category.parentId ?? null;
      const children = childrenByParent.get(parentId) ?? [];
      children.push(category);
      childrenByParent.set(parentId, children);
    }
    const project = (category) => {
      const children = (childrenByParent.get(category.id) ?? []).map(
        project,
      );
      return {
        id: category.id,
        name: category.name,
        count: countFor(category.id),
        ancestorIds: model.ancestorsFor(category.id),
        sidebarVisible:
          category.parentId === null
            ? Boolean(category.sidebarVisible)
            : true,
        ...(children.length ? { children } : {}),
      };
    };
    return (childrenByParent.get(null) ?? []).map(project);
  }

  #radarIdentifiersByItem() {
    const byItem = new Map();
    const rows = this.db
      .prepare(
        `SELECT item_id AS itemId, kind, normalized_value AS value
         FROM radar_item_identifiers
         ORDER BY item_id, kind, normalized_value`,
      )
      .all();
    for (const row of rows) {
      const identifiers = byItem.get(row.itemId) ?? [];
      identifiers.push({ kind: row.kind, value: row.value });
      byItem.set(row.itemId, identifiers);
    }
    return byItem;
  }

  #radarItemFromRow(row, identifiers = []) {
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      zhTitle: row.zhTitle,
      authors: row.authors,
      institution: row.institution,
      source: row.source,
      date: row.date,
      aiSummary: row.aiSummary,
      recommendationReason: row.recommendationReason,
      ...(row.originalUrl ? { originalUrl: row.originalUrl } : {}),
      ...(row.pdfUrl ? { pdfUrl: row.pdfUrl } : {}),
      identifiers,
      status: validateRadarItemStatus(row.status),
      ...(row.addedPaperId ? { addedPaperId: row.addedPaperId } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  #radarItems({ status, id } = {}) {
    const clauses = [];
    const parameters = [];
    if (status) {
      clauses.push("status = ?");
      parameters.push(validateRadarItemStatus(status));
    }
    if (id) {
      clauses.push("id = ?");
      parameters.push(validateAiEntityId(id, "id"));
    }
    const rows = this.db
      .prepare(
        `SELECT id, title, zh_title AS zhTitle, authors, institution, source,
                publication_date AS date, ai_summary AS aiSummary,
                recommendation_reason AS recommendationReason,
                original_url AS originalUrl, pdf_url AS pdfUrl, status,
                added_paper_id AS addedPaperId, created_at AS createdAt,
                updated_at AS updatedAt
         FROM radar_items
         ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY updated_at DESC, id`,
      )
      .all(...parameters);
    const identifiersByItem = this.#radarIdentifiersByItem();
    return rows.map((row) =>
      this.#radarItemFromRow(row, identifiersByItem.get(row.id) ?? []),
    );
  }

  getLibrary() {
    this.#assertOpen();
    const papers = this.#papers();
    return {
      papers,
      categories: this.#categories(papers),
      backup: { ...this.backupStatus },
    };
  }

  getRadarSettings() {
    this.#assertOpen();
    const row = this.db
      .prepare(
        `SELECT prompt, requested_count AS requestedCount,
                updated_at AS updatedAt
         FROM radar_settings WHERE id = 'default'`,
      )
      .get();
    return {
      prompt: row?.prompt ?? DEFAULT_RADAR_PROMPT,
      requestedCount: Number(row?.requestedCount ?? 5),
      ...(row?.updatedAt ? { updatedAt: row.updatedAt } : {}),
    };
  }

  getRadarItem(id) {
    this.#assertOpen();
    return this.#radarItems({ id })[0] ?? null;
  }

  getRadarState() {
    this.#assertOpen();
    const counts = Object.fromEntries(
      this.db
        .prepare(
          `SELECT status, COUNT(*) AS count
           FROM radar_items GROUP BY status`,
        )
        .all()
        .map((row) => [row.status, Number(row.count)]),
    );
    const libraryCount = Number(
      this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM papers WHERE deleted_at IS NULL",
        )
        .get().count,
    );
    return {
      settings: this.getRadarSettings(),
      pending: this.#radarItems({ status: "pending" }),
      discarded: this.#radarItems({ status: "discarded" }),
      counts: {
        library: libraryCount,
        pending: counts.pending ?? 0,
        discarded: counts.discarded ?? 0,
        added: counts.added ?? 0,
      },
      backup: { ...this.backupStatus },
    };
  }

  getRadarExclusions() {
    this.#assertOpen();
    const library = this.#papers().map((paper) => ({
      origin: "library",
      title: paper.title,
      identifiers: paper.identifiers,
    }));
    const radar = this.#radarItems().map((item) => ({
      origin: "radar",
      status: item.status,
      title: item.title,
      identifiers: item.identifiers,
    }));
    return [...library, ...radar];
  }

  findRadarDuplicates({ identifiers = [], title = "" } = {}) {
    this.#assertOpen();
    const normalizedIdentifiers = validatePaperIdentifiers(identifiers) ?? [];
    const matches = new Map();
    const addReason = (itemId, reason) => {
      const reasons = matches.get(itemId) ?? [];
      if (!reasons.some((item) => JSON.stringify(item) === JSON.stringify(reason))) {
        reasons.push(reason);
      }
      matches.set(itemId, reasons);
    };
    const lookup = this.db.prepare(
      `SELECT item_id AS itemId
       FROM radar_item_identifiers
       WHERE kind = ? AND normalized_value = ?`,
    );
    for (const identifier of normalizedIdentifiers) {
      for (const row of lookup.all(identifier.kind, identifier.value)) {
        addReason(row.itemId, {
          type: "identifier",
          kind: identifier.kind,
          value: identifier.value,
        });
      }
    }
    const normalizedTitle = normalizePaperTitle(title);
    if (normalizedTitle) {
      const row = this.db
        .prepare(
          "SELECT id FROM radar_items WHERE normalized_title = ?",
        )
        .get(normalizedTitle);
      if (row) addReason(row.id, { type: "title" });
    }
    return [...matches.entries()].map(([itemId, reasons]) => ({
      item: this.getRadarItem(itemId),
      reasons,
    }));
  }

  getCategories() {
    this.#assertOpen();
    const allModel = this.#categoryModel({ includeDeleted: true });
    const activeRows = allModel.rows.filter((category) => !category.deletedAt);
    const activeModel = this.#categoryModel();
    const paperLinks = this.db
      .prepare(
        `SELECT pc.paper_id AS paperId, pc.category_id AS categoryId
         FROM paper_categories pc
         JOIN papers p ON p.id = pc.paper_id
         WHERE p.deleted_at IS NULL`,
      )
      .all();
    const papersByCategory = new Map();
    for (const link of paperLinks) {
      const paperIds = papersByCategory.get(link.categoryId) ?? new Set();
      paperIds.add(link.paperId);
      papersByCategory.set(link.categoryId, paperIds);
    }

    const activeChildrenByParent = new Map();
    const deletedChildrenByParent = new Map();
    for (const category of allModel.rows) {
      if (!category.parentId) continue;
      const target = category.deletedAt
        ? deletedChildrenByParent
        : activeChildrenByParent;
      target.set(category.parentId, (target.get(category.parentId) ?? 0) + 1);
    }

    const categoryRecord = (category) => {
      const directPaperIds = papersByCategory.get(category.id) ?? new Set();
      const subtreePaperIds = new Set(directPaperIds);
      const subtreeModel = category.deletedAt ? allModel : activeModel;
      for (const descendant of subtreeModel.rows) {
        if (
          descendant.id !== category.id &&
          subtreeModel.ancestorsFor(descendant.id).includes(category.id)
        ) {
          for (const paperId of papersByCategory.get(descendant.id) ?? []) {
            subtreePaperIds.add(paperId);
          }
        }
      }
      const ancestorIds = category.deletedAt
        ? allModel.ancestorsFor(category.id)
        : activeModel.ancestorsFor(category.id);
      const directCount = directPaperIds.size;
      const totalCount = subtreePaperIds.size;
      return {
        id: category.id,
        name: category.name,
        parentId: category.parentId ?? null,
        ancestorIds,
        sidebarVisible:
          category.parentId === null
            ? Boolean(category.sidebarVisible)
            : true,
        directCount,
        totalCount,
        count: totalCount,
        childCount: activeChildrenByParent.get(category.id) ?? 0,
        deletedChildCount: deletedChildrenByParent.get(category.id) ?? 0,
        createdAt: category.createdAt,
        updatedAt: category.updatedAt,
        ...(category.deletedAt ? { deletedAt: category.deletedAt } : {}),
      };
    };

    return {
      categories: activeRows.map(categoryRecord),
      deletedCategories: allModel.rows
        .filter((category) => category.deletedAt)
        .map(categoryRecord),
      backup: { ...this.backupStatus },
    };
  }

  getAiServices() {
    this.#assertOpen();
    const services = this.db
      .prepare(
        `SELECT id, name, base_url AS baseUrl,
                credential_key AS credentialKey,
                created_at AS createdAt, updated_at AS updatedAt
         FROM ai_services
         ORDER BY created_at, id`,
      )
      .all();
    const models = this.db
      .prepare(
        `SELECT id, service_id AS serviceId, model,
                resolved_model AS resolvedModel, active,
                verified_at AS verifiedAt,
                created_at AS createdAt, updated_at AS updatedAt
         FROM ai_models
         ORDER BY active DESC, verified_at DESC, id`,
      )
      .all();
    const modelsByService = new Map();
    for (const model of models) {
      const values = modelsByService.get(model.serviceId) ?? [];
      values.push({ ...model, active: Boolean(model.active) });
      modelsByService.set(model.serviceId, values);
    }
    return services.map((service) => ({
      ...service,
      models: modelsByService.get(service.id) ?? [],
    }));
  }

  getAiService(id) {
    const normalizedId = validateAiEntityId(id, "connectionId");
    return (
      this.getAiServices().find((service) => service.id === normalizedId) ??
      null
    );
  }

  getAiModel(id) {
    const normalizedId = validateAiEntityId(id, "modelId");
    for (const service of this.getAiServices()) {
      const model = service.models.find((entry) => entry.id === normalizedId);
      if (model) return { ...model, service };
    }
    return null;
  }

  async saveAiServiceModel({
    connectionId,
    name,
    baseUrl,
    model,
    resolvedModel,
    makeActive = false,
  }) {
    return this.#queueMutation(async () => {
      const normalizedConnectionId = connectionId
        ? validateAiEntityId(connectionId, "connectionId")
        : randomUUID();
      const normalizedName = validateAiServiceName(name);
      const normalizedModel = validateAiModel(model);
      const normalizedBaseUrl = validateHttpUrl(baseUrl, "baseUrl");
      if (!normalizedBaseUrl || normalizedBaseUrl.length > 2_048) {
        throw new ValidationError("baseUrl 必须是有效的网址。", {
          field: "baseUrl",
        });
      }
      const normalizedResolvedModel = resolvedModel
        ? validateAiModel(resolvedModel, "resolvedModel")
        : "";
      const currentService = this.db
        .prepare(
          `SELECT id, base_url AS baseUrl, credential_key AS credentialKey,
                  created_at AS createdAt
           FROM ai_services WHERE id = ?`,
        )
        .get(normalizedConnectionId);
      const duplicateService = this.db
        .prepare("SELECT id FROM ai_services WHERE base_url = ? AND id <> ?")
        .get(normalizedBaseUrl, normalizedConnectionId);
      if (duplicateService) {
        throw new ConflictError("该 Base URL 已经存在，无需重复添加。", {
          field: "baseUrl",
          connectionId: duplicateService.id,
        });
      }
      const currentModel = this.db
        .prepare(
          `SELECT id, active, created_at AS createdAt
           FROM ai_models WHERE service_id = ? AND model = ?`,
        )
        .get(normalizedConnectionId, normalizedModel);
      const serviceHadActiveModel = Boolean(
        this.db
          .prepare(
            "SELECT 1 FROM ai_models WHERE service_id = ? AND active = 1",
          )
          .get(normalizedConnectionId),
      );
      const activeCount = Number(
        this.db
          .prepare("SELECT COUNT(*) AS count FROM ai_models WHERE active = 1")
          .get().count,
      );
      const baseUrlChanged = Boolean(
        currentService && currentService.baseUrl !== normalizedBaseUrl,
      );
      const shouldActivate =
        Boolean(makeActive) ||
        Boolean(currentModel?.active) ||
        (baseUrlChanged && serviceHadActiveModel) ||
        activeCount === 0;
      const now = this.now().toISOString();
      const modelId = currentModel?.id ?? randomUUID();

      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare(
            `INSERT INTO ai_services (
               id, name, base_url, credential_key, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               base_url = excluded.base_url,
               updated_at = excluded.updated_at`,
          )
          .run(
            normalizedConnectionId,
            normalizedName,
            normalizedBaseUrl,
            currentService?.credentialKey ?? normalizedConnectionId,
            currentService?.createdAt ?? now,
            now,
          );
        if (baseUrlChanged) {
          this.db
            .prepare("DELETE FROM ai_models WHERE service_id = ?")
            .run(normalizedConnectionId);
        }
        if (shouldActivate) {
          this.db.prepare("UPDATE ai_models SET active = 0").run();
        }
        this.db
          .prepare(
            `INSERT INTO ai_models (
               id, service_id, model, resolved_model, active,
               verified_at, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(service_id, model) DO UPDATE SET
               resolved_model = excluded.resolved_model,
               active = excluded.active,
               verified_at = excluded.verified_at,
               updated_at = excluded.updated_at`,
          )
          .run(
            modelId,
            normalizedConnectionId,
            normalizedModel,
            normalizedResolvedModel,
            shouldActivate ? 1 : 0,
            now,
            currentModel?.createdAt ?? now,
            now,
          );
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }

      const service = this.getAiService(normalizedConnectionId);
      const savedModel = service.models.find(
        (entry) => entry.model === normalizedModel,
      );
      const backup = await this.#createBackup();
      return { service, model: savedModel, backup };
    });
  }

  async setActiveAiModel(modelId) {
    return this.#queueMutation(async () => {
      const normalizedModelId = validateAiEntityId(modelId, "modelId");
      const model = this.db
        .prepare("SELECT id FROM ai_models WHERE id = ?")
        .get(normalizedModelId);
      if (!model) throw new NotFoundError("未找到该 AI 模型配置。");
      const now = this.now().toISOString();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("UPDATE ai_models SET active = 0").run();
        this.db
          .prepare(
            "UPDATE ai_models SET active = 1, updated_at = ? WHERE id = ?",
          )
          .run(now, normalizedModelId);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      const backup = await this.#createBackup();
      return { model: this.getAiModel(normalizedModelId), backup };
    });
  }

  async clearActiveAiModel() {
    return this.#queueMutation(async () => {
      this.db.prepare("UPDATE ai_models SET active = 0").run();
      const backup = await this.#createBackup();
      return { backup };
    });
  }

  async updateAiServiceMetadata({ connectionId, name }) {
    return this.#queueMutation(async () => {
      const normalizedConnectionId = validateAiEntityId(
        connectionId,
        "connectionId",
      );
      const normalizedName = validateAiServiceName(name);
      const service = this.db
        .prepare("SELECT id FROM ai_services WHERE id = ?")
        .get(normalizedConnectionId);
      if (!service) throw new NotFoundError("未找到该 AI 服务连接。");

      this.db
        .prepare("UPDATE ai_services SET name = ?, updated_at = ? WHERE id = ?")
        .run(normalizedName, this.now().toISOString(), normalizedConnectionId);
      const backup = await this.#createBackup();
      return {
        service: this.getAiService(normalizedConnectionId),
        backup,
      };
    });
  }

  async deleteAiModel(modelId) {
    return this.#queueMutation(async () => {
      const normalizedModelId = validateAiEntityId(modelId, "modelId");
      const model = this.db
        .prepare("SELECT active FROM ai_models WHERE id = ?")
        .get(normalizedModelId);
      if (!model) throw new NotFoundError("未找到该 AI 模型配置。");
      const now = this.now().toISOString();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare("DELETE FROM ai_models WHERE id = ?")
          .run(normalizedModelId);
        if (model.active) {
          this.db
            .prepare(
              `UPDATE ai_models SET active = 1, updated_at = ?
               WHERE id = (
                 SELECT id FROM ai_models
                 ORDER BY verified_at DESC, id LIMIT 1
               )`,
            )
            .run(now);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      const backup = await this.#createBackup();
      return { modelId: normalizedModelId, backup };
    });
  }

  async deleteAiService(connectionId) {
    return this.#queueMutation(async () => {
      const normalizedConnectionId = validateAiEntityId(
        connectionId,
        "connectionId",
      );
      const active = Boolean(
        this.db
          .prepare(
            "SELECT 1 FROM ai_models WHERE service_id = ? AND active = 1",
          )
          .get(normalizedConnectionId),
      );
      const now = this.now().toISOString();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare("DELETE FROM ai_services WHERE id = ?")
          .run(normalizedConnectionId);
        if (active) {
          this.db
            .prepare(
              `UPDATE ai_models SET active = 1, updated_at = ?
               WHERE id = (
                 SELECT id FROM ai_models
                 ORDER BY verified_at DESC, id LIMIT 1
               )`,
            )
            .run(now);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      const backup = await this.#createBackup();
      return { connectionId: normalizedConnectionId, backup };
    });
  }

  getPaper(id, { includeDeleted = false } = {}) {
    this.#assertOpen();
    return this.#papers({ includeDeleted, id })[0] ?? null;
  }

  getPdfArchiveRecord(id, { includeDeleted = false } = {}) {
    this.#assertOpen();
    validatePaperId(id);
    const row = this.db
      .prepare(
        `SELECT
           a.paper_id AS paperId,
           a.status,
           a.source_url AS sourceUrl,
           a.storage_key AS storageKey,
           a.sha256,
           a.size_bytes AS sizeBytes,
           a.downloaded_at AS downloadedAt,
           a.last_error_code AS lastErrorCode,
           a.last_error_message AS lastErrorMessage,
           a.updated_at AS updatedAt
         FROM paper_pdf_archives a
         JOIN papers p ON p.id = a.paper_id
         WHERE a.paper_id = ?
           ${includeDeleted ? "" : "AND p.deleted_at IS NULL"}`,
      )
      .get(id);
    return row ?? null;
  }

  async recordPdfArchiveReady(
    id,
    { sourceUrl = "", storageKey, sha256, sizeBytes } = {},
  ) {
    return this.#queueMutation(async () => {
      validatePaperId(id);
      const current = this.getPaper(id);
      if (!current) throw new NotFoundError(`未找到论文 ${id}。`);
      const normalizedSourceUrl = validatePdfArchiveSourceUrl(sourceUrl);
      const normalizedStorageKey = validatePdfStorageKey(storageKey);
      const normalizedSha256 = validatePdfSha256(sha256);
      const normalizedSizeBytes = validatePdfSize(sizeBytes);
      const now = this.now().toISOString();
      let committed = true;

      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (
          normalizedSourceUrl &&
          current.pdfUrl &&
          current.pdfUrl !== normalizedSourceUrl
        ) {
          this.db
            .prepare(
              `INSERT INTO paper_pdf_archives (
                 paper_id, status, source_url, updated_at
               ) VALUES (?, 'stale', ?, ?)
               ON CONFLICT(paper_id) DO UPDATE SET
                 status = 'stale',
                 source_url = excluded.source_url,
                 updated_at = excluded.updated_at`,
            )
            .run(id, current.pdfUrl, now);
          committed = false;
        } else {
          this.db
            .prepare(
              `INSERT INTO paper_pdf_archives (
                 paper_id, status, source_url, storage_key, sha256,
                 size_bytes, downloaded_at, last_error_code,
                 last_error_message, updated_at
               ) VALUES (?, 'ready', ?, ?, ?, ?, ?, NULL, NULL, ?)
               ON CONFLICT(paper_id) DO UPDATE SET
                 status = 'ready',
                 source_url = excluded.source_url,
                 storage_key = excluded.storage_key,
                 sha256 = excluded.sha256,
                 size_bytes = excluded.size_bytes,
                 downloaded_at = excluded.downloaded_at,
                 last_error_code = NULL,
                 last_error_message = NULL,
                 updated_at = excluded.updated_at`,
            )
            .run(
              id,
              normalizedSourceUrl,
              normalizedStorageKey,
              normalizedSha256,
              normalizedSizeBytes,
              now,
              now,
            );
          this.db
            .prepare(
              `UPDATE papers
               SET has_pdf = 1, updated_at = ?
               WHERE id = ? AND deleted_at IS NULL`,
            )
            .run(now, id);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      const backup = await this.#createBackup();
      return { paper: this.getPaper(id), backup, committed };
    });
  }

  async recordPdfArchiveFailure(
    id,
    { sourceUrl = "", errorCode, errorMessage } = {},
  ) {
    return this.#queueMutation(async () => {
      validatePaperId(id);
      const current = this.getPaper(id);
      if (!current) throw new NotFoundError(`未找到论文 ${id}。`);
      const normalizedSourceUrl = validatePdfArchiveSourceUrl(sourceUrl);
      const normalizedErrorCode = validateString(errorCode, "errorCode");
      const normalizedErrorMessage = validatePdfErrorMessage(errorMessage);
      const existing = this.getPdfArchiveRecord(id);
      const status = validatePdfArchiveStatus(
        existing?.status === "ready" && existing.storageKey
          ? "ready"
          : existing?.storageKey
            ? "stale"
            : "failed",
      );
      const now = this.now().toISOString();

      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare(
            `INSERT INTO paper_pdf_archives (
               paper_id, status, source_url, last_error_code,
               last_error_message, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(paper_id) DO UPDATE SET
               status = excluded.status,
               source_url = excluded.source_url,
               last_error_code = excluded.last_error_code,
               last_error_message = excluded.last_error_message,
               updated_at = excluded.updated_at`,
          )
          .run(
            id,
            status,
            normalizedSourceUrl || current.pdfUrl || existing?.sourceUrl || "",
            normalizedErrorCode,
            normalizedErrorMessage,
            now,
          );
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      const backup = await this.#createBackup();
      return { paper: this.getPaper(id), backup };
    });
  }

  async recordPdfArchiveStale(id) {
    return this.#queueMutation(async () => {
      validatePaperId(id);
      const current = this.getPaper(id);
      if (!current) throw new NotFoundError(`未找到论文 ${id}。`);
      const now = this.now().toISOString();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare(
            `INSERT INTO paper_pdf_archives (
               paper_id, status, source_url, updated_at
             ) VALUES (?, 'stale', ?, ?)
             ON CONFLICT(paper_id) DO UPDATE SET
               status = 'stale',
               source_url = excluded.source_url,
               updated_at = excluded.updated_at`,
          )
          .run(id, current.pdfUrl ?? "", now);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      const backup = await this.#createBackup();
      return { paper: this.getPaper(id), backup };
    });
  }

  async clearPdfArchiveRecord(id) {
    return this.#queueMutation(async () => {
      validatePaperId(id);
      const current = this.getPaper(id);
      if (!current) throw new NotFoundError(`未找到论文 ${id}。`);
      const now = this.now().toISOString();
      const hasPdf = Boolean(current.pdfUrl || current.pdfAttachmentKey);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare("DELETE FROM paper_pdf_archives WHERE paper_id = ?")
          .run(id);
        this.db
          .prepare(
            `UPDATE papers
             SET has_pdf = ?, updated_at = ?
             WHERE id = ? AND deleted_at IS NULL`,
          )
          .run(sqliteBoolean(hasPdf), now, id);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      const backup = await this.#createBackup();
      return { paper: this.getPaper(id), backup };
    });
  }

  findPaperDuplicates({
    identifiers = [],
    title = "",
    excludePaperId,
    includeDeleted = false,
  } = {}) {
    this.#assertOpen();
    const normalizedIdentifiers = validatePaperIdentifiers(identifiers) ?? [];
    const matches = new Map();
    const addReason = (paperId, reason) => {
      if (paperId === excludePaperId) return;
      const reasons = matches.get(paperId) ?? [];
      if (!reasons.some((item) => JSON.stringify(item) === JSON.stringify(reason))) {
        reasons.push(reason);
      }
      matches.set(paperId, reasons);
    };

    const lookup = this.db.prepare(
      `SELECT paper_identifiers.paper_id AS paperId
       FROM paper_identifiers
       JOIN papers ON papers.id = paper_identifiers.paper_id
       WHERE paper_identifiers.kind = ?
         AND paper_identifiers.normalized_value = ?
         ${includeDeleted ? "" : "AND papers.deleted_at IS NULL"}`,
    );
    for (const identifier of normalizedIdentifiers) {
      for (const row of lookup.all(identifier.kind, identifier.value)) {
        addReason(row.paperId, {
          type: "identifier",
          kind: identifier.kind,
          value: identifier.value,
        });
      }
    }

    const normalizedTitle = normalizePaperTitle(title);
    if (normalizedTitle) {
      for (const paper of this.#papers({ includeDeleted })) {
        if (normalizePaperTitle(paper.title) === normalizedTitle) {
          addReason(paper.id, { type: "title" });
        }
      }
    }

    return [...matches.entries()]
      .map(([paperId, reasons]) => {
        const paper = this.getPaper(paperId, { includeDeleted });
        if (!paper) return null;
        return {
          paper: {
            id: paper.id,
            title: paper.title,
            zhTitle: paper.zhTitle,
            authors: paper.authors,
            source: paper.source,
            date: paper.date,
            ...(paper.deletedAt ? { deletedAt: paper.deletedAt } : {}),
          },
          reasons,
        };
      })
      .filter(Boolean)
      .sort(
        (left, right) =>
          Number(Boolean(left.paper.deletedAt)) - Number(Boolean(right.paper.deletedAt)) ||
          left.paper.title.localeCompare(right.paper.title),
      );
  }

  #assertCategoriesExist(categoryIds) {
    if (!categoryIds?.length) return;
    const getCategory = this.db.prepare(
      "SELECT id FROM categories WHERE id = ? AND deleted_at IS NULL",
    );
    for (const categoryId of categoryIds) {
      if (!getCategory.get(categoryId)) {
        throw new ValidationError(`分类 ${categoryId} 不存在。`, {
          field: "categoryIds",
          categoryId,
        });
      }
    }
  }

  #replacePaperCategories(paperId, categoryIds) {
    this.db
      .prepare("DELETE FROM paper_categories WHERE paper_id = ?")
      .run(paperId);
    const insert = this.db.prepare(
      `INSERT INTO paper_categories (paper_id, category_id, sort_order)
       VALUES (?, ?, ?)`,
    );
    for (const [index, categoryId] of categoryIds.entries()) {
      insert.run(paperId, categoryId, index);
    }
  }

  #replacePaperIdentifiers(paperId, identifiers, createdAt) {
    this.db
      .prepare("DELETE FROM paper_identifiers WHERE paper_id = ?")
      .run(paperId);
    const insert = this.db.prepare(
      `INSERT INTO paper_identifiers (
         paper_id, kind, normalized_value, created_at
       ) VALUES (?, ?, ?, ?)`,
    );
    for (const identifier of identifiers) {
      insert.run(paperId, identifier.kind, identifier.value, createdAt);
    }
  }

  #queueMutation(operation) {
    const result = this.mutationQueue.then(async () => {
      this.#assertOpen();
      return operation();
    });
    this.mutationQueue = result.catch(() => undefined);
    return result;
  }

  async saveRadarSettings({ prompt, count } = {}) {
    return this.#queueMutation(async () => {
      const normalizedPrompt = validateRadarPrompt(prompt);
      const requestedCount = validateRadarCount(count);
      const now = this.now().toISOString();
      this.db
        .prepare(
          `INSERT INTO radar_settings (
             id, prompt, requested_count, updated_at
           ) VALUES ('default', ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             prompt = excluded.prompt,
             requested_count = excluded.requested_count,
             updated_at = excluded.updated_at`,
        )
        .run(normalizedPrompt, requestedCount, now);
      const backup = await this.#createBackup();
      return { settings: this.getRadarSettings(), backup };
    });
  }

  async saveRadarCandidates(candidates) {
    return this.#queueMutation(async () => {
      if (!Array.isArray(candidates) || candidates.length > 90) {
        throw new ValidationError("文献雷达候选条目必须是数组，且不能超过 90 条。", {
          field: "candidates",
        });
      }
      const normalizedCandidates = candidates.map(validateRadarCandidate);
      const inserted = [];
      const skipped = [];
      const now = this.now().toISOString();
      const insertItem = this.db.prepare(
        `INSERT INTO radar_items (
           id, title, normalized_title, zh_title, authors, institution,
           source, publication_date, ai_summary, recommendation_reason,
           original_url, pdf_url, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      );
      const insertIdentifier = this.db.prepare(
        `INSERT INTO radar_item_identifiers (
           item_id, kind, normalized_value, created_at
         ) VALUES (?, ?, ?, ?)`,
      );

      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const candidate of normalizedCandidates) {
          const libraryMatches = this.findPaperDuplicates(candidate);
          const radarMatches = this.findRadarDuplicates(candidate);
          if (libraryMatches.length || radarMatches.length) {
            skipped.push({
              title: candidate.title,
              reason: libraryMatches.length ? "library" : "radar",
            });
            continue;
          }
          const id = `radar-${randomUUID()}`;
          insertItem.run(
            id,
            candidate.title,
            candidate.normalizedTitle,
            candidate.zhTitle,
            candidate.authors,
            candidate.institution,
            candidate.source,
            candidate.date,
            candidate.aiSummary,
            candidate.recommendationReason,
            candidate.originalUrl,
            candidate.pdfUrl,
            now,
            now,
          );
          for (const identifier of candidate.identifiers) {
            insertIdentifier.run(id, identifier.kind, identifier.value, now);
          }
          inserted.push(id);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      const backup = inserted.length
        ? await this.#createBackup()
        : { ...this.backupStatus };
      return {
        inserted: inserted.map((id) => this.getRadarItem(id)),
        skipped,
        backup,
      };
    });
  }

  async discardRadarItem(id) {
    return this.#queueMutation(async () => {
      validateAiEntityId(id, "id");
      const item = this.getRadarItem(id);
      if (!item) throw new NotFoundError("未找到文献雷达条目。");
      if (item.status === "added") {
        throw new ConflictError("已加入知识库的论文不能丢弃。");
      }
      if (item.status !== "discarded") {
        this.db
          .prepare(
            `UPDATE radar_items
             SET status = 'discarded', updated_at = ?
             WHERE id = ?`,
          )
          .run(this.now().toISOString(), id);
      }
      const backup = await this.#createBackup();
      return { item: this.getRadarItem(id), backup };
    });
  }

  async restoreRadarItem(id) {
    return this.#queueMutation(async () => {
      validateAiEntityId(id, "id");
      const item = this.getRadarItem(id);
      if (!item) throw new NotFoundError("未找到文献雷达条目。");
      if (item.status !== "discarded") {
        throw new ConflictError("只有已丢弃论文可以恢复到待审核列表。");
      }
      this.db
        .prepare(
          `UPDATE radar_items
           SET status = 'pending', updated_at = ?
           WHERE id = ?`,
        )
        .run(this.now().toISOString(), id);
      const backup = await this.#createBackup();
      return { item: this.getRadarItem(id), backup };
    });
  }

  async markRadarItemAdded(id, paperId) {
    return this.#queueMutation(async () => {
      validateAiEntityId(id, "id");
      validatePaperId(paperId);
      const item = this.getRadarItem(id);
      if (!item) throw new NotFoundError("未找到文献雷达条目。");
      const paper = this.getPaper(paperId);
      if (!paper) throw new NotFoundError("未找到刚加入知识库的论文。");
      if (item.status !== "pending") {
        throw new ConflictError("只有待审核论文可以加入知识库。");
      }
      this.db
        .prepare(
          `UPDATE radar_items
           SET status = 'added', added_paper_id = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(paperId, this.now().toISOString(), id);
      const backup = await this.#createBackup();
      return { item: this.getRadarItem(id), paper, backup };
    });
  }

  async updatePaper(id, input) {
    return this.#queueMutation(async () => {
      validatePaperId(id);
      const current = this.getPaper(id);
      if (!current) throw new NotFoundError(`未找到论文 ${id}。`);
      const patch = validatePaperInput(input);
      const currentPdfArchive = this.getPdfArchiveRecord(id);
      const pdfUrlChanged =
        Object.hasOwn(patch, "pdfUrl") &&
        patch.pdfUrl !== (current.pdfUrl ?? null);
      if (pdfUrlChanged && !Object.hasOwn(patch, "hasPdf")) {
        patch.hasPdf = Boolean(
          patch.pdfUrl ||
            current.pdfAttachmentKey ||
            currentPdfArchive?.status === "ready",
        );
      }
      if (
        Object.hasOwn(patch, "source") ||
        Object.hasOwn(patch, "date") ||
        Object.hasOwn(patch, "title")
      ) {
        patch.source = normalizePublicationSource(
          patch.source ?? current.source,
          patch.date ?? current.date,
          { title: patch.title ?? current.title },
        );
      }
      this.#assertCategoriesExist(patch.categoryIds);
      if (patch.identifiers !== undefined) {
        const duplicates = this.findPaperDuplicates({
          identifiers: patch.identifiers,
          title: patch.title ?? current.title,
          excludePaperId: id,
        });
        if (duplicates.length) {
          throw new ConflictError("发现重复论文，修改未保存。", { duplicates });
        }
      }
      const now = this.now().toISOString();
      const assignments = [];
      const parameters = [];

      for (const [fieldName, columnName] of Object.entries(PAPER_COLUMNS)) {
        if (!Object.hasOwn(patch, fieldName)) continue;
        let value = patch[fieldName];
        if (
          fieldName === "favorite" ||
          fieldName === "watchLater" ||
          fieldName === "hasPdf"
        ) {
          value = sqliteBoolean(value);
        }
        assignments.push(`${columnName} = ?`);
        parameters.push(value);
      }

      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (assignments.length) {
          assignments.push("updated_at = ?");
          parameters.push(now, id);
          this.db
            .prepare(
              `UPDATE papers
               SET ${assignments.join(", ")}
               WHERE id = ? AND deleted_at IS NULL`,
            )
            .run(...parameters);
        }
        if (patch.categoryIds !== undefined) {
          this.#replacePaperCategories(id, patch.categoryIds);
          if (!assignments.length) {
            this.db
              .prepare("UPDATE papers SET updated_at = ? WHERE id = ?")
              .run(now, id);
          }
        }
        if (patch.identifiers !== undefined) {
          this.#replacePaperIdentifiers(id, patch.identifiers, now);
          if (!assignments.length && patch.categoryIds === undefined) {
            this.db
              .prepare("UPDATE papers SET updated_at = ? WHERE id = ?")
              .run(now, id);
          }
        }
        if (
          pdfUrlChanged &&
          patch.pdfUrl &&
          currentPdfArchive?.sourceUrl &&
          currentPdfArchive.sourceUrl !== patch.pdfUrl
        ) {
          this.db
            .prepare(
              `UPDATE paper_pdf_archives
               SET status = 'stale', source_url = ?, updated_at = ?
               WHERE paper_id = ?`,
            )
            .run(patch.pdfUrl, now, id);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }

      const paper = this.getPaper(id);
      const backup = await this.#createBackup();
      return { paper, backup };
    });
  }

  async createPaper(input) {
    return this.#queueMutation(async () => {
      const normalized = validatePaperInput(input, { creating: true });
      const id = normalized.id ?? `local-${randomUUID()}`;
      const categoryIds = normalized.categoryIds ?? [];
      this.#assertCategoriesExist(categoryIds);
      if (this.getPaper(id, { includeDeleted: true })) {
        throw new ConflictError(`论文 ${id} 已存在。`);
      }
      const duplicates = this.findPaperDuplicates({
        identifiers: normalized.identifiers ?? [],
        title: normalized.title,
      });
      if (duplicates.length) {
        throw new ConflictError("发现重复论文，未添加到知识库。", {
          duplicates,
        });
      }

      const now = this.now().toISOString();
      const nextOrder = Number(
        this.db
          .prepare(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM papers",
          )
          .get().value,
      );
      const paper = paperInsertValues(
        {
          ...input,
          ...normalized,
          id,
          categoryIds,
        },
        now,
        nextOrder,
      );
      const insert = this.db.prepare(`
        INSERT INTO papers (
          id, zotero_key, title, zh_title, authors, institution, source,
          publication_date, date_added, status, ai_summary, note,
          note_count, favorite, watch_later, has_pdf, pdf_attachment_key, pdf_url,
          original_url, code_provider, code_url, project_provider, project_url,
          sort_order, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `);

      this.db.exec("BEGIN IMMEDIATE");
      try {
        insert.run(
          paper.id,
          paper.zoteroKey,
          paper.title,
          paper.zhTitle,
          paper.authors,
          paper.institution,
          paper.source,
          paper.date,
          paper.dateAdded,
          paper.status,
          paper.aiSummary,
          paper.note,
          paper.noteCount,
          sqliteBoolean(paper.favorite),
          sqliteBoolean(paper.watchLater),
          sqliteBoolean(paper.hasPdf),
          paper.pdfAttachmentKey,
          paper.pdfUrl,
          paper.originalUrl,
          paper.codeProvider,
          paper.codeUrl,
          paper.projectProvider,
          paper.projectUrl,
          paper.sortOrder,
          paper.createdAt,
          paper.updatedAt,
        );
        this.#replacePaperCategories(paper.id, paper.categoryIds);
        this.#replacePaperIdentifiers(paper.id, paper.identifiers, paper.createdAt);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        if (/UNIQUE constraint failed/i.test(error?.message ?? "")) {
          throw new ConflictError(`论文 ${id} 已存在。`);
        }
        throw error;
      }

      const created = this.getPaper(id);
      const backup = await this.#createBackup();
      return { paper: created, backup };
    });
  }

  async deletePaper(id) {
    return this.#queueMutation(async () => {
      validatePaperId(id);
      const current = this.getPaper(id);
      if (!current) throw new NotFoundError(`未找到论文 ${id}。`);
      const now = this.now().toISOString();
      this.db
        .prepare(
          `UPDATE papers
           SET deleted_at = ?, updated_at = ?
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .run(now, now, id);
      const paper = this.getPaper(id, { includeDeleted: true });
      const backup = await this.#createBackup();
      return { paper, backup };
    });
  }

  async restorePaper(id) {
    return this.#queueMutation(async () => {
      validatePaperId(id);
      const current = this.getPaper(id, { includeDeleted: true });
      if (!current || !current.deletedAt) {
        throw new NotFoundError(`未找到可恢复的论文 ${id}。`);
      }
      const duplicates = this.findPaperDuplicates({
        identifiers: current.identifiers,
        title: current.title,
        excludePaperId: id,
      });
      if (duplicates.length) {
        throw new ConflictError("知识库中已经存在相同论文，无法恢复此记录。", {
          duplicates,
        });
      }
      const now = this.now().toISOString();
      this.db
        .prepare(
          `UPDATE papers
           SET deleted_at = NULL, updated_at = ?
           WHERE id = ? AND deleted_at IS NOT NULL`,
        )
        .run(now, id);
      const paper = this.getPaper(id);
      const backup = await this.#createBackup();
      return { paper, backup };
    });
  }

  #nextCategorySortOrder(parentId) {
    return Number(
      this.db
        .prepare(
          `SELECT COALESCE(MAX(sort_order), -1) + 1 AS value
           FROM categories
           WHERE deleted_at IS NULL
             AND (
               (parent_id IS NULL AND ? IS NULL)
               OR parent_id = ?
             )`,
        )
        .get(parentId, parentId).value,
    );
  }

  async createCategory(input) {
    return this.#queueMutation(async () => {
      const { name, parentId, sidebarVisible } =
        validateCategoryInput(input, {
          creating: true,
        });
      if (
        parentId !== null &&
        Object.hasOwn(input, "sidebarVisible")
      ) {
        throw new ValidationError(
          "只有一级分类可以设置 sidebarVisible。",
          { field: "sidebarVisible", parentId },
        );
      }
      this.#assertValidCategoryParent(parentId, {
        field: "parentId",
      });
      this.#assertCategoryNameAvailable(name, parentId);

      const id = `local-${randomUUID()}`;
      const now = this.now().toISOString();
      const sortOrder = this.#nextCategorySortOrder(parentId);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare(
            `INSERT INTO categories (
              id, name, parent_id, source_kind, source_key, source_parent_id,
              sort_order, sidebar_visible, created_at, updated_at, deleted_at
            ) VALUES (?, ?, ?, 'local', NULL, NULL, ?, ?, ?, ?, NULL)`,
          )
          .run(
            id,
            name,
            parentId,
            sortOrder,
            sqliteBoolean(parentId === null ? sidebarVisible : true),
            now,
            now,
          );
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }

      const backup = await this.#createBackup();
      const categories = this.getCategories();
      return {
        category: categories.categories.find((category) => category.id === id),
        library: this.getLibrary(),
        backup,
      };
    });
  }

  #categoryRow(id, { includeDeleted = false } = {}) {
    return (
      this.db
        .prepare(
          `SELECT
            id,
            name,
            parent_id AS parentId,
            source_kind AS sourceKind,
            source_key AS sourceKey,
            source_parent_id AS sourceParentId,
            sort_order AS sortOrder,
            sidebar_visible AS sidebarVisible,
            created_at AS createdAt,
            updated_at AS updatedAt,
            deleted_at AS deletedAt
          FROM categories
          WHERE id = ? ${includeDeleted ? "" : "AND deleted_at IS NULL"}`,
        )
        .get(id) ?? null
    );
  }

  #assertValidCategoryParent(
    parentId,
    { categoryId, field = "parentId" } = {},
  ) {
    const model = this.#categoryModel();
    let parent = null;
    if (parentId !== null) {
      parent = this.#categoryRow(parentId);
      if (!parent) {
        throw new ValidationError(`父分类 ${parentId} 不存在或已删除。`, {
          field,
          parentId,
        });
      }
      if (categoryId === parentId) {
        throw new ValidationError("分类不能成为自己的上级。", {
          field,
          parentId,
        });
      }
      if (
        categoryId &&
        model.ancestorsFor(parentId).includes(categoryId)
      ) {
        throw new ValidationError("不能把分类移动到自己的后代中。", {
          field,
          parentId,
        });
      }
    }

    const proposedDepth =
      parentId === null
        ? 1
        : model.ancestorsFor(parentId).length + 2;
    let subtreeHeight = 1;
    if (categoryId) {
      for (const category of model.rows) {
        const categoryIndex = model
          .ancestorsFor(category.id)
          .indexOf(categoryId);
        if (categoryIndex >= 0) {
          subtreeHeight = Math.max(
            subtreeHeight,
            categoryIndex + 2,
          );
        }
      }
    }
    const resultingDepth = proposedDepth + subtreeHeight - 1;
    if (resultingDepth > MAX_CATEGORY_DEPTH) {
      throw new ValidationError(
        `分类最多支持${MAX_CATEGORY_DEPTH}级，当前移动会使分类树达到${resultingDepth}级。`,
        {
          field,
          parentId,
          maxDepth: MAX_CATEGORY_DEPTH,
          resultingDepth,
        },
      );
    }
    return parent;
  }

  #assertCategoryNameAvailable(name, parentId, excludeId) {
    const duplicate = this.db
      .prepare(
        `SELECT id
         FROM categories
         WHERE deleted_at IS NULL
           AND name = ? COLLATE NOCASE
           AND (
             (parent_id IS NULL AND ? IS NULL)
             OR parent_id = ?
           )
           AND (? IS NULL OR id <> ?)`,
      )
      .get(name, parentId, parentId, excludeId ?? null, excludeId ?? null);
    if (duplicate) {
      throw new ConflictError("同一级中已存在同名分类。", {
        categoryId: duplicate.id,
        parentId,
      });
    }
  }

  async updateCategory(id, input) {
    return this.#queueMutation(async () => {
      validateCategoryId(id);
      const current = this.#categoryRow(id);
      if (!current) throw new NotFoundError(`未找到分类 ${id}。`);
      const patch = validateCategoryInput(input);
      const name = patch.name ?? current.name;
      const parentId = Object.hasOwn(patch, "parentId")
        ? patch.parentId
        : current.parentId;
      const parentChanged = parentId !== current.parentId;
      const sortOrder = parentChanged
        ? this.#nextCategorySortOrder(parentId)
        : current.sortOrder;
      if (
        Object.hasOwn(patch, "sidebarVisible") &&
        parentId !== null
      ) {
        throw new ValidationError(
          "只有一级分类可以设置 sidebarVisible。",
          { field: "sidebarVisible", parentId },
        );
      }
      const sidebarVisible =
        parentId === null
          ? Object.hasOwn(patch, "sidebarVisible")
            ? patch.sidebarVisible
            : Boolean(current.sidebarVisible)
          : true;

      if (parentChanged) {
        this.#assertValidCategoryParent(parentId, {
          categoryId: id,
          field: "parentId",
        });
      }
      this.#assertCategoryNameAvailable(name, parentId, id);

      const now = this.now().toISOString();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare(
            `UPDATE categories
             SET name = ?, parent_id = ?, sort_order = ?,
                 sidebar_visible = ?, updated_at = ?
             WHERE id = ? AND deleted_at IS NULL`,
          )
          .run(
            name,
            parentId,
            sortOrder,
            sqliteBoolean(sidebarVisible),
            now,
            id,
          );
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }

      const backup = await this.#createBackup();
      const categories = this.getCategories();
      return {
        category: categories.categories.find(
          (category) => category.id === id,
        ),
        library: this.getLibrary(),
        backup,
      };
    });
  }

  async reorderCategories(input) {
    return this.#queueMutation(async () => {
      const { parentId, orderedIds } = validateCategoryReorderInput(input);
      if (parentId && !this.#categoryRow(parentId)) {
        throw new ValidationError(`父分类 ${parentId} 不存在或已删除。`, {
          field: "parentId",
          parentId,
        });
      }

      const siblings = this.db
        .prepare(
          `SELECT id
           FROM categories
           WHERE deleted_at IS NULL
             AND (
               (parent_id IS NULL AND ? IS NULL)
               OR parent_id = ?
             )
           ORDER BY sort_order, id`,
        )
        .all(parentId, parentId)
        .map((category) => category.id);
      const siblingIds = new Set(siblings);
      const requestedIds = new Set(orderedIds);
      if (
        orderedIds.length !== siblings.length ||
        requestedIds.size !== siblingIds.size ||
        [...requestedIds].some((id) => !siblingIds.has(id))
      ) {
        throw new ValidationError(
          "排序请求必须包含该层级的全部有效分类。",
          { field: "orderedIds", parentId },
        );
      }

      const now = this.now().toISOString();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const updateSortOrder = this.db.prepare(
          `UPDATE categories
           SET sort_order = ?, updated_at = ?
           WHERE id = ? AND deleted_at IS NULL`,
        );
        orderedIds.forEach((id, sortOrder) => {
          updateSortOrder.run(sortOrder, now, id);
        });
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }

      const backup = await this.#createBackup();
      const categories = this.getCategories();
      return {
        categories: categories.categories,
        deletedCategories: categories.deletedCategories,
        library: this.getLibrary(),
        backup,
      };
    });
  }

  #categoryDeletionStats(id) {
    const row = this.db
      .prepare(
        `SELECT
          COUNT(DISTINCT p.id) AS directPaperCount,
          COUNT(DISTINCT CASE
            WHEN NOT EXISTS (
              SELECT 1
              FROM paper_categories other_pc
              JOIN categories other_c
                ON other_c.id = other_pc.category_id
               AND other_c.deleted_at IS NULL
              WHERE other_pc.paper_id = p.id
                AND other_pc.category_id <> ?
            )
            THEN p.id
          END) AS wouldBecomeUncategorizedCount
         FROM paper_categories pc
         JOIN papers p
           ON p.id = pc.paper_id
          AND p.deleted_at IS NULL
         WHERE pc.category_id = ?`,
      )
      .get(id, id);
    const directPaperCount = Number(row.directPaperCount);
    const wouldBecomeUncategorizedCount = Number(
      row.wouldBecomeUncategorizedCount,
    );
    return {
      directPaperCount,
      wouldBecomeUncategorizedCount,
      retainingOtherCategoryCount:
        directPaperCount - wouldBecomeUncategorizedCount,
    };
  }

  async deleteCategory(id, input = {}) {
    return this.#queueMutation(async () => {
      validateCategoryId(id);
      if (!isPlainObject(input)) {
        throw new ValidationError("请求正文必须是 JSON 对象。");
      }
      const unknownFields = Object.keys(input).filter(
        (field) => field !== "paperPolicy",
      );
      if (unknownFields.length) {
        throw new ValidationError(
          `不支持的字段：${unknownFields.join("、")}。`,
          { fields: unknownFields },
        );
      }
      if (
        Object.hasOwn(input, "paperPolicy") &&
        input.paperPolicy !== "detach"
      ) {
        throw new ValidationError(
          "paperPolicy 目前只支持“detach”（保留论文与可恢复关联）。",
          { field: "paperPolicy" },
        );
      }
      const current = this.#categoryRow(id);
      if (!current) throw new NotFoundError(`未找到分类 ${id}。`);
      const activeChild = this.db
        .prepare(
          `SELECT id
           FROM categories
           WHERE parent_id = ? AND deleted_at IS NULL
           LIMIT 1`,
        )
        .get(id);
      if (activeChild) {
        throw new ConflictError("含有子分类的分类不能删除。", {
          childCategoryId: activeChild.id,
        });
      }
      const stats = this.#categoryDeletionStats(id);
      const now = this.now().toISOString();

      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare(
            `UPDATE categories
             SET deleted_at = ?, updated_at = ?
             WHERE id = ? AND deleted_at IS NULL`,
          )
          .run(now, now, id);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }

      const backup = await this.#createBackup();
      const categories = this.getCategories();
      return {
        category: categories.deletedCategories.find(
          (category) => category.id === id,
        ),
        stats,
        library: this.getLibrary(),
        backup,
      };
    });
  }

  async restoreCategory(id) {
    return this.#queueMutation(async () => {
      validateCategoryId(id);
      const current = this.#categoryRow(id, { includeDeleted: true });
      if (!current?.deletedAt) {
        throw new NotFoundError(`未找到可恢复的分类 ${id}。`);
      }
      if (current.parentId) {
        const parent = this.#categoryRow(current.parentId, {
          includeDeleted: true,
        });
        if (!parent) {
          throw new ConflictError("原上级分类已不存在，无法恢复。", {
            parentId: current.parentId,
          });
        }
        if (parent.deletedAt) {
          throw new ConflictError("请先恢复上级分类，再恢复此分类。", {
            parentId: current.parentId,
          });
        }
      }
      this.#assertValidCategoryParent(current.parentId, {
        categoryId: current.id,
        field: "parentId",
      });
      this.#assertCategoryNameAvailable(
        current.name,
        current.parentId,
        current.id,
      );
      const now = this.now().toISOString();

      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare(
            `UPDATE categories
             SET deleted_at = NULL, updated_at = ?
             WHERE id = ? AND deleted_at IS NOT NULL`,
          )
          .run(now, id);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }

      const backup = await this.#createBackup();
      const categories = this.getCategories();
      return {
        category: categories.categories.find(
          (category) => category.id === id,
        ),
        library: this.getLibrary(),
        backup,
      };
    });
  }

  integrityCheck() {
    this.#assertOpen();
    const rows = this.db.prepare("PRAGMA integrity_check").all();
    return rows.map((row) => row.integrity_check);
  }

  async #uniqueVersionPath(date) {
    const base = `library-${isoFileTimestamp(date)}`;
    for (let suffix = 0; suffix < 10_000; suffix += 1) {
      const candidate = join(
        this.backupDir,
        `${base}${suffix ? `-${suffix}` : ""}.sqlite3`,
      );
      try {
        await access(candidate);
      } catch (error) {
        if (error?.code === "ENOENT") return candidate;
        throw error;
      }
    }
    throw new Error("无法为备份生成唯一文件名。");
  }

  async #verifyDatabaseFile(path) {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const results = database.prepare("PRAGMA integrity_check").all();
      if (
        results.length !== 1 ||
        String(results[0].integrity_check).toLocaleLowerCase("en") !== "ok"
      ) {
        throw new Error(
          `SQLite 完整性检查失败：${results
            .map((result) => result.integrity_check)
            .join("；")}`,
        );
      }
    } finally {
      database.close();
    }
  }

  async #retainRecentBackups(limit = 30) {
    const entries = await readdir(this.backupDir, { withFileTypes: true });
    const versions = entries
      .filter(
        (entry) =>
          entry.isFile() &&
          /^library-\d{4}-\d{2}-\d{2}T.*\.sqlite3$/.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort()
      .reverse();
    await Promise.all(
      versions
        .slice(limit)
        .map((name) => rm(join(this.backupDir, name), { force: true })),
    );
  }

  async #createBackup() {
    const date = this.now();
    const token = `${process.pid}-${randomUUID()}`;
    const sqliteTemporaryPath = join(
      this.backupDir,
      `.library-${token}.tmp.sqlite3`,
    );
    const latestTemporaryPath = join(
      this.backupDir,
      `.library-latest-${token}.tmp.sqlite3`,
    );

    try {
      await mkdir(this.backupDir, { recursive: true, mode: 0o700 });
      const versionPath = await this.#uniqueVersionPath(date);
      await sqliteBackup(this.db, sqliteTemporaryPath);
      await this.#verifyDatabaseFile(sqliteTemporaryPath);
      await rename(sqliteTemporaryPath, versionPath);
      await copyFile(versionPath, latestTemporaryPath);
      await this.#verifyDatabaseFile(latestTemporaryPath);
      await rename(
        latestTemporaryPath,
        join(this.backupDir, "library-latest.sqlite3"),
      );

      let cleanupMessage;
      try {
        await this.#retainRecentBackups(30);
      } catch (error) {
        cleanupMessage = `备份已完成，但旧版本清理失败：${error.message}`;
      }

      this.backupStatus = {
        ok: true,
        lastBackupAt: date.toISOString(),
        ...(cleanupMessage ? { message: cleanupMessage } : {}),
      };
    } catch (error) {
      this.backupStatus = {
        ok: false,
        ...(this.backupStatus.lastBackupAt
          ? { lastBackupAt: this.backupStatus.lastBackupAt }
          : {}),
        message: backupStatusMessage(error),
      };
    } finally {
      await Promise.all([
        rm(sqliteTemporaryPath, { force: true }).catch(() => undefined),
        rm(latestTemporaryPath, { force: true }).catch(() => undefined),
      ]);
    }

    return { ...this.backupStatus };
  }

  async close() {
    if (this.closed) return;
    await this.mutationQueue;
    this.closed = true;
    this.db.close();
  }
}

export async function createLibraryRepository(options = {}) {
  const repository = new LibraryRepository(options);
  await repository.initializeBackupStatus();
  return repository;
}
