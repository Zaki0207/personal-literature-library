import { ConflictError, NotFoundError, ValidationError } from "./library-repository.mjs";
import { createSqliteBackup } from "./sqlite-backup.mjs";
import { pdfHighlightRectsOverlap } from "../lib/pdf-highlight-geometry.mjs";

const fields = new Set(["pdfVersion", "pageNumber", "pageCount", "xRatio", "yRatio", "body"]);
const highlightFields = new Set(["pdfVersion", "pageCount", "text", "rects"]);
const columns = "id, pdf_version AS pdfVersion, page_number AS pageNumber, x_ratio AS xRatio, y_ratio AS yRatio, body, created_at AS createdAt, updated_at AS updatedAt";
const highlightColumns = "id, pdf_version AS pdfVersion, text, rects_json AS rectsJson";
const unpackHighlight = ({ rectsJson, ...highlight }) => ({ ...highlight, rects: JSON.parse(rectsJson) });
const version = (value) => {
  if (typeof value !== "string" || !/^(?:sha256:[a-f0-9]{64}|fingerprint:[a-zA-Z0-9_-]{1,128})$/u.test(value)) throw new ValidationError("PDF 版本标识无效。");
  return value;
};
const noteId = (value) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/u.test(value)) throw new ValidationError("便签 ID 无效。");
  return value;
};

