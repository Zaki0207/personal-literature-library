import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLibraryApi } from "../scripts/library-api.mjs";
import { validateApiRequest } from "../desktop/shared/security.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "pdf-sticky-notes-"));
  const options = { port: 0, dbPath: join(directory, "library.sqlite3"), backupDir: join(directory, "backups"), pdfDirectory: join(directory, "pdfs"), seedPath: join(directory, "seed.json") };
  await writeFile(options.seedPath, JSON.stringify({ categoryRecords: [], papers: [{ id: "sticky-paper", title: "Synthetic PDF notes", note: "Original paper note" }] }));
  let api, url;
  const start = async () => { api = await createLibraryApi(options); url = (await api.listen()).url; };
  await start();
  t.after(async () => { await api.close(); await rm(directory, { recursive: true, force: true }); });
  const request = async (path, { method = "GET", body, origin = "http://localhost:3000" } = {}) => {
    const response = await fetch(`${url}/api/papers/sticky-paper/${path}`, { method, headers: { Origin: origin, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  return { request, directory, get api() { return api; }, restart: async () => { await api.close(); await start(); }, importPdf: async (content) => {
    const response = await fetch(`${url}/api/papers/sticky-paper/pdf/import`, { method: "POST", headers: { Origin: "http://localhost:3000", "Content-Type": "application/pdf" }, body: Buffer.from(`%PDF-1.4\n${content}\n%%EOF\n`) });
    assert.equal(response.status, 200);
    return (await request("reading-position")).body.pdfVersion;
  } };
}
const input = (pdfVersion, patch = {}) => ({ pdfVersion, pageNumber: 2, pageCount: 4, xRatio: .25, yRatio: .4, body: "First **bold** sticky note\nSecond line", ...patch });

test("PDF sticky notes persist, edit idempotently, back up and delete without altering the paper note", async (t) => {
  const f = await fixture(t);
  const pdfVersion = await f.importPdf("first PDF");
  const saved = await f.request("pdf-notes/note-1", { method: "PUT", body: input(pdfVersion) });
  assert.equal(saved.status, 200); assert.equal(saved.body.backup.ok, true);
  assert.equal(saved.body.note.body, input(pdfVersion).body);
  const backup = new DatabaseSync(join(f.directory, "backups/library-latest.sqlite3"), { readOnly: true });
  try { assert.equal(backup.prepare("SELECT body FROM paper_pdf_notes WHERE id='note-1'").get().body, input(pdfVersion).body); } finally { backup.close(); }
  await f.restart();
  assert.equal((await f.request(`pdf-notes?pdfVersion=${encodeURIComponent(pdfVersion)}`)).body.notes.length, 1);
  const edited = await f.request("pdf-notes/note-1", { method: "PUT", body: input(pdfVersion, { body: "Updated sticky", xRatio: .8 }) });
  assert.equal(edited.body.note.createdAt, saved.body.note.createdAt);
  const list = (await f.request(`pdf-notes?pdfVersion=${encodeURIComponent(pdfVersion)}`)).body.notes;
  assert.equal(list.length, 1); assert.equal(list[0].body, "Updated sticky"); assert.equal(list[0].xRatio, .8);
  assert.equal(f.api.repository.getPaper("sticky-paper").note, "Original paper note");
  assert.equal((await f.request("pdf-notes/note-1", { method: "DELETE", body: { pdfVersion } })).status, 200);
  assert.equal((await f.request(`pdf-notes?pdfVersion=${encodeURIComponent(pdfVersion)}`)).body.notes.length, 0);
});

test("replacement PDFs retain old sticky text and reject writes from the obsolete version", async (t) => {
  const f = await fixture(t);
  const old = await f.importPdf("old PDF");
  await f.request("pdf-notes/note-1", { method: "PUT", body: input(old) });
  const current = await f.importPdf("new PDF");
  assert.notEqual(current, old);
  const listed = await f.request(`pdf-notes?pdfVersion=${encodeURIComponent(current)}`);
  assert.equal(listed.body.notes.length, 0); assert.equal(listed.body.previousNotes[0].body, input(old).body);
  assert.equal((await f.request("pdf-notes/note-1", { method: "PUT", body: input(old, { body: "stale" }) })).status, 409);
  assert.equal((await f.request("pdf-notes/note-1", { method: "PUT", body: input(current) })).status, 409);
  const same = await f.importPdf("old PDF");
  assert.equal(same, old);
  assert.equal((await f.request(`pdf-notes?pdfVersion=${encodeURIComponent(same)}`)).body.notes.length, 1);
});

test("invalid sticky positions, empty content, deleted papers and cross-origin writes are rejected", async (t) => {
  const f = await fixture(t);
  const pdfVersion = "fingerprint:notes-test";
  for (const patch of [{ pageNumber: 0 }, { pageNumber: 5 }, { xRatio: -1 }, { yRatio: 1.1 }, { body: " " }, { body: 1 }, { extra: true }, { pdfVersion: "../../file" }]) {
    assert.equal((await f.request("pdf-notes/note-1", { method: "PUT", body: input(pdfVersion, patch) })).status, 400);
  }
  assert.equal((await f.request("pdf-notes/note-1", { method: "PUT", body: input(pdfVersion), origin: "https://untrusted.example.test" })).status, 403);
  assert.equal(f.api.repository.db.prepare("SELECT count(*) AS count FROM paper_pdf_notes").get().count, 0);
  await f.api.repository.deletePaper("sticky-paper");
  assert.equal((await f.request("pdf-notes/note-1", { method: "PUT", body: input(pdfVersion) })).status, 404);
});

test("desktop bridge exposes only scoped PDF sticky-note routes", () => {
  for (const method of ["PUT", "DELETE"]) assert.equal(validateApiRequest({ path: "/api/papers/sticky-paper/pdf-notes/note-1", method, body: { pdfVersion: "fingerprint:test" } }).method, method);
  assert.equal(validateApiRequest({ path: "/api/papers/sticky-paper/pdf-notes?pdfVersion=fingerprint%3Atest" }).method, "GET");
  for (const path of ["/api/pdf-notes", "/api/papers/sticky-paper/pdf-notes?path=/etc/passwd", "/api/papers/sticky-paper/pdf-notes?pdfVersion=fingerprint:test&pdfVersion=fingerprint:other"]) assert.throws(() => validateApiRequest({ path }));
});

test("PDF highlights persist across restart, stay bound to the PDF version and can be removed", async (t) => {
  const f = await fixture(t);
  const pdfVersion = await f.importPdf("highlight PDF");
  const highlight = { pdfVersion, pageCount: 4, text: "A sentence crossing two pages.", rects: [
    { pageNumber: 1, xRatio: .2, yRatio: .9, widthRatio: .6, heightRatio: .03 },
    { pageNumber: 2, xRatio: .2, yRatio: .1, widthRatio: .4, heightRatio: .03 },
  ] };
  const save = (body) => f.request("pdf-highlights/highlight-1", { method: "PUT", body });
  const list = (version) => f.request(`pdf-highlights?pdfVersion=${encodeURIComponent(version)}`);
  assert.equal((await save({ ...highlight, rects: [{ ...highlight.rects[0], widthRatio: .9 }] })).status, 400);
  assert.equal((await save({ ...highlight, rects: [{ ...highlight.rects[0], pageNumber: 5 }] })).status, 400);
  assert.equal((await save(highlight)).body.backup.ok, true);
  assert.equal((await save(highlight)).status, 200);
  assert.equal((await f.request("pdf-highlights/duplicate", { method: "PUT", body: highlight })).status, 409);
  await f.restart();
  assert.deepEqual((await list(pdfVersion)).body.highlights, [{ id: "highlight-1", pdfVersion, text: highlight.text, rects: highlight.rects }]);
  const newVersion = await f.importPdf("replacement PDF");
  assert.deepEqual((await list(newVersion)).body.highlights, []);
  assert.equal((await save(highlight)).status, 409);
  assert.equal(await f.importPdf("highlight PDF"), pdfVersion);
  assert.equal((await list(pdfVersion)).body.highlights.length, 1);
  assert.equal((await f.request("pdf-highlights/highlight-1", { method: "DELETE", body: { pdfVersion } })).status, 200);
  assert.deepEqual((await list(pdfVersion)).body.highlights, []);
  assert.deepEqual((await f.request(`pdf-notes?pdfVersion=${encodeURIComponent(pdfVersion)}`)).body.notes, []);
});
