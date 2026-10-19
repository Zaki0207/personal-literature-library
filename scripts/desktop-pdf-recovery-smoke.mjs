import { writeFile } from "node:fs/promises";

export const PDF_RECOVERY_RETRY_ID = "desktop-pdf-retry";
export const PDF_RECOVERY_IMPORT_ID = "desktop-pdf-import";
const RETRY_TITLE = "Desktop PDF download recovery verification";
const IMPORT_TITLE = "Desktop PDF local recovery verification";
const ORIGINAL_NOTE = "Synthetic recovery note retained before downloading a PDF.";

// Seed before Electron starts, then close the repository before the service
// becomes the only database writer. Every path is supplied by the temp runner.
export async function seedPdfRecoverySmoke({ dbPath, backupDir, invalidPdfPath }) {
  const { LibraryRepository } = await import("./library-repository.mjs");
  const repository = new LibraryRepository({ dbPath, backupDir, seedPath: null });
  try {
    await repository.initializeBackupStatus();
    for (const [id, title, originalUrl] of [
      [PDF_RECOVERY_RETRY_ID, RETRY_TITLE, "https://papers.example.test/recovery/article"],
      [PDF_RECOVERY_IMPORT_ID, IMPORT_TITLE, "https://synthetic-user:synthetic-secret@papers.example.test/recovery/article"],
    ]) {
      const pdfUrl = `https://papers.example.test/recovery/${id}.pdf`;
      await repository.createPaper({ id, title, authors: "Synthetic Test", institution: "Test", source: "Offline Recovery Test", date: "2025", categoryIds: [], aiSummary: "离线合成记录，仅验证 PDF 下载失败恢复。", note: ORIGINAL_NOTE, pdfUrl, originalUrl });
      await repository.recordPdfArchiveFailure(id, { sourceUrl: pdfUrl, errorCode: "PDF_SOURCE_HTTP_ERROR", errorMessage: "PDF 来源服务返回了 502。" });
    }
  } finally { await repository.close(); }
  await writeFile(invalidPdfPath, "This synthetic .pdf file is deliberately invalid.");
}

