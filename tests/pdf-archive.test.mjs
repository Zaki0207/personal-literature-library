import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createLibraryApi } from "../scripts/library-api.mjs";
import { createPdfArchiveService } from "../scripts/pdf-archive-service.mjs";

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
  api.pdfArchiveService.retryDelayMs = 0;
  t.after(async () => {
    await api.close();
    await rm(directory, { recursive: true, force: true });
  });

  return {
    baseUrl: address.url,
    pdfDirectory,
    archiveService: api.pdfArchiveService,
    repository: api.repository,
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

function openResponse(status, onCancel, headers = {}) {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from("provider response containing private debug details"));
    },
    cancel() {
      onCancel();
    },
  }), { status, headers });
}

test("502、503 短暂失败会自动重试，释放错误响应并共享并发下载", async (t) => {
  const fixture = await makeFixture(t, "transient-recovery");
  let calls = 0;
  let cancellations = 0;
  const signals = [];
  fixture.setPdfFetch(async (_url, init) => {
    calls += 1;
    signals.push(init.signal);
    if (calls <= 2) return openResponse(calls === 1 ? 502 : 503, () => { cancellations += 1; });
    return new Response(PDF_BYTES, { headers: { "Content-Type": "application/pdf" } });
  });
  const [first, second] = await Promise.all([
    jsonRequest(fixture.baseUrl, "/api/papers/PDF00001/pdf/archive", archiveOptions()),
    jsonRequest(fixture.baseUrl, "/api/papers/PDF00001/pdf/archive", archiveOptions()),
  ]);
  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 200);
  assert.equal(first.body.paper.pdfArchive.status, "ready");
  assert.equal(calls, 3);
  assert.equal(cancellations, 2);
  assert.equal(new Set(signals).size, 1);
  assert.equal((await readdir(fixture.pdfDirectory)).filter((name) => name.endsWith(".pdf")).length, 1);
});

test("持续 502 最多下载三次，返回可操作的原因且不泄露来源正文", async (t) => {
  const fixture = await makeFixture(t, "retry-limit");
  let calls = 0;
  let cancellations = 0;
  fixture.setPdfFetch(async () => {
    calls += 1;
    return openResponse(502, () => { cancellations += 1; });
  });
  const result = await jsonRequest(fixture.baseUrl, "/api/papers/PDF00001/pdf/archive", archiveOptions());
  assert.equal(result.response.status, 502);
  assert.equal(result.body.error.code, "PDF_DOWNLOAD_FAILED");
  assert.match(result.body.error.message, /来源暂时不可用.*HTTP 502.*稍后重试.*浏览器下载后导入本地 PDF/u);
  assert.deepEqual(result.body.error.details, { status: 502, retryable: true, attempts: 3 });
  assert.equal(calls, 3);
  assert.equal(cancellations, 3);
  assert.doesNotMatch(JSON.stringify(result.body.error), /papers\.example|private debug/u);
  const record = fixture.repository.getPdfArchiveRecord("PDF00001");
  assert.equal(record.status, "failed");
  assert.equal(record.lastErrorCode, "PDF_DOWNLOAD_FAILED");
  assert.equal(record.lastErrorMessage, result.body.error.message);
});

