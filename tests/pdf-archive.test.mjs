import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLibraryApi } from "../scripts/library-api.mjs";

const SOURCE_URL = "https://papers.example.test/sample.pdf";
const UPDATED_SOURCE_URL = "https://papers.example.test/revised.pdf";
const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n% test PDF\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n",
  "utf8",
);

function seed() {
  return {
    categoryRecords: [],
    papers: [
      {
        id: "PDF00001",
        title: "Local PDF Archive Test Paper",
        zhTitle: "本地 PDF 归档测试论文",
        authors: "Test Author",
        institution: "Test Institute",
        source: "Test Conference",
        date: "2026-01-01",
        dateAdded: "2026-01-01T00:00:00.000Z",
        aiSummary: "",
        note: "",
        favorite: false,
        watchLater: false,
        hasPdf: true,
        pdfUrl: SOURCE_URL,
      },
    ],
  };
}

async function makeFixture(t, name) {
  const directory = await mkdtemp(join(tmpdir(), `pdf-archive-${name}-`));
  const dbPath = join(directory, "database", "library.sqlite3");
  const backupDir = join(directory, "backups");
  const pdfDirectory = join(directory, "pdfs");
  const seedPath = join(directory, "seed.json");
  await writeFile(seedPath, JSON.stringify(seed()), "utf8");

  let pdfFetch = async () => {
    throw new Error("测试未设置 PDF 下载响应。");
  };
  const api = await createLibraryApi({
    port: 0,
    dbPath,
    backupDir,
    pdfDirectory,
    seedPath,
    pdfFetch: (...args) => pdfFetch(...args),
  });
  const address = await api.listen();
  t.after(async () => {
    await api.close();
    await rm(directory, { recursive: true, force: true });
  });

  return {
    baseUrl: address.url,
    pdfDirectory,
    setPdfFetch(value) {
      pdfFetch = value;
    },
  };
}

async function jsonRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const body = await response.json();
  return { response, body };
}

function archiveOptions({ force = false } = {}) {
  return {
    method: "POST",
    headers: { Origin: "http://localhost:3000" },
    body: JSON.stringify({ force }),
  };
}