async function recoveryStep({ stage, id, title }) {
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`PDF 失败恢复验收超时：${label}；${JSON.stringify({ error: document.querySelector("[data-pdf-load-error]")?.textContent, recovery: document.querySelector("[data-pdf-recovery-error]")?.textContent, note: document.querySelector(".pdf-reader-notes-heading")?.textContent })}`);
  };
  const marker = (name) => document.querySelector(`[data-pdf-${name}]`);
  const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const note = () => document.querySelector(".pdf-reader-notes textarea");
  const library = async () => {
    const result = await window.literatureDesktop.request({ path: "/library" });
    if (result.status !== 200) throw new Error("无法检查临时论文库。");
    return result.body;
  };
  const paper = async () => (await library()).papers.find((candidate) => candidate.id === id);
  const open = async () => {
    const button = await waitFor(() => [...document.querySelectorAll(".paper-detail-title")].find((candidate) => candidate.textContent.trim() === title), "失败论文标题");
    button.click();
    await waitFor(() => marker("load-error") && marker("retry") && marker("import"), "502 错误恢复操作");
    if (!marker("load-error").textContent.includes("502")) throw new Error("阅读器没有显示具体来源 502 错误。");
    if (!marker("load-error").textContent.includes("本地 PDF")) throw new Error("阅读器缺少本地 PDF 恢复说明。");
    if (!note() || note().value !== "Synthetic recovery note retained before downloading a PDF.") throw new Error("PDF 打不开时无法读取原有笔记。");
  };
  const leave = async () => {
    document.querySelector(".pdf-reader-back").click();
    await waitFor(() => !document.querySelector(".pdf-reader"), "返回论文库");
  };
  const rendered = () => document.querySelector(".pdf-reader-page-surface canvas")?.width > 100 && document.querySelector(".pdf-reader-text-layer")?.textContent.includes("Gaussian reconstruction");
  if (stage === "open-retry") {
    await open();
    const current = await paper();
    if (current.pdfArchive?.status !== "failed" || !current.pdfArchive.errorMessage?.includes("502")) throw new Error("预先失败的 PDF 元数据没有保留。");
    if (!marker("source") || !marker("original")) throw new Error("公开来源缺少浏览器恢复入口。");
    marker("source").click();
    await settle();
    marker("original").click();
    await settle();
    return { failureVisible: true, originalNoteReadable: true, failedMetadataPreserved: true, sourceActionsAvailable: true };
  }
  if (stage === "retry") {
    marker("retry").click();
    await waitFor(rendered, "重试后真实 PDF worker 与画布");
    if (marker("load-error") || note().value !== "Synthetic recovery note retained before downloading a PDF.") throw new Error("重试成功没有移除错误或保留笔记。");
    const current = await paper();
    if (current.pdfArchive?.status !== "ready") throw new Error("重试成功没有更新本地 PDF 状态。");
    await leave();
    return { retryRenderedRealPdf: true, retryNotePreserved: true, retryReadyPersisted: true };
  }
  if (stage === "open-import") {
    await open();
    if (marker("original") || marker("load-error").textContent.includes("synthetic-secret") || marker("load-error").textContent.includes("synthetic-user")) throw new Error("含认证信息的原文地址被显示或允许打开。");
    return { credentialLinkHidden: true };
  }
  if (stage === "cancel") {
    const before = await paper();
    const count = (await library()).papers.length;
    marker("import").click();
    await waitFor(() => !marker("import").disabled, "取消系统选取恢复可操作状态");
    await settle();
    const after = await paper();
    if (marker("recovery-error") || JSON.stringify(before) !== JSON.stringify(after) || (await library()).papers.length !== count) throw new Error("取消 PDF 选取改变资料、创建论文或显示错误。");
    return { cancelledSelectionNoWrite: true };
  }
  if (stage === "invalid") {
    marker("import").click();
    await waitFor(() => marker("recovery-error")?.textContent.includes("不是有效 PDF") && !marker("import").disabled, "无效文件拒绝并恢复操作");
    if ((await paper()).pdfArchive?.status !== "failed" || note().value !== "Synthetic recovery note retained before downloading a PDF.") throw new Error("无效导入改变失败状态或丢失笔记。");
    return { invalidPdfRejected: true, invalidImportNotePreserved: true };
  }
  if (stage === "prepare-note-failure") {
    const deleted = await window.literatureDesktop.request({ path: `/papers/${id}`, method: "DELETE" });
    if (deleted.status !== 200) throw new Error("无法准备临时笔记保存失败。");
    const draft = "Synthetic recovery draft retained after note-save failure.";
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(note(), draft);
    note().dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => document.querySelector(".pdf-reader-notes-heading .is-failed"), "笔记保存失败");
    return { draft };
  }
  if (stage === "note-failure") {
    marker("import").click();
    await waitFor(() => marker("recovery-error")?.textContent.includes("笔记尚未保存") && !marker("import").disabled, "保存失败保护导入");
    if (note().value !== "Synthetic recovery draft retained after note-save failure." || localStorage.getItem(`literature:reading-note:${id}`) !== note().value) throw new Error("导入前保存失败丢失笔记草稿。");
    const restored = await window.literatureDesktop.request({ path: `/papers/${id}/restore`, method: "POST" });
    if (restored.status !== 200) throw new Error("无法恢复临时论文。");
    [...document.querySelectorAll(".pdf-reader-note-error button")].find((button) => button.textContent.includes("重试保存笔记")).click();
    await waitFor(() => document.querySelector(".pdf-reader-notes-heading .is-saved"), "原笔记保存失败后重试");
    return { noteSaveFailurePreventsImport: true, noteDraftPreserved: true };
  }
  if (stage === "start-import") {
    marker("import").click();
    await waitFor(() => marker("import")?.disabled, "导入中按钮锁定");
    if (!document.querySelector(".pdf-reader-back").disabled || !marker("retry").disabled || !marker("source").disabled) throw new Error("导入中仍允许离开或重试／打开来源。");
    const decision = await new Promise((resolve) => window.dispatchEvent(new CustomEvent("literature-save-before-quit", { detail: { complete: resolve } })));
    if (decision) throw new Error("PDF 导入未结束时允许退出。");
    return { busyActionsProtected: true, busyDeclinesQuit: true };
  }
  if (stage === "imported") {
    await waitFor(rendered, "本地 PDF 导入后重新载入阅读器");
    if (marker("load-error") || note().value !== "Synthetic recovery draft retained after note-save failure.") throw new Error("导入完成丢失笔记草稿或仍显示来源错误。");
    const current = await paper();
    if (current.pdfArchive?.status !== "ready" || current.note !== note().value) throw new Error("本地 PDF 没有绑定现有论文与笔记。");
    if (document.querySelector(".paper-intake-modal")) throw new Error("阅读器导入重新打开了论文录入。");
    await leave();
    return { localImportRenderedRealPdf: true, localImportPreservedPaperAndNote: true, localImportReadyPersisted: true };
  }
  if (stage === "failure-layout") {
    await waitFor(() => !document.querySelector(".toast"), "前次验收提示自然消失后检查布局");
    await settle();
    const error = marker("load-error");
    if (!error) throw new Error("布局截图缺少 PDF 失败状态。");
    const viewport = document.querySelector(".pdf-reader-viewport").getBoundingClientRect();
    if (document.documentElement.scrollWidth > innerWidth + 1) throw new Error("错误恢复界面横向溢出。");
    for (const button of error.querySelectorAll("button")) {
      const bounds = button.getBoundingClientRect();
      if (bounds.left < viewport.left - 1 || bounds.right > viewport.right + 1 || bounds.top < viewport.top - 1 || bounds.bottom > viewport.bottom + 1) throw new Error("错误恢复操作被阅读区裁切。");
    }
    return { width: innerWidth, height: innerHeight, actionsAccessible: true };
  }
  throw new Error(`未知 PDF 恢复验收阶段：${stage}`);
}