test("权限、404、限流和无效 PDF 不自动重试，并释放未使用的响应", async (t) => {
  const fixture = await makeFixture(t, "non-retryable");
  for (const status of [401, 403, 404, 429]) {
    let calls = 0;
    let cancellations = 0;
    fixture.setPdfFetch(async () => {
      calls += 1;
      return openResponse(status, () => { cancellations += 1; });
    });
    const result = await jsonRequest(fixture.baseUrl, "/api/papers/PDF00001/pdf/archive", archiveOptions());
    assert.equal(calls, 1);
    assert.equal(cancellations, 1);
    assert.deepEqual(result.body.error.details, { status, retryable: false, attempts: 1 });
  }
  let calls = 0;
  let cancellations = 0;
  fixture.setPdfFetch(async () => {
    calls += 1;
    return openResponse(200, () => { cancellations += 1; }, { "Content-Type": "text/html" });
  });
  const html = await jsonRequest(fixture.baseUrl, "/api/papers/PDF00001/pdf/archive", archiveOptions());
  assert.equal(html.body.error.code, "PDF_INVALID_CONTENT");
  assert.deepEqual(html.body.error.details, { status: 200, retryable: false, attempts: 1 });
  assert.equal(calls, 1);
  assert.equal(cancellations, 1);
  calls = 0;
  fixture.setPdfFetch(async () => {
    calls += 1;
    return new Response("This is not a PDF", { headers: { "Content-Type": "application/pdf" } });
  });
  const invalid = await jsonRequest(fixture.baseUrl, "/api/papers/PDF00001/pdf/archive", archiveOptions());
  assert.equal(invalid.body.error.code, "PDF_INVALID_CONTENT");
  assert.equal(calls, 1);
  assert.deepEqual(await readdir(join(fixture.pdfDirectory, ".tmp")), []);
});

test("重试时从原链接重新检查每次重定向及 DNS，先取消重定向正文", async (t) => {
  const fixture = await makeFixture(t, "retry-redirects");
  const target = "https://cdn.example.test/archive.pdf";
  const requested = [];
  const lookups = [];
  let cancellations = 0;
  const service = createPdfArchiveService({
    repository: fixture.repository,
    pdfDirectory: fixture.pdfDirectory,
    retryDelayMs: 0,
    resolveHost: async (host) => {
      lookups.push(host);
      return [{ address: "93.184.215.14", family: 4 }];
    },
    fetchImpl: async (url, init) => {
      requested.push(String(url));
      assert.equal(init.redirect, "manual");
      if (String(url) === SOURCE_URL) {
        return openResponse(302, () => { cancellations += 1; }, { Location: target });
      }
      assert.equal(cancellations, requested.length === 2 ? 1 : 3);
      if (requested.length === 2) return openResponse(502, () => { cancellations += 1; });
      return new Response(PDF_BYTES, { headers: { "Content-Type": "application/pdf" } });
    },
  });
  const result = await service.archive("PDF00001");
  assert.equal(result.paper.pdfArchive.status, "ready");
  assert.deepEqual(requested, [SOURCE_URL, target, SOURCE_URL, target]);
  assert.deepEqual(lookups, ["papers.example.test", "cdn.example.test", "papers.example.test", "cdn.example.test"]);
  assert.equal(cancellations, 3);
});

