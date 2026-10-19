export { createSmokePdf, createLongSmokePdf } from "./desktop-pdf-fixture.mjs";

export const NAVIGATION_NO_PDF_TITLE = "Desktop navigation without PDF";

export function createNavigationSmokePapers() {
  return Array.from({ length: 24 }, (_, index) => ({
    id: `desktop-navigation-${String(index + 1).padStart(2, "0")}`,
    title: index === 0 ? NAVIGATION_NO_PDF_TITLE : `Desktop navigation context ${String(index + 1).padStart(2, "0")}`,
    zhTitle: `导航验收文献 ${index + 1}`,
    authors: "Synthetic Test Author", institution: "Synthetic Test Institute",
    source: "Navigation Test", date: "2026", categoryIds: [],
    aiSummary: "这条离线合成记录用于验证阅读返回后保留搜索、列表模式和滚动位置。",
    note: "", hasPdf: false,
  }));
}

// This function runs in the renderer through webContents.executeJavaScript.
// It exercises the production React UI and the real PDF worker and local API.
async function verifyReader(title) {
  const report = {};
  const currentPageNumber = () => Number(document.querySelector(".pdf-reader-page-controls input")?.value);
  const pageLayer = (pageNumber = currentPageNumber()) => document.querySelector(`.pdf-reader-page-surface[data-page-number="${pageNumber}"] .pdf-reader-text-layer`);
  const waitFor = async (predicate, stage, timeout = 12_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      const error = document.querySelector(".pdf-reader-empty[role='alert']");
      if (error) throw new Error(`${stage}: ${error.textContent}`);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    throw new Error(`阅读器验证超时：${stage}`);
  };
  const input = (element, value) => {
    const prototype = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const open = async () => {
    const card = await waitFor(() => [...document.querySelectorAll(".paper-card")].find((candidate) => candidate.textContent.includes(title)), "文献卡片");
    const titleButton = card.querySelector(".paper-detail-title");
    if (!titleButton) throw new Error("文献卡片缺少标题入口。");
    titleButton.focus({ preventScroll: true });
    titleButton.click();
    await waitFor(() => document.querySelector(`.pdf-reader-page-surface[data-page-number="${currentPageNumber()}"] canvas`)?.width > 100 && pageLayer()?.textContent.length > 10, "PDF 页面与文字层");
    if (document.querySelector(".paper-preview-layer")) throw new Error("标题点击仍打开了重复卡片弹窗。");
  };
  await open();
  report.cardTitleOpensReader = true;
  const readerBounds = document.querySelector(".pdf-reader").getBoundingClientRect();
  for (const control of document.querySelectorAll(".pdf-reader-heading button, .pdf-reader-toolbar button, .pdf-reader-toolbar input")) {
    const bounds = control.getBoundingClientRect();
    if (bounds.left < readerBounds.left - 1 || bounds.right > readerBounds.right + 1) throw new Error("阅读器工具栏超出窗口边界。");
  }
  const pdfViewport = document.querySelector(".pdf-reader-viewport").getBoundingClientRect();
  const notePanel = document.querySelector(".pdf-reader-notes")?.getBoundingClientRect();
  if (notePanel && pdfViewport.right > notePanel.left + 1) throw new Error("阅读页面与笔记栏重叠。");
  report.layoutWithinWindow = { width: Math.round(readerBounds.width), viewportWidth: Math.round(pdfViewport.width), notesWidth: Math.round(notePanel?.width ?? 0) };
  report.firstPage = pageLayer(1).textContent.includes("Gaussian reconstruction");
  if (!report.firstPage) throw new Error("未正确渲染第一页的文字。");
  report.pageCount = document.querySelector(".pdf-reader-page-controls form").textContent.includes("/ 3");
  if (!report.pageCount) throw new Error("PDF 总页数不是 3。");
  document.querySelector(".pdf-reader-page-controls button[aria-label='下一页']").click();
  await waitFor(() => currentPageNumber() === 2 && pageLayer(2)?.textContent.includes("Dynamic reconstruction"), "翻到第二页");
  report.secondPage = true;
  const findInput = document.querySelector(".pdf-reader-find input");
  input(findInput, "Dynamic");
  await waitFor(() => document.querySelector(".pdf-reader-search-status")?.textContent.includes("1 / 1"), "全文搜索");
  report.search = true;
  input(findInput, "");
  window.dispatchEvent(new CustomEvent("literature-reader-find"));
  report.nativeFindFocus = document.activeElement === findInput;
  if (!report.nativeFindFocus) throw new Error("原生查找命令没有聚焦全文搜索。");
  const canvas = document.querySelector('.pdf-reader-page-surface[data-page-number="2"] canvas');
  const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  let ink = 0;
  for (let index = 0; index < pixels.length; index += 4) if (pixels[index] < 240 && pixels[index + 1] < 240 && pixels[index + 2] < 240) ink += 1;
  report.canvasInkPixels = ink;
  if (ink < 50) throw new Error("PDF canvas 没有实际绘制论文文字。");
  const note = "Desktop reader smoke: persistent note.";
  const paperId = document.querySelector(".pdf-reader-page-controls input").id.slice("pdf-page-".length);
  const removed = await window.literatureDesktop.request({ path: `/papers/${encodeURIComponent(paperId)}`, method: "DELETE" });
  if (removed.status !== 200) throw new Error("无法准备笔记保存失败的临时文献。");
  input(document.querySelector(".pdf-reader-notes textarea"), note);
  await waitFor(() => document.querySelector(".pdf-reader-notes-heading .is-failed"), "笔记保存失败反馈");
  report.noteFailureDraftRetained = localStorage.getItem(`literature:reading-note:${paperId}`) === note;
  if (!report.noteFailureDraftRetained) throw new Error("笔记保存失败没有保留本机草稿。");
  const failedQuitDecision = await new Promise((resolve) => {
    window.dispatchEvent(new CustomEvent("literature-save-before-quit", { detail: { complete: resolve } }));
  });
  if (failedQuitDecision) throw new Error("笔记未保存时阅读器允许退出。");
  report.failedSaveDeclinesQuit = true;
  await waitFor(() => !document.querySelector(".pdf-reader-back").disabled && !document.querySelector(".pdf-reader-notes textarea").disabled, "保存失败取消退出后继续编辑");
  const restored = await window.literatureDesktop.request({ path: `/papers/${encodeURIComponent(paperId)}/restore`, method: "POST" });
  if (restored.status !== 200) throw new Error("无法恢复临时文献。");
  [...document.querySelectorAll(".pdf-reader-note-error button")].find((button) => button.textContent.includes("重试保存笔记")).click();
  await waitFor(() => document.querySelector(".pdf-reader-notes-heading .is-saved"), "笔记自动保存");
  report.noteAutosave = true;
  const quitDecision = await new Promise((resolve) => {
    window.dispatchEvent(new CustomEvent("literature-save-before-quit", { detail: { complete: resolve } }));
  });
  if (!quitDecision) throw new Error("已保存的阅读器拒绝了退出握手。");
  // The test keeps the window open, as if another window declined quitting.
  await waitFor(() => !document.querySelector(".pdf-reader-back").disabled && !document.querySelector(".pdf-reader-notes textarea").disabled, "其他窗口取消退出后继续阅读");
  report.cancelledQuitInteractive = true;
  [...document.querySelectorAll(".pdf-reader-heading button")].find((button) => button.textContent === "收起笔记").click();
  await waitFor(() => !document.querySelector(".pdf-reader-notes"), "收起笔记");
  document.querySelector(".pdf-reader-back").click();
  await waitFor(() => !document.querySelector(".pdf-reader"), "保存并返回目录");
  await open();
  await waitFor(() => currentPageNumber() === 2 && pageLayer(2)?.textContent.includes("Dynamic reconstruction"), "恢复第二页");
  report.positionRestored = true;
  report.notesCollapsedRestored = !document.querySelector(".pdf-reader-notes");
  if (!report.notesCollapsedRestored) throw new Error("笔记面板状态没有恢复。");
  [...document.querySelectorAll(".pdf-reader-heading button")].find((button) => button.textContent === "显示笔记").click();
  const restoredNote = await waitFor(() => document.querySelector(".pdf-reader-notes textarea"), "展开恢复的笔记");
  report.noteRestored = restoredNote.value === note;
  if (!report.noteRestored) throw new Error("阅读笔记没有恢复。");
  document.querySelector(".pdf-reader-back").click();
  await waitFor(() => !document.querySelector(".pdf-reader"), "验证结束后返回");
  return report;
}

export function readerSmokeScript(title) {
  return `(${verifyReader.toString()})(${JSON.stringify(title)})`;
}

async function verifyNavigation(title) {
  const report = {};
  const waitFor = async (predicate, stage) => {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      const error = document.querySelector(".pdf-reader-empty[role='alert']");
      if (error) throw new Error(`${stage}: ${error.textContent}`);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    throw new Error(`标题导航验证超时：${stage}`);
  };
  const setSearch = (value) => {
    const search = document.querySelector(".search-box input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(search, value);
    search.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const modeButton = (mode) => [...document.querySelectorAll(".paper-view-switch button")].find((button) => button.textContent.trim() === (mode === "cards" ? "卡片" : "题目列表"));
  const selectedMode = () => [...document.querySelectorAll(".paper-view-switch button")].find((button) => button.getAttribute("aria-pressed") === "true")?.textContent.trim();
  const setSort = (value) => {
    const select = document.querySelector(".sort-control select");
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  };
  setSearch("");
  const originalSort = (await waitFor(() => !document.querySelector(".sort-control select").disabled && document.querySelector(".sort-control select"), "清空搜索后可选择排序")).value;
  setSort("title");
  await waitFor(() => document.querySelector(".sort-control select").value === "title", "标题排序");
  // Every fixture matches the same date field. The saved reader note therefore
  // cannot rank the PDF above its navigation fixtures, as a title query would.
  setSearch("2026");
  await waitFor(() => document.querySelector(".search-box input")?.value === "2026" && document.querySelector(".sort-control select")?.disabled, "搜索共同日期");
  for (const mode of ["cards", "titles"]) {
    modeButton(mode).click();
    const selector = mode === "cards" ? ".paper-card .paper-detail-title" : ".paper-title-list [data-title-paper]";
    const trigger = await waitFor(() => [...document.querySelectorAll(selector)].find((button) => button.textContent.trim() === title), `${mode}标题`);
    trigger.focus({ preventScroll: true });
    trigger.scrollIntoView({ block: "center", behavior: "instant" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const before = { query: document.querySelector(".search-box input").value, mode: selectedMode(), scrollY: window.scrollY };
    if (before.scrollY < 20) throw new Error(`${mode}回归没有覆盖实际滚动位置。`);
    trigger.click();
    await waitFor(() => document.querySelector(".pdf-reader-page-surface canvas")?.width > 100 && document.querySelector(".pdf-reader-text-layer")?.textContent.length > 10, `${mode}标题直达 PDF`);
    if (document.querySelector(".paper-preview-layer")) throw new Error(`${mode}标题仍显示重复卡片弹窗。`);
    document.querySelector(".pdf-reader-back").click();
    const scrollTrace = [];
    try {
      await waitFor(() => {
        // Avoid layout reads while polling: they can mask a restore race in a
        // hidden Electron window. Measure document heights only after failure.
        const state = { scrollY: window.scrollY, readerExists: Boolean(document.querySelector(".pdf-reader")) };
        if (scrollTrace.length < 12) scrollTrace.push(state);
        return !state.readerExists && Math.abs(state.scrollY - before.scrollY) <= 2;
      }, `${mode}返回恢复滚动`);
    } catch (error) {
      throw new Error(`${error.message}；${JSON.stringify({
        before, after: { scrollY: window.scrollY, scrollHeight: document.documentElement.scrollHeight,
          clientHeight: document.documentElement.clientHeight, bodyScrollHeight: document.body.scrollHeight,
          readerExists: Boolean(document.querySelector(".pdf-reader")), query: document.querySelector(".search-box input")?.value,
          mode: selectedMode(), activeElement: { tag: document.activeElement?.tagName,
            titlePaper: document.activeElement?.getAttribute("data-title-paper"), text: document.activeElement?.textContent?.slice(0, 80) } },
        scrollTrace,
      })}`);
    }
    await waitFor(() => document.activeElement === trigger, `${mode}返回恢复标题焦点`);
    if (document.querySelector(".search-box input").value !== before.query || selectedMode() !== before.mode) throw new Error(`${mode}返回丢失了搜索或列表模式。`);
    report[mode] = { titleOpensReader: true, searchPreserved: true, modePreserved: true, scrollY: before.scrollY, focusRestored: true };
  }
  modeButton("cards").click();
  setSearch("");
  await waitFor(() => !document.querySelector(".sort-control select").disabled, "恢复排序控件");
  setSort(originalSort);
  window.scrollTo({ top: 0, behavior: "instant" });
  await waitFor(() => selectedMode() === "卡片" && document.querySelector(".search-box input").value === "" && !document.querySelector(".paper-title-list") && document.querySelector(".sort-control select").value === originalSort, "恢复默认目录");
  return report;
}

async function verifyNoPdfNavigation(title) {
  const report = {};
  const waitFor = async (predicate, stage) => {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    throw new Error(`无 PDF 导航验证超时：${stage}`);
  };
  const setSearch = (value) => {
    const search = document.querySelector(".search-box input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(search, value);
    search.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const modeButton = (mode) => [...document.querySelectorAll(".paper-view-switch button")].find((button) => button.textContent.trim() === (mode === "cards" ? "卡片" : "题目列表"));
  setSearch(title);
  for (const mode of ["cards", "titles"]) {
    modeButton(mode).click();
    const selector = mode === "cards" ? ".paper-card .paper-detail-title" : ".paper-title-list [data-title-paper]";
    const trigger = await waitFor(() => [...document.querySelectorAll(selector)].find((button) => button.textContent.trim() === title), `${mode}无PDF标题`);
    trigger.focus({ preventScroll: true });
    trigger.scrollIntoView({ block: "center", behavior: "instant" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    trigger.click();
    const editor = await waitFor(() => document.querySelector(".edit-drawer[aria-labelledby='edit-paper-title']"), `${mode}打开编辑`);
    if (document.querySelector(".pdf-reader") || document.querySelector(".paper-preview-layer")) throw new Error(`${mode}无PDF标题打开了阅读器或重复卡片。`);
    const titleInput = editor.querySelector(".edit-field textarea");
    if (titleInput?.value !== title) throw new Error(`${mode}编辑器显示了错误论文。`);
    if (![...editor.querySelectorAll("button")].some((button) => button.textContent.includes("选择本地 PDF"))) throw new Error("无PDF编辑器缺少导入入口。");
    editor.querySelector("button[aria-label='关闭论文编辑']").click();
    await waitFor(() => !document.querySelector(".edit-drawer[aria-labelledby='edit-paper-title']"), `${mode}关闭编辑`);
    if (document.querySelector(".search-box input").value !== title) throw new Error(`${mode}关闭编辑丢失搜索条件。`);
    report[mode] = { opensEditor: true, pdfImportAvailable: true, searchPreserved: true };
  }
  modeButton("cards").click();
  setSearch("");
  window.scrollTo({ top: 0, behavior: "instant" });
  await waitFor(() => document.querySelector(".paper-card") && !document.querySelector(".paper-title-list") && document.querySelector(".search-box input").value === "", "恢复默认目录");
  return report;
}

export function navigationSmokeScript(title) {
  return `(${verifyNavigation.toString()})(${JSON.stringify(title)})`;
}

export function noPdfNavigationSmokeScript(title = NAVIGATION_NO_PDF_TITLE) {
  return `(${verifyNoPdfNavigation.toString()})(${JSON.stringify(title)})`;
}