const step = (window, stage, id = PDF_RECOVERY_IMPORT_ID, title = IMPORT_TITLE) => window.webContents.executeJavaScript(`(${recoveryStep.toString()})(${JSON.stringify({ stage, id, title })})`);

export async function verifyDesktopPdfRecovery(window, hooks) {
  const bounds = window.getBounds();
  const report = {};
  try {
    Object.assign(report, await step(window, "open-retry", PDF_RECOVERY_RETRY_ID, RETRY_TITLE));
    await hooks.verifyExternalUrls();
    hooks.retryReady();
    Object.assign(report, await step(window, "retry", PDF_RECOVERY_RETRY_ID, RETRY_TITLE));
    Object.assign(report, await step(window, "open-import"));
    report.layout = [];
    for (const [width, height] of [[920, 640], [1280, 800]]) {
      window.setContentSize(width, height, false);
      report.layout.push(await step(window, "failure-layout"));
      if (hooks.screenshotPath) await writeFile(hooks.screenshotPath.replace(/\.png$/u, `-${width}.png`), (await window.webContents.capturePage()).toPNG());
    }
    hooks.select("cancel");
    Object.assign(report, await step(window, "cancel"));
    hooks.select("invalid");
    Object.assign(report, await step(window, "invalid"));
    await step(window, "prepare-note-failure");
    hooks.select("valid");
    Object.assign(report, await step(window, "note-failure"));
    hooks.assertNoImports();
    const release = hooks.holdImport();
    hooks.select("valid");
    try { Object.assign(report, await step(window, "start-import")); }
    finally { release(); }
    Object.assign(report, await step(window, "imported"));
    hooks.assertImportBoundToCurrentPaper();
    return report;
  } finally { window.setBounds(bounds, false); }
}