export class PdfNotesService {
  constructor({ repository }) {
    this.repository = repository;
    this.ready = this.enqueue(() => repository.db.exec(`
      CREATE TABLE IF NOT EXISTS paper_pdf_notes (
        id TEXT PRIMARY KEY,
        paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        pdf_version TEXT NOT NULL,
        page_number INTEGER NOT NULL CHECK (page_number > 0),
        x_ratio REAL NOT NULL CHECK (x_ratio >= 0 AND x_ratio <= 1),
        y_ratio REAL NOT NULL CHECK (y_ratio >= 0 AND y_ratio <= 1),
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS paper_pdf_notes_version ON paper_pdf_notes(paper_id, pdf_version, page_number);
      CREATE TABLE IF NOT EXISTS paper_pdf_highlights (
        id TEXT PRIMARY KEY,
        paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        pdf_version TEXT NOT NULL,
        text TEXT NOT NULL,
        rects_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS paper_pdf_highlights_version ON paper_pdf_highlights(paper_id, pdf_version);
    `));
  }
  enqueue(operation) {
    const result = this.repository.mutationQueue.then(() => {
      if (this.repository.closed) throw new Error("本地文献数据库已关闭。");
      return operation();
    });
    this.repository.mutationQueue = result.catch(() => undefined);
    return result;
  }
  assertPaper(paperId) {
    if (!this.repository.getPaper(paperId)) throw new NotFoundError("未找到论文。");
  }
  assertVersion(paperId, pdfVersion, annotation = "便签") {
    this.assertPaper(paperId);
    const archive = this.repository.getPdfArchiveRecord(paperId);
    const current = archive?.status === "ready" && archive.sha256 ? `sha256:${archive.sha256}` : null;
    if ((current && current !== pdfVersion) || (!current && pdfVersion.startsWith("sha256:"))) throw new ConflictError(`PDF 已更新或移除，请重新打开后添加${annotation}。原${annotation}仍已保留。`, { code: "PDF_VERSION_CHANGED" });
  }
  async backup() {
    const repository = this.repository;
    repository.backupStatus = await createSqliteBackup({ db: repository.db, backupDir: repository.backupDir, date: repository.now(), previousStatus: repository.backupStatus });
    return { ...repository.backupStatus };
  }
  async list(paperId, pdfVersion) {
    await this.ready;
    version(pdfVersion); this.assertVersion(paperId, pdfVersion);
    const notes = this.repository.db.prepare(`SELECT ${columns} FROM paper_pdf_notes WHERE paper_id = ? ORDER BY page_number, created_at, id`).all(paperId);
    return { pdfVersion, notes: notes.filter((note) => note.pdfVersion === pdfVersion), previousNotes: notes.filter((note) => note.pdfVersion !== pdfVersion) };
  }
  async save(paperId, id, input) {
    noteId(id);
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !fields.has(key))) throw new ValidationError("便签内容包含无效字段。");
    const pdfVersion = version(input.pdfVersion);
    const { pageNumber, pageCount, xRatio, yRatio } = input;
    if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 100_000 || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount) throw new ValidationError("便签页码无效。");
    if (![xRatio, yRatio].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) throw new ValidationError("便签位置无效。");
    if (typeof input.body !== "string" || !input.body.trim() || input.body.length > 100_000) throw new ValidationError("请输入便签内容（不超过 10 万字）。");
    const body = input.body.trim();
    await this.ready;
    return this.enqueue(async () => {
      this.assertVersion(paperId, pdfVersion);
      const existing = this.repository.db.prepare("SELECT paper_id, pdf_version FROM paper_pdf_notes WHERE id = ?").get(id);
      if (existing && (existing.paper_id !== paperId || existing.pdf_version !== pdfVersion)) throw new ConflictError("便签不属于当前论文或 PDF 版本。");
      const now = this.repository.now().toISOString();
      this.repository.db.prepare(`INSERT INTO paper_pdf_notes (id, paper_id, pdf_version, page_number, x_ratio, y_ratio, body, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET page_number=excluded.page_number, x_ratio=excluded.x_ratio, y_ratio=excluded.y_ratio, body=excluded.body, updated_at=excluded.updated_at`)
        .run(id, paperId, pdfVersion, pageNumber, xRatio, yRatio, body, now, now);
      const note = this.repository.db.prepare(`SELECT ${columns} FROM paper_pdf_notes WHERE id = ?`).get(id);
      return { note, backup: await this.backup() };
    });
  }
  async remove(paperId, id, input) {
    noteId(id);
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => key !== "pdfVersion")) throw new ValidationError("删除便签的请求无效。");
    const pdfVersion = version(input.pdfVersion);
    await this.ready;
    return this.enqueue(async () => {
      this.assertVersion(paperId, pdfVersion);
      const result = this.repository.db.prepare("DELETE FROM paper_pdf_notes WHERE id = ? AND paper_id = ? AND pdf_version = ?").run(id, paperId, pdfVersion);
      if (!result.changes) throw new NotFoundError("未找到这条便签。");
      return { id, backup: await this.backup() };
    });
  }
  async listHighlights(paperId, pdfVersion) {
    await this.ready;
    version(pdfVersion);
    this.assertVersion(paperId, pdfVersion, "高亮");
    const highlights = this.repository.db.prepare(`SELECT ${highlightColumns} FROM paper_pdf_highlights WHERE paper_id = ? AND pdf_version = ? ORDER BY rowid`).all(paperId, pdfVersion);
    return { pdfVersion, highlights: highlights.map(unpackHighlight) };
  }
  async saveHighlight(paperId, id, input) {
    noteId(id);
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !highlightFields.has(key))) throw new ValidationError("高亮内容包含无效字段。");
    const pdfVersion = version(input.pdfVersion);
    const { pageCount, text, rects } = input;
    if (typeof text !== "string" || !text.trim() || text.length > 20_000) throw new ValidationError("请选择不超过 2 万字的高亮文字。");
    if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 100_000 || !Array.isArray(rects) || rects.length < 1 || rects.length > 1000) throw new ValidationError("高亮范围无效，请分段选择。");
    const rectangles = rects.map((rect) => {
      const { pageNumber, xRatio, yRatio, widthRatio, heightRatio } = rect ?? {};
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount
        || ![xRatio, yRatio, widthRatio, heightRatio].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
        || widthRatio === 0 || heightRatio === 0 || xRatio + widthRatio > 1.000001 || yRatio + heightRatio > 1.000001) throw new ValidationError("高亮位置无效。");
      return { pageNumber, xRatio, yRatio, widthRatio, heightRatio };
    });
    await this.ready;
    return this.enqueue(async () => {
      this.assertVersion(paperId, pdfVersion, "高亮");
      const existing = this.repository.db.prepare("SELECT paper_id, pdf_version FROM paper_pdf_highlights WHERE id = ?").get(id);
      if (existing && (existing.paper_id !== paperId || existing.pdf_version !== pdfVersion)) throw new ConflictError("高亮不属于当前论文或 PDF 版本。");
      if (!existing) {
        const marks = this.repository.db.prepare("SELECT rects_json FROM paper_pdf_highlights WHERE paper_id = ? AND pdf_version = ?").all(paperId, pdfVersion);
        if (marks.some(({ rects_json }) => JSON.parse(rects_json).some((mark) => rectangles.some((rect) => pdfHighlightRectsOverlap(rect, mark))))) {
          throw new ConflictError("选区已包含高亮，请先取消原有标记。", { code: "PDF_HIGHLIGHT_OVERLAP" });
        }
      }
      const highlight = { id, pdfVersion, text: text.trim(), rects: rectangles };
      this.repository.db.prepare(`INSERT INTO paper_pdf_highlights (id, paper_id, pdf_version, text, rects_json) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET text=excluded.text, rects_json=excluded.rects_json`)
        .run(id, paperId, pdfVersion, highlight.text, JSON.stringify(rectangles));
      return { highlight, backup: await this.backup() };
    });
  }
  async removeHighlight(paperId, id, input) {
    noteId(id);
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => key !== "pdfVersion")) throw new ValidationError("删除高亮的请求无效。");
    const pdfVersion = version(input.pdfVersion);
    await this.ready;
    return this.enqueue(async () => {
      this.assertVersion(paperId, pdfVersion, "高亮");
      this.repository.db.prepare("DELETE FROM paper_pdf_highlights WHERE id = ? AND paper_id = ? AND pdf_version = ?").run(id, paperId, pdfVersion);
      return { id, backup: await this.backup() };
    });
  }
}
