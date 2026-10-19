import { ConflictError, NotFoundError, ValidationError } from "./library-repository.mjs";

const POSITION_FIELDS = new Set([
  "pdfVersion", "pageNumber", "pageCount", "scale", "zoomMode",
  "scrollOffset", "notesVisible", "layoutMode",
]);

function validateVersion(value) {
  if (
    typeof value !== "string" ||
    !/^(?:sha256:[a-f0-9]{64}|fingerprint:[a-zA-Z0-9_-]{1,128})$/u.test(value)
  ) {
    throw new ValidationError("PDF 版本标识无效。", { field: "pdfVersion" });
  }
  return value;
}

export function validateReadingPosition(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("阅读位置必须是 JSON 对象。");
  }
  const unknown = Object.keys(input).filter((field) => !POSITION_FIELDS.has(field));
  if (unknown.length) {
    throw new ValidationError(`不支持的字段：${unknown.join("、")}。`, { fields: unknown });
  }
  const pdfVersion = validateVersion(input.pdfVersion);
  const { pageNumber, pageCount, scale, zoomMode, scrollOffset, notesVisible, layoutMode = "single-page" } = input;
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 100_000) {
    throw new ValidationError("PDF 总页数无效。", { field: "pageCount" });
  }
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount) {
    throw new ValidationError("页码超出 PDF 范围。", { field: "pageNumber" });
  }
  if (!Number.isFinite(scale) || scale < 0.25 || scale > 4) {
    throw new ValidationError("缩放比例必须在 25% 到 400% 之间。", { field: "scale" });
  }
  if (zoomMode !== "fit-width" && zoomMode !== "custom") {
    throw new ValidationError("缩放模式无效。", { field: "zoomMode" });
  }
  if (!Number.isFinite(scrollOffset) || scrollOffset < 0 || scrollOffset > 1) {
    throw new ValidationError("页面内阅读位置无效。", { field: "scrollOffset" });
  }
  if (typeof notesVisible !== "boolean") {
    throw new ValidationError("笔记面板状态无效。", { field: "notesVisible" });
  }
  if (layoutMode !== "single-page" && layoutMode !== "continuous") {
    throw new ValidationError("阅读布局模式无效。", { field: "layoutMode" });
  }
  // Old single-page positions measure scrollOffset against maxScroll; continuous
  // positions measure it against the current page height. The reader converts.
  return { pdfVersion, pageNumber, pageCount, scale, zoomMode, scrollOffset, notesVisible, layoutMode };
}

