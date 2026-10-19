import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLibraryApi } from "../scripts/library-api.mjs";
import { createLibraryRepository } from "../scripts/library-repository.mjs";

const PAPER_ID = "READ0001";
const PDF_BYTES = Buffer.from("%PDF-1.4\n% reading position fixture\n%%EOF\n");
const position = (pdfVersion, overrides = {}) => ({
  pdfVersion, pageNumber: 7, pageCount: 20, scale: 1.4,
  zoomMode: "custom", scrollOffset: 0.42, notesVisible: false, ...overrides,
});

async function fixture(t, name, { legacyPosition } = {}) {
  const directory = await mkdtemp(join(tmpdir(), `reading-${name}-`));
  const seedPath = join(directory, "seed.json");
  await writeFile(seedPath, JSON.stringify({ categoryRecords: [], papers: [{
    id: PAPER_ID, title: "Synthetic Reading Position Paper", zhTitle: "阅读位置测试",
    authors: "Fixture Author", institution: "Fixture Institute", source: "Fixture",
    date: "2026-01-01", dateAdded: "2026-01-01T00:00:00.000Z", note: "原笔记",
    aiSummary: "", favorite: false, watchLater: false, hasPdf: true,
    pdfUrl: "https://papers.example.test/reading.pdf",
  }] }));
  if (legacyPosition) {
    const repository = await createLibraryRepository({
      dbPath: join(directory, "library.sqlite3"), backupDir: join(directory, "backups"), seedPath,
    });
    try {
      repository.db.exec(`
        CREATE TABLE paper_reading_positions (
          paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
          pdf_version TEXT NOT NULL,
          page_number INTEGER NOT NULL CHECK (page_number > 0),
          page_count INTEGER NOT NULL CHECK (page_count > 0),
          scale REAL NOT NULL CHECK (scale >= 0.25 AND scale <= 4),
          zoom_mode TEXT NOT NULL CHECK (zoom_mode IN ('fit-width', 'custom')),
          scroll_offset REAL NOT NULL CHECK (scroll_offset >= 0 AND scroll_offset <= 1),
          notes_visible INTEGER NOT NULL CHECK (notes_visible IN (0, 1)),
          updated_at TEXT NOT NULL,
          PRIMARY KEY (paper_id, pdf_version)
        ) STRICT
      `);
      repository.db.prepare(`
        INSERT INTO paper_reading_positions
          (paper_id, pdf_version, page_number, page_count, scale, zoom_mode, scroll_offset, notes_visible, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(PAPER_ID, legacyPosition.pdfVersion, legacyPosition.pageNumber, legacyPosition.pageCount,
        legacyPosition.scale, legacyPosition.zoomMode, legacyPosition.scrollOffset,
        Number(legacyPosition.notesVisible), "2026-10-11T08:00:00.000Z");
    } finally { await repository.close(); }
  }
  let api;
  let baseUrl;
  const start = async () => {
    api = await createLibraryApi({
      port: 0, dbPath: join(directory, "library.sqlite3"),
      backupDir: join(directory, "backups"), seedPath,
      pdfDirectory: join(directory, "pdfs"),
    });
    baseUrl = (await api.listen()).url;
  };
  await start();
  t.after(async () => { await api.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    get api() { return api; },
    async restart() { await api.close(); await start(); },
    async request(path, options = {}) {
      const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers: { Origin: "http://localhost:3000", ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
      });
      return { response, body: await response.json() };
    },
    async importPdf(bytes = PDF_BYTES) {
      const response = await fetch(`${baseUrl}/api/papers/${PAPER_ID}/pdf/import`, {
        method: "POST", headers: { Origin: "http://localhost:3000", "Content-Type": "application/pdf" }, body: bytes,
      });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body;
    },
  };
}

const readingPath = `/api/papers/${PAPER_ID}/reading-position`;

test("阅读位置按本地 PDF 内容版本保存，并在服务重启后恢复", async (t) => {
  const f = await fixture(t, "restart");
  await f.importPdf();
  const initial = await f.request(readingPath);
  assert.equal(initial.response.status, 200);
  assert.match(initial.body.pdfVersion, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(initial.body.position, null);
  const input = position(initial.body.pdfVersion);
  const saved = await f.request(readingPath, { method: "PUT", body: JSON.stringify(input) });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.body.position.pageNumber, 7);
  assert.equal(saved.body.position.notesVisible, false);
  assert.equal(f.api.repository.getPaper(PAPER_ID).note, "原笔记");
  await f.restart();
  const restored = await f.request(readingPath);
  assert.equal(restored.body.pdfVersion, input.pdfVersion);
  const { updatedAt, ...restoredPosition } = restored.body.position;
  assert.ok(updatedAt);
  const expected = { ...input };
  delete expected.pdfVersion;
  assert.deepEqual(restoredPosition, { ...expected, layoutMode: "single-page" });
});

test("替换 PDF 后进度重置，旧阅读器的保存请求被拒绝", async (t) => {
  const f = await fixture(t, "replacement");
  await f.importPdf();
  const old = (await f.request(readingPath)).body.pdfVersion;
  await f.request(readingPath, { method: "PUT", body: JSON.stringify(position(old)) });
  await f.importPdf(Buffer.from("%PDF-1.4\n% a revised document with different page positions\n%%EOF\n"));
  const fresh = await f.request(readingPath);
  assert.notEqual(fresh.body.pdfVersion, old);
  assert.equal(fresh.body.position, null);
  const staleGet = await f.request(`${readingPath}?pdfVersion=${encodeURIComponent(old)}`);
  assert.equal(staleGet.body.position, null);
  assert.equal(staleGet.body.reset, true);
  const staleSave = await f.request(readingPath, { method: "PUT", body: JSON.stringify(position(old)) });
  assert.equal(staleSave.response.status, 409);
  assert.equal(staleSave.body.error.details.code, "PDF_VERSION_CHANGED");
  assert.equal((await f.request(readingPath)).body.position, null);
});

test("相同 PDF 内容重新导入仍恢复原进度", async (t) => {
  const f = await fixture(t, "identical");
  await f.importPdf();
  const version = (await f.request(readingPath)).body.pdfVersion;
  await f.request(readingPath, { method: "PUT", body: JSON.stringify(position(version)) });
  await f.importPdf();
  const restored = await f.request(readingPath);
  assert.equal(restored.body.pdfVersion, version);
  assert.equal(restored.body.position.pageNumber, 7);
});

test("远程 PDF 用 fingerprint 区分版本，移除本地副本后拒绝旧 sha256", async (t) => {
  const f = await fixture(t, "fingerprint");
  const version = "fingerprint:abcd0123456789";
  const saved = await f.request(readingPath, { method: "PUT", body: JSON.stringify(position(version)) });
  assert.equal(saved.response.status, 200);
  assert.equal((await f.request(readingPath)).body.position, null);
  const restored = await f.request(`${readingPath}?pdfVersion=${version}`);
  assert.equal(restored.body.position.pageNumber, 7);
  assert.equal((await f.request(`${readingPath}?pdfVersion=fingerprint:different`)).body.position, null);
  await f.importPdf();
  const archived = (await f.request(readingPath)).body.pdfVersion;
  await f.request(`/api/papers/${PAPER_ID}/pdf/archive`, { method: "DELETE" });
  const obsolete = await f.request(readingPath, { method: "PUT", body: JSON.stringify(position(archived)) });
  assert.equal(obsolete.response.status, 409);
});

test("非法进度与已删除论文不写数据库；跨来源写入受既有 API 限制", async (t) => {
  const f = await fixture(t, "invalid");
  const version = "fingerprint:test";
  const patches = [{ pageNumber: 21 }, { pageNumber: 0 }, { pageCount: 0 }, { scale: 5 }, { scrollOffset: -0.1 }, { notesVisible: "true" }, { zoomMode: "invalid" }, { pdfVersion: "../../file" }, { layoutMode: "invalid" }, { layoutMode: null }, { layoutMode: 1 }, { unknown: true }];
  for (const patch of patches) {
    const invalid = await f.request(readingPath, { method: "PUT", body: JSON.stringify(position(version, patch)) });
    assert.equal(invalid.response.status, 400, JSON.stringify(patch));
  }
  assert.equal(Number(f.api.repository.db.prepare("SELECT count(*) AS count FROM paper_reading_positions").get().count), 0);
  const denied = await f.request(readingPath, { method: "PUT", headers: { Origin: "https://untrusted.example.test" }, body: JSON.stringify(position(version)) });
  assert.equal(denied.response.status, 403);
  await f.request(`/api/papers/${PAPER_ID}`, { method: "DELETE" });
  assert.equal((await f.request(readingPath)).response.status, 404);
  assert.equal((await f.request(readingPath, { method: "PUT", body: JSON.stringify(position(version)) })).response.status, 404);
});

test("阅读保存与论文笔记修改共用 repository 写入队列", async (t) => {
  const f = await fixture(t, "single-writer");
  const service = f.api.readingStateService;
  assert.ok(service);
  const version = "fingerprint:queue";
  const results = await Promise.all([
    service.savePosition(PAPER_ID, position(version, { pageNumber: 2 })),
    f.api.repository.updatePaper(PAPER_ID, { note: "并发期间保存的阅读笔记" }),
    service.savePosition(PAPER_ID, position(version, { pageNumber: 9 })),
  ]);
  assert.equal(results.length, 3);
  assert.equal((await service.getPosition(PAPER_ID, { pdfVersion: version })).position.pageNumber, 9);
  assert.equal(f.api.repository.getPaper(PAPER_ID).note, "并发期间保存的阅读笔记");
  assert.deepEqual(f.api.repository.integrityCheck(), ["ok"]);
});

test("已有旧表的阅读位置无损标记 single-page，重复重启迁移幂等", async (t) => {
  const legacy = position("fingerprint:legacy-page", { pageNumber: 12, scrollOffset: 0.73 });
  const f = await fixture(t, "legacy-layout-migration", { legacyPosition: legacy });
  for (let restart = 0; restart < 3; restart += 1) {
    const restored = await f.request(`${readingPath}?pdfVersion=${legacy.pdfVersion}`);
    assert.equal(restored.response.status, 200);
    const { updatedAt, ...actual } = restored.body.position;
    const expected = { ...legacy };
    delete expected.pdfVersion;
    assert.deepEqual(actual, { ...expected, layoutMode: "single-page" });
    assert.equal(updatedAt, "2026-10-11T08:00:00.000Z");
    const columns = f.api.repository.db.prepare("PRAGMA table_info(paper_reading_positions)").all();
    const layoutColumns = columns.filter((column) => column.name === "layout_mode");
    assert.equal(layoutColumns.length, 1);
    assert.equal(layoutColumns[0].notnull, 1);
    assert.equal(layoutColumns[0].dflt_value, "'single-page'");
    assert.deepEqual(f.api.repository.integrityCheck(), ["ok"]);
    if (restart < 2) await f.restart();
  }
});

test("continuous 坐标带布局标记往返保存，旧客户端缺省覆盖为 single-page", async (t) => {
  const f = await fixture(t, "layout-roundtrip");
  await f.importPdf();
  const version = (await f.request(readingPath)).body.pdfVersion;
  const continuous = position(version, { layoutMode: "continuous", pageNumber: 9, scrollOffset: 0.67 });
  const saved = await f.request(readingPath, { method: "PUT", body: JSON.stringify(continuous) });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.body.position.layoutMode, "continuous");
  await f.restart();
  const restored = await f.request(readingPath);
  assert.equal(restored.body.position.layoutMode, "continuous");
  assert.equal(restored.body.position.pageNumber, 9);
  assert.equal(restored.body.position.scrollOffset, 0.67);

  const legacy = position(version, { pageNumber: 2, scrollOffset: 0.25 });
  const overwritten = await f.request(readingPath, { method: "PUT", body: JSON.stringify(legacy) });
  assert.equal(overwritten.body.position.layoutMode, "single-page");
  assert.equal(overwritten.body.position.scrollOffset, 0.25);
  await f.restart();
  assert.equal((await f.request(readingPath)).body.position.layoutMode, "single-page");
  const versioned = await f.request(readingPath, { method: "PUT", body: JSON.stringify(position(version, { layoutMode: "continuous", scrollOffset: 0.95 })) });
  assert.equal(versioned.body.position.layoutMode, "continuous");
  assert.equal((await f.request(readingPath)).body.position.scrollOffset, 0.95);
  assert.throws(() => f.api.repository.db.prepare("UPDATE paper_reading_positions SET layout_mode = 'invalid'").run(), /CHECK/u);
});