test("重定向到局域网或重试后 DNS 改为内网时不请求被阻止的地址", async (t) => {
  const fixture = await makeFixture(t, "retry-safety");
  let calls = 0;
  let cancellations = 0;
  fixture.setPdfFetch(async () => {
    calls += 1;
    return openResponse(302, () => { cancellations += 1; }, { Location: "http://127.0.0.1/private.pdf" });
  });
  await assert.rejects(fixture.archiveService.archive("PDF00001"), (error) => {
    assert.equal(error.code, "PDF_SOURCE_NOT_ALLOWED");
    assert.equal(error.details.retryable, false);
    assert.equal(error.details.attempts, 1);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(cancellations, 1);
  let lookups = 0;
  calls = 0;
  const service = createPdfArchiveService({
    repository: fixture.repository,
    pdfDirectory: fixture.pdfDirectory,
    retryDelayMs: 0,
    resolveHost: async () => {
      lookups += 1;
      return [{ address: lookups === 1 ? "93.184.215.14" : "192.168.1.10", family: 4 }];
    },
    fetchImpl: async () => {
      calls += 1;
      return new Response("unavailable", { status: 502 });
    },
  });
  await assert.rejects(service.archive("PDF00001"), (error) => {
    assert.equal(error.code, "PDF_SOURCE_NOT_ALLOWED");
    assert.equal(error.details.retryable, false);
    assert.equal(error.details.attempts, 2);
    return true;
  });
  assert.equal(lookups, 2);
  assert.equal(calls, 1);
});

test("只有明确的瞬态网络错误会重试，证书和未知异常立即失败", async (t) => {
  const fixture = await makeFixture(t, "network-retry");
  let calls = 0;
  fixture.setPdfFetch(async () => {
    calls += 1;
    if (calls < 3) throw new TypeError("fetch failed with private debug", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
    return new Response(PDF_BYTES);
  });
  await fixture.archiveService.archive("PDF00001");
  assert.equal(calls, 3);
  for (const code of ["CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNKNOWN_NETWORK_ERROR"]) {
    calls = 0;
    fixture.setPdfFetch(async () => {
      calls += 1;
      throw new TypeError("fetch failed with private debug", { cause: Object.assign(new Error("private certificate details"), { code }) });
    });
    await assert.rejects(fixture.archiveService.archive("PDF00001", { force: true }), (error) => {
      assert.ok(error.details, error.stack);
      assert.equal(error.details.retryable, false);
      assert.equal(error.details.attempts, 1);
      assert.doesNotMatch(error.message, /private/u);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("Retry-After 不会造成长等待，重试和下载共享同一个总超时", async (t) => {
  const fixture = await makeFixture(t, "bounded-wait");
  const delays = [];
  fixture.archiveService.retryWait = async (delayMs, signal) => {
    delays.push(delayMs);
    signal.throwIfAborted();
  };
  let calls = 0;
  fixture.setPdfFetch(async () => {
    calls += 1;
    return new Response("unavailable", {
      status: calls === 1 ? 503 : 504,
      headers: { "Retry-After": calls === 1 ? "3600" : new Date(Date.now() + 60_000).toUTCString() },
    });
  });
  await assert.rejects(fixture.archiveService.archive("PDF00001"));
  assert.deepEqual(delays, [2_000, 2_000]);
  assert.equal(calls, 3);
  const deadlineService = createPdfArchiveService({
    repository: fixture.repository,
    pdfDirectory: fixture.pdfDirectory,
    timeoutMs: 40,
    retryDelayMs: 400,
    fetchImpl: async (_url, init) => {
      calls += 1;
      signals.push(init.signal);
      return new Response("unavailable", { status: 502 });
    },
  });
  calls = 0;
  const signals = [];
  await assert.rejects(deadlineService.archive("PDF00001"), (error) => {
    assert.equal(error.code, "PDF_TIMEOUT");
    assert.deepEqual(error.details, { status: 502, retryable: true, attempts: 1 });
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(signals[0].aborted, true);
});

test("总超时也会中断停滞的 PDF 内容流并删除未完成文件", async (t) => {
  const fixture = await makeFixture(t, "stream-timeout");
  fixture.archiveService.timeoutMs = 40;
  let cancelled = false;
  fixture.setPdfFetch(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(PDF_BYTES); },
    cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "application/pdf" } }));
  await assert.rejects(fixture.archiveService.archive("PDF00001"), (error) => {
    assert.equal(error.code, "PDF_TIMEOUT");
    assert.deepEqual(error.details, { status: 200, retryable: true, attempts: 1 });
    return true;
  });
  assert.equal(cancelled, true);
  assert.deepEqual(await readdir(join(fixture.pdfDirectory, ".tmp")), []);
  assert.equal((await readdir(fixture.pdfDirectory)).filter((name) => name.endsWith(".pdf")).length, 0);
});

test("DNS 检查卡住时总超时照常结束，解析后来完成也不会发起远程请求", async (t) => {
  const fixture = await makeFixture(t, "dns-timeout");
  let finishLookup;
  const lookupPending = new Promise((resolve) => { finishLookup = resolve; });
  let calls = 0;
  const service = createPdfArchiveService({
    repository: fixture.repository,
    pdfDirectory: fixture.pdfDirectory,
    timeoutMs: 30,
    resolveHost: async () => lookupPending,
    fetchImpl: async () => { calls += 1; return new Response(PDF_BYTES); },
  });
  await assert.rejects(service.archive("PDF00001"), (error) => {
    assert.equal(error.code, "PDF_TIMEOUT");
    assert.deepEqual(error.details, { retryable: true, attempts: 1 });
    return true;
  });
  finishLookup([{ address: "93.184.215.14", family: 4 }]);
  await delay(0);
  assert.equal(calls, 0);
});

test("超时后才返回的响应被取消，不会保存 PDF 或留存下载任务", async (t) => {
  const fixture = await makeFixture(t, "late-response");
  fixture.archiveService.timeoutMs = 30;
  let finishRequest;
  let cancelled = false;
  fixture.setPdfFetch(async () => new Promise((resolve) => { finishRequest = resolve; }));
  await assert.rejects(fixture.archiveService.archive("PDF00001"), (error) => {
    assert.equal(error.code, "PDF_TIMEOUT");
    return true;
  });
  finishRequest(openResponse(200, () => { cancelled = true; }, { "Content-Type": "application/pdf" }));
  await delay(0);
  assert.equal(cancelled, true);
  assert.equal(await fixture.archiveService.getLocalPdf("PDF00001"), null);
  assert.equal(fixture.archiveService.inFlight.size, 0);
});

test("强制更新持续失败时保留已归档的 PDF 和文件，继续优先本地阅读", async (t) => {
  const fixture = await makeFixture(t, "preserve-ready");
  fixture.setPdfFetch(async () => new Response(PDF_BYTES));
  await fixture.archiveService.archive("PDF00001");
  const original = fixture.repository.getPdfArchiveRecord("PDF00001");
  let calls = 0;
  fixture.setPdfFetch(async () => {
    calls += 1;
    return new Response("unavailable", { status: 502 });
  });
  await assert.rejects(fixture.archiveService.archive("PDF00001", { force: true }), (error) => {
    assert.equal(error.code, "PDF_DOWNLOAD_FAILED", error.stack);
    return true;
  });
  const updated = fixture.repository.getPdfArchiveRecord("PDF00001");
  assert.equal(calls, 3);
  assert.equal(updated.status, "ready");
  assert.equal(updated.storageKey, original.storageKey);
  assert.equal(updated.sha256, original.sha256);
  assert.equal(updated.lastErrorCode, "PDF_DOWNLOAD_FAILED");
  const local = await fixture.archiveService.getLocalPdf("PDF00001");
  assert.deepEqual(await readFile(local.path), PDF_BYTES);
  const alreadyArchived = await fixture.archiveService.archive("PDF00001");
  assert.equal(alreadyArchived.alreadyArchived, true);
  assert.equal(calls, 3);
  const opened = await fetch(`${fixture.baseUrl}/api/papers/PDF00001/pdf/open`, { redirect: "manual" });
  assert.equal(opened.status, 200);
  assert.deepEqual(Buffer.from(await opened.arrayBuffer()), PDF_BYTES);
});

test("IEEE 的已知登录重定向直接提示认证，不再请求登录页面或重试", async (t) => {
  const fixture = await makeFixture(t, "ieee-login");
  let calls = 0;
  let cancellations = 0;
  fixture.setPdfFetch(async () => {
    calls += 1;
    return openResponse(302, () => { cancellations += 1; }, {
      Location: "https://ieeexplore.ieee.org/Xplore/login.jsp?url=%2Fielam%2Farticle.pdf",
    });
  });
  const result = await jsonRequest(fixture.baseUrl, "/api/papers/PDF00001/pdf/archive", archiveOptions());
  assert.equal(result.response.status, 422);
  assert.equal(result.body.error.code, "PDF_AUTH_REQUIRED");
  assert.match(result.body.error.message, /IEEE 登录页.*浏览器登录.*导入本地 PDF/u);
  assert.deepEqual(result.body.error.details, { status: 302, retryable: false, attempts: 1 });
  assert.equal(calls, 1);
  assert.equal(cancellations, 1);
});

test("正常 arXiv PDF 重定向继续下载，不被登录识别误伤", async (t) => {
  const fixture = await makeFixture(t, "arxiv-redirect");
  const requested = [];
  fixture.setPdfFetch(async (url) => {
    requested.push(String(url));
    if (requested.length === 1) return new Response(null, {
      status: 302,
      headers: { Location: "https://arxiv.org/pdf/2409.07715v1" },
    });
    return new Response(PDF_BYTES, { headers: { "Content-Type": "application/pdf" } });
  });
  const result = await fixture.archiveService.archive("PDF00001");
  assert.equal(result.paper.pdfArchive.status, "ready");
  assert.deepEqual(requested, [SOURCE_URL, "https://arxiv.org/pdf/2409.07715v1"]);
});

test("已手动导入的 PDF 优先本地使用，不受保存的远程链接失败影响", async (t) => {
  const fixture = await makeFixture(t, "manual-local-priority");
  await fixture.archiveService.importPdf("PDF00001", Readable.from([PDF_BYTES]));
  let calls = 0;
  fixture.setPdfFetch(async () => {
    calls += 1;
    return new Response("unavailable", { status: 502 });
  });
  const result = await fixture.archiveService.archive("PDF00001");
  assert.equal(result.alreadyArchived, true);
  assert.equal(result.paper.pdfArchive.status, "ready");
  assert.equal(calls, 0);
  const local = await fixture.archiveService.getLocalPdf("PDF00001");
  assert.deepEqual(await readFile(local.path), PDF_BYTES);
  await assert.rejects(fixture.archiveService.archive("PDF00001", { force: true }));
  assert.equal(calls, 3);
  assert.equal(fixture.repository.getPdfArchiveRecord("PDF00001").sourceUrl, "");
  const stillLocal = await fixture.archiveService.archive("PDF00001");
  assert.equal(stillLocal.alreadyArchived, true);
  assert.equal(calls, 3);
});

test("文件大小上限在响应头和内容流中都有效，超大文件不重试也不落盘", async (t) => {
  const fixture = await makeFixture(t, "size-limit");
  fixture.archiveService.maxBytes = PDF_BYTES.length - 1;
  let calls = 0;
  let cancellations = 0;
  fixture.setPdfFetch(async () => {
    calls += 1;
    return openResponse(200, () => { cancellations += 1; }, {
      "Content-Type": "application/pdf",
      "Content-Length": String(PDF_BYTES.length),
    });
  });
  await assert.rejects(fixture.archiveService.archive("PDF00001"), (error) => {
    assert.equal(error.code, "PDF_TOO_LARGE");
    assert.deepEqual(error.details, { status: 200, retryable: false, attempts: 1 });
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(cancellations, 1);
  calls = 0;
  fixture.setPdfFetch(async () => { calls += 1; return new Response(PDF_BYTES); });
  await assert.rejects(fixture.archiveService.archive("PDF00001"), (error) => {
    assert.equal(error.code, "PDF_TOO_LARGE");
    return true;
  });
  assert.equal(calls, 1);
  assert.deepEqual(await readdir(join(fixture.pdfDirectory, ".tmp")), []);
  assert.equal((await readdir(fixture.pdfDirectory)).filter((name) => name.endsWith(".pdf")).length, 0);
});

test("只有手动 PDF 而无远程链接的论文仍能读取，显式 force 才尝试更新", async (t) => {
  const fixture = await makeFixture(t, "manual-only");
  const updated = await jsonRequest(fixture.baseUrl, "/api/papers/PDF00001", {
    method: "PATCH",
    body: JSON.stringify({ pdfUrl: "" }),
  });
  assert.equal(updated.response.status, 200);
  await fixture.archiveService.importPdf("PDF00001", Readable.from([PDF_BYTES]));
  let calls = 0;
  fixture.setPdfFetch(async () => { calls += 1; throw new Error("must not fetch"); });
  const result = await fixture.archiveService.archive("PDF00001");
  assert.equal(result.alreadyArchived, true);
  assert.equal(result.paper.pdfArchive.status, "ready");
  await assert.rejects(fixture.archiveService.archive("PDF00001", { force: true }), (error) => {
    assert.equal(error.code, "PDF_SOURCE_UNAVAILABLE");
    return true;
  });
  assert.equal(calls, 0);
  assert.notEqual(await fixture.archiveService.getLocalPdf("PDF00001"), null);
});