/** Shares the repository's connection and mutation queue, including backup work. */
export class ReadingStateService {
  constructor({ repository } = {}) {
    if (!repository?.db || !repository.mutationQueue) {
      throw new Error("ReadingStateService 需要已打开的 repository。");
    }
    this.repository = repository;
    this.ready = this.#enqueue(() => {
      repository.db.exec(`
        CREATE TABLE IF NOT EXISTS paper_reading_positions (
          paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
          pdf_version TEXT NOT NULL,
          page_number INTEGER NOT NULL CHECK (page_number > 0),
          page_count INTEGER NOT NULL CHECK (page_count > 0),
          scale REAL NOT NULL CHECK (scale >= 0.25 AND scale <= 4),
          zoom_mode TEXT NOT NULL CHECK (zoom_mode IN ('fit-width', 'custom')),
          scroll_offset REAL NOT NULL CHECK (scroll_offset >= 0 AND scroll_offset <= 1),
          notes_visible INTEGER NOT NULL CHECK (notes_visible IN (0, 1)),
          layout_mode TEXT NOT NULL DEFAULT 'single-page' CHECK (layout_mode IN ('single-page', 'continuous')),
          updated_at TEXT NOT NULL,
          PRIMARY KEY (paper_id, pdf_version)
        ) STRICT;
      `);
      const columns = repository.db.prepare("PRAGMA table_info(paper_reading_positions)").all();
      if (!columns.some((column) => column.name === "layout_mode")) {
        repository.db.exec(`
          ALTER TABLE paper_reading_positions
          ADD COLUMN layout_mode TEXT NOT NULL DEFAULT 'single-page'
          CHECK (layout_mode IN ('single-page', 'continuous'))
        `);
      }
    });
  }

  #enqueue(operation) {
    const repository = this.repository;
    const result = repository.mutationQueue.then(() => {
      if (repository.closed) throw new Error("本地文献数据库已关闭。");
      return operation();
    });
    repository.mutationQueue = result.catch(() => undefined);
    return result;
  }

  #currentVersion(paperId) {
    if (!this.repository.getPaper(paperId)) throw new NotFoundError("未找到论文。");
    const archive = this.repository.getPdfArchiveRecord(paperId);
    return archive?.status === "ready" && archive.sha256
      ? `sha256:${archive.sha256}`
      : null;
  }

  async getPosition(paperId, { pdfVersion } = {}) {
    await this.ready;
    const archivedVersion = this.#currentVersion(paperId);
    const requestedVersion = pdfVersion ? validateVersion(pdfVersion) : null;
    const resolvedVersion = archivedVersion ?? requestedVersion;
    if (!resolvedVersion || (archivedVersion && requestedVersion && archivedVersion !== requestedVersion)) {
      return { pdfVersion: archivedVersion, position: null, reset: Boolean(requestedVersion) };
    }
    const row = this.repository.db.prepare(`
      SELECT page_number AS pageNumber, page_count AS pageCount, scale,
             zoom_mode AS zoomMode, scroll_offset AS scrollOffset,
             notes_visible AS notesVisible, layout_mode AS layoutMode, updated_at AS updatedAt
      FROM paper_reading_positions WHERE paper_id = ? AND pdf_version = ?
    `).get(paperId, resolvedVersion);
    return {
      pdfVersion: resolvedVersion,
      position: row ? { ...row, notesVisible: Boolean(row.notesVisible) } : null,
      reset: false,
    };
  }

  async savePosition(paperId, input) {
    const position = validateReadingPosition(input);
    await this.ready;
    return this.#enqueue(() => {
      const archivedVersion = this.#currentVersion(paperId);
      if (archivedVersion && archivedVersion !== position.pdfVersion) {
        throw new ConflictError("PDF 已更新，请重新打开论文后继续阅读。", {
          code: "PDF_VERSION_CHANGED", pdfVersion: archivedVersion,
        });
      }
      // A sha256 state can only refer to the current, locally verified archive.
      if (!archivedVersion && position.pdfVersion.startsWith("sha256:")) {
        throw new ConflictError("本地 PDF 已移除或更新，请重新打开论文。", {
          code: "PDF_VERSION_CHANGED",
        });
      }
      const updatedAt = this.repository.now().toISOString();
      this.repository.db.prepare(`
        INSERT INTO paper_reading_positions (
          paper_id, pdf_version, page_number, page_count, scale,
          zoom_mode, scroll_offset, notes_visible, layout_mode, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(paper_id, pdf_version) DO UPDATE SET
          page_number = excluded.page_number, page_count = excluded.page_count,
          scale = excluded.scale, zoom_mode = excluded.zoom_mode,
          scroll_offset = excluded.scroll_offset, notes_visible = excluded.notes_visible,
          layout_mode = excluded.layout_mode,
          updated_at = excluded.updated_at
      `).run(
        paperId, position.pdfVersion, position.pageNumber, position.pageCount,
        position.scale, position.zoomMode, position.scrollOffset,
        Number(position.notesVisible), position.layoutMode, updatedAt,
      );
      return {
        pdfVersion: position.pdfVersion,
        position: {
          pageNumber: position.pageNumber, pageCount: position.pageCount,
          scale: position.scale, zoomMode: position.zoomMode,
          scrollOffset: position.scrollOffset, notesVisible: position.notesVisible, layoutMode: position.layoutMode,
          updatedAt,
        },
      };
    });
  }
}

export function createReadingStateService(options) {
  return new ReadingStateService(options);
}