test("首次打开 PDF 跳转来源，归档成功后优先返回本地文件", async (t) => {
  const fixture = await makeFixture(t, "open-local");
  let downloadCount = 0;
  fixture.setPdfFetch(async (url, init) => {
    downloadCount += 1;
    assert.equal(String(url), SOURCE_URL);
    assert.equal(init.redirect, "manual");
    return new Response(PDF_BYTES, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(PDF_BYTES.length),
      },
    });
  });

  const before = await fetch(
    `${fixture.baseUrl}/api/papers/PDF00001/pdf/open`,
    { redirect: "manual" },
  );
  assert.equal(before.status, 302);
  assert.equal(before.headers.get("location"), SOURCE_URL);

  const archived = await jsonRequest(
    fixture.baseUrl,
    "/api/papers/PDF00001/pdf/archive",
    archiveOptions(),
  );
  assert.equal(archived.response.status, 200);
  assert.equal(archived.body.paper.pdfArchive.status, "ready");
  assert.equal(archived.body.paper.pdfArchive.sizeBytes, PDF_BYTES.length);
  assert.match(archived.body.paper.pdfArchive.downloadedAt, /^2026|^20/u);
  assert.equal(downloadCount, 1);

  const files = await readdir(fixture.pdfDirectory);
  assert.equal(files.filter((name) => name.endsWith(".pdf")).length, 1);

  const local = await fetch(
    `${fixture.baseUrl}/api/papers/PDF00001/pdf/open`,
    { redirect: "manual" },
  );
  assert.equal(local.status, 200);
  assert.match(local.headers.get("content-type") ?? "", /^application\/pdf/u);
  assert.match(local.headers.get("content-disposition") ?? "", /inline/u);
  assert.deepEqual(Buffer.from(await local.arrayBuffer()), PDF_BYTES);

  const range = await fetch(
    `${fixture.baseUrl}/api/papers/PDF00001/pdf/open`,
    { headers: { Range: "bytes=0-4" } },
  );
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), `bytes 0-4/${PDF_BYTES.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), PDF_BYTES.subarray(0, 5));
});

test("网页、权限错误和过大文件不会被误保存为 PDF", async (t) => {
  const fixture = await makeFixture(t, "invalid-content");
  fixture.setPdfFetch(async () =>
    new Response("<html><body>请登录</body></html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    }),
  );

  const archived = await jsonRequest(
    fixture.baseUrl,
    "/api/papers/PDF00001/pdf/archive",
    archiveOptions(),
  );
  assert.equal(archived.response.status, 422);
  assert.equal(archived.body.error.code, "PDF_INVALID_CONTENT");

  const library = await jsonRequest(fixture.baseUrl, "/api/library");
  const paper = library.body.papers.find((candidate) => candidate.id === "PDF00001");
  assert.equal(paper.pdfArchive.status, "failed");
  assert.equal(paper.pdfArchive.errorCode, "PDF_INVALID_CONTENT");
});

test("同一篇论文的并发归档只发起一次远程下载", async (t) => {
  const fixture = await makeFixture(t, "deduplicate");
  let downloadCount = 0;
  fixture.setPdfFetch(async () => {
    downloadCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return new Response(PDF_BYTES, {
      status: 200,
      headers: { "Content-Type": "application/pdf" },
    });
  });

  const [first, second] = await Promise.all([
    jsonRequest(
      fixture.baseUrl,
      "/api/papers/PDF00001/pdf/archive",
      archiveOptions(),
    ),
    jsonRequest(
      fixture.baseUrl,
      "/api/papers/PDF00001/pdf/archive",
      archiveOptions(),
    ),
  ]);
  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 200);
  assert.equal(downloadCount, 1);
});

test("编辑 PDF 来源后，已有本地副本会标记为待更新", async (t) => {
  const fixture = await makeFixture(t, "stale-source");
  fixture.setPdfFetch(async () =>
    new Response(PDF_BYTES, {
      status: 200,
      headers: { "Content-Type": "application/pdf" },
    }),
  );

  const archived = await jsonRequest(
    fixture.baseUrl,
    "/api/papers/PDF00001/pdf/archive",
    archiveOptions(),
  );
  assert.equal(archived.response.status, 200);

  const updated = await jsonRequest(
    fixture.baseUrl,
    "/api/papers/PDF00001",
    {
      method: "PATCH",
      body: JSON.stringify({ pdfUrl: UPDATED_SOURCE_URL }),
    },
  );
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.paper.pdfArchive.status, "stale");

  const open = await fetch(
    `${fixture.baseUrl}/api/papers/PDF00001/pdf/open`,
    { redirect: "manual" },
  );
  assert.equal(open.status, 302);
  assert.equal(open.headers.get("location"), UPDATED_SOURCE_URL);
});

test("用户可以手动导入和删除本地 PDF 副本", async (t) => {
  const fixture = await makeFixture(t, "manual-import");
  const imported = await fetch(
    `${fixture.baseUrl}/api/papers/PDF00001/pdf/import`,
    {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/pdf",
      },
      body: PDF_BYTES,
    },
  );
  const importedBody = await imported.json();
  assert.equal(imported.status, 200);
  assert.equal(importedBody.paper.pdfArchive.status, "ready");

  const removed = await jsonRequest(
    fixture.baseUrl,
    "/api/papers/PDF00001/pdf/archive",
    {
      method: "DELETE",
      headers: { Origin: "http://localhost:3000" },
    },
  );
  assert.equal(removed.response.status, 200);
  assert.equal(removed.body.paper.pdfArchive, undefined);

  const openedAfterRemoval = await fetch(
    `${fixture.baseUrl}/api/papers/PDF00001/pdf/open`,
    { redirect: "manual" },
  );
  assert.equal(openedAfterRemoval.status, 302);
  assert.equal(openedAfterRemoval.headers.get("location"), SOURCE_URL);
});
