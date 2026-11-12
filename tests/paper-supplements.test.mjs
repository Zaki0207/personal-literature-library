import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createLibraryApi } from "../scripts/library-api.mjs";

test("手动添加的补充材料按论文保存，并独立于正文 PDF", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "paper-supplements-"));
  const options = { dbPath: join(directory, "library.sqlite3"), backupDir: join(directory, "backups"), pdfDirectory: join(directory, "pdfs"), seedPath: null, port: 0 };
  let api = await createLibraryApi(options);
  t.after(async () => {
    await api.close();
    await rm(directory, { force: true, recursive: true });
  });

  const paperId = "existing.paper:1";
  const paper = (await api.repository.createPaper({ id: paperId, title: "Synthetic Paper", note: "Existing note" })).paper;
  await api.repository.createPaper({ id: "other-paper", title: "Other Synthetic Paper" });
  const pdf = Buffer.from("%PDF-1.4\n%%EOF\n");
  const main = (await api.pdfArchiveService.importPdf(paperId, Readable.from([pdf]))).paper;
  const name = "补充实验 (作者's).txt";
  const original = join(directory, name);
  const content = Buffer.from("补充实验记录\n");
  await writeFile(original, content);
  const imported = await api.paperSupplementsService.importLocalFile(paperId, original);
  const [first] = imported.paper.supplements;
  assert.deepEqual({ name: first.name, sizeBytes: first.sizeBytes }, { name, sizeBytes: content.length });
  assert.deepEqual(imported.paper.pdfArchive, main.pdfArchive);
  assert.equal(imported.paper.note, paper.note);

  const archiveDir = api.paperSupplementsService.directory;
  const address = await api.listen();
  const collection = `${address.url}/api/papers/${encodeURIComponent(paperId)}/supplements`;
  const upload = (filename, body, origin = "http://localhost:3000") => fetch(`${collection}?name=${encodeURIComponent(filename)}`, {
    method: "POST", headers: { "Content-Type": "application/octet-stream", Origin: origin }, body,
  });
  assert.equal((await upload("../escape.txt", content)).status, 400);
  assert.equal((await upload(name, content, "https://untrusted.example")).status, 403);
  const uploadResults = await Promise.all([upload("补充材料.pdf", pdf), upload("补充材料.pdf", pdf)]);
  assert.deepEqual(uploadResults.map((response) => response.status).sort(), [200, 201]);
  const second = (await uploadResults[0].json()).paper.supplements[1];
  await uploadResults[1].json();
  assert.equal((await readdir(archiveDir)).length, 2);
  assert.equal((await fetch(`${address.url}/api/papers/other-paper/supplements/${first.id}`)).status, 404);

  await api.close();
  api = await createLibraryApi(options);
  const restarted = await api.listen();
  const afterRestart = api.repository.getPaper(paperId);
  assert.deepEqual(afterRestart.supplements, [first, second]);
  const downloadUrl = `${restarted.url}/api/papers/${encodeURIComponent(paperId)}/supplements/${first.id}`;
  const download = await fetch(downloadUrl);
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), /^attachment; .*filename\*=UTF-8''.*%28.*%27.*%29\.txt$/u);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), content);
  assert.equal((await fetch(downloadUrl, { method: "DELETE" })).status, 200);
  assert.equal((await fetch(downloadUrl, { method: "DELETE" })).status, 200);
  assert.equal((await fetch(downloadUrl)).status, 404);
  assert.deepEqual(await readdir(archiveDir), [second.id]);
  assert.deepEqual(await readFile(original), content);
  assert.deepEqual(await readFile((await api.pdfArchiveService.getLocalPdf(paperId)).path), pdf);

  await api.repository.deletePaper(paperId);
  await assert.rejects(api.paperSupplementsService.getLocalFile(paperId, second.id), { code: "NOT_FOUND" });
  const restored = await api.repository.restorePaper(paperId);
  assert.deepEqual(restored.paper.supplements, [second]);
});

test("写入中断后清理补充材料副本，允许重新添加", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "paper-supplement-interrupted-"));
  const api = await createLibraryApi({ dbPath: join(directory, "library.sqlite3"), backupDir: join(directory, "backups"), seedPath: null });
  t.after(async () => {
    await api.close();
    await rm(directory, { force: true, recursive: true });
  });
  const { paper } = await api.repository.createPaper({ title: "Interrupted Supplement Test Paper" });
  const brokenStream = Readable.from((async function* () {
    yield Buffer.from("partial data");
    throw new Error("interrupted");
  })());
  const service = api.paperSupplementsService;
  await assert.rejects(service.importFile(paper.id, "data.csv", brokenStream), /interrupted/u);
  assert.deepEqual(await readdir(service.directory), []);
  assert.equal(api.repository.getPaper(paper.id).supplements, undefined);
  const retry = await service.importFile(paper.id, "data.csv", Readable.from([Buffer.from("complete data")]));
  assert.equal(retry.paper.supplements.length, 1);
});
