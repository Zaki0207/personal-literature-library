import { writeFile } from "node:fs/promises";

async function richNotesStep({ stage, pdfHash, expectedPoint, expectedPanel }) {
  const id = "desktop-smoke";
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 30)); }
    throw new Error(`富文本与 PDF 便签验收超时：${label}；${JSON.stringify({ page: document.querySelector('.pdf-reader-page-controls input')?.value, readerError: document.querySelector('[data-pdf-load-error]')?.textContent, noteError: document.querySelector('[data-pdf-sticky-error]')?.textContent, pins: document.querySelectorAll('[data-pdf-sticky-pin]').length, canvases: document.querySelectorAll('.pdf-reader canvas').length, stickyList: document.querySelector('.pdf-sticky-list')?.textContent, viewport: document.querySelector('.pdf-reader-viewport')?.getBoundingClientRect().toJSON(), scrollTop: document.querySelector('.pdf-reader-viewport')?.scrollTop, notes: await list(), position: await request(`/papers/${id}/reading-position`), tabs: document.querySelector('.reading-tabs')?.textContent })}`);
  };
  const request = (path, method = "GET", body) => window.literatureDesktop.request({ path, method, ...(body ? { body } : {}) });
  const paper = async () => (await request("/library")).body.papers.find((item) => item.id === id);
  const version = async () => (await request(`/papers/${id}/reading-position`)).body.pdfVersion;
  const list = async () => (await request(`/papers/${id}/pdf-notes?pdfVersion=${encodeURIComponent(await version())}`)).body.notes;
  const card = () => document.querySelector(`[data-title-paper="${id}"]`)?.closest(".paper-card");
  const cardInput = () => card()?.querySelector("[data-note-input]");
  const readerInput = () => document.querySelector(".pdf-reader-notes [data-note-input]");
  const panel = () => document.querySelector("[data-pdf-sticky-editor]");
  const stickyInput = () => panel()?.querySelector("[data-note-input]");
  const surface = () => document.querySelector('.pdf-reader-page-surface[data-page-number="1"]');
  const setText = async (element, text) => {
    element.textContent = text; element.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 40));
  };
  const select = (element, start, end) => {
    element.focus();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let offset = 0, begun = false;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!begun && start <= offset + node.length) { range.setStart(node, start - offset); begun = true; }
      if (begun && end <= offset + node.length) { range.setEnd(node, end - offset); break; }
      offset += node.length;
    }
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  };
  const saveSticky = () => stickyInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }));
  if (stage === "card-select") {
    card().querySelector("[data-card-note-edit]").click();
    await waitFor(() => cardInput(), "卡片富文本编辑器");
    await setText(cardInput(), "Bold focus\nSecond line <script>literal</script>");
    select(cardInput(), 0, 4);
    return true;
  }
  if (stage === "card-bold") {
    if (!cardInput().querySelector("b, strong") || Number(getComputedStyle(cardInput().querySelector("b, strong")).fontWeight) < 600) throw new Error("快捷键没有直接显示加粗。");
    card().querySelector('.card-note-actions [type="submit"]').click();
    await waitFor(() => !cardInput() && card().querySelector(".card-note-content strong")?.textContent === "Bold", "保存后卡片显示加粗");
    if ((await paper()).note !== "**Bold** focus\nSecond line <script>literal</script>" || card().querySelector("script")) throw new Error("加粗保存丢失文本或执行了 HTML。");
    card().querySelector("[data-card-note-edit]").click();
    await waitFor(() => cardInput()?.querySelector("strong"), "重新打开保留加粗");
    select(cardInput(), 0, 4);
    return true;
  }
  if (stage === "card-unbold") {
    if (cardInput().querySelector("b, strong")) throw new Error("第二次快捷键没有取消加粗。");
    await setText(cardInput(), "");
    card().querySelector('.card-note-actions [type="submit"]').click();
    await waitFor(() => !cardInput(), "清理卡片测试笔记");
    card().querySelector(".paper-detail-title").click();
    await waitFor(() => readerInput() && !document.querySelector("[data-pdf-sticky-add]").disabled, "阅读器与便签准备完成");
    await setText(readerInput(), "Reader bold note");
    select(readerInput(), 0, 6);
    return true;
  }
  if (stage === "reader-bold") {
    await waitFor(async () => (await paper()).note === "**Reader** bold note", "阅读器加粗自动保存");
    if (!readerInput().querySelector("b, strong")) throw new Error("阅读器编辑区没有直接显示加粗。");
    const zoom = document.querySelector(".pdf-reader-zoom-controls input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(zoom, "100%"); zoom.dispatchEvent(new Event("input", { bubbles: true }));
    zoom.closest("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    const page = document.querySelector(".pdf-reader-page-controls input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(page, "1"); page.dispatchEvent(new Event("input", { bubbles: true }));
    page.closest("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    document.querySelector("[data-pdf-sticky-add]").click();
    await waitFor(() => document.querySelector("[data-pdf-sticky-add]").getAttribute("aria-pressed") === "true", "便签放置模式");
    const bounds = surface().getBoundingClientRect();
    return { x: Math.round(bounds.left + bounds.width * .5), y: Math.round(bounds.top + bounds.height * .25) };
  }
  if (stage === "sticky-select") {
    await waitFor(() => stickyInput(), "页面点击打开黄色便签");
    await setText(stickyInput(), "A sticky thought\nKeep this experiment."); select(stickyInput(), 2, 8);
    return true;
  }
  if (stage === "sticky-save") {
    if (!stickyInput().querySelector("b, strong")) throw new Error("便签内容不能加粗。");
    const bytes = await (await fetch(window.literatureDesktop.pdfUrl(id))).arrayBuffer();
    const originalHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).join(",");
    saveSticky();
    await waitFor(async () => !panel() && (await list()).length === 1, "保存便签");
    const saved = (await list())[0];
    window.__stickyId = saved.id;
    if (saved.body !== "A **sticky** thought\nKeep this experiment." || Math.abs(saved.xRatio - .5) > .002 || Math.abs(saved.yRatio - .25) > .002) throw new Error("便签内容或锚点未正确保存。");
    for (const scale of ["196%", "适应宽度"]) {
      if (scale === "适应宽度") [...document.querySelectorAll(".pdf-reader-zoom-controls button")].find((button) => button.textContent === scale).click();
      else {
        const zoom = document.querySelector(".pdf-reader-zoom-controls input");
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(zoom, scale); zoom.dispatchEvent(new Event("input", { bubbles: true }));
        zoom.closest("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      }
      await waitFor(() => document.querySelector(".pdf-reader-zoom-controls input").value === scale, "便签缩放");
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const pin = document.querySelector(`[data-pdf-sticky-pin="${saved.id}"]`).getBoundingClientRect();
      const page = surface().getBoundingClientRect();
      if (Math.abs((pin.left + pin.width / 2 - page.left) / page.width - saved.xRatio) > .002 || Math.abs((pin.top + pin.height / 2 - page.top) / page.height - saved.yRatio) > .002) throw new Error("缩放后便签偏离页面位置。");
    }
    const pin = document.querySelector("[data-pdf-sticky-pin]").getBoundingClientRect();
    const page = surface().getBoundingClientRect();
    const start = { x: Math.round(pin.left + pin.width / 2), y: Math.round(pin.top + pin.height / 2) };
    const end = { x: start.x + 56, y: start.y + 36 };
    return { pdfHash: originalHash, start, end, expectedPoint: { xRatio: saved.xRatio + 56 / page.width, yRatio: saved.yRatio + 36 / page.height } };
  }
  if (stage === "sticky-pin-moved") {
    await waitFor(() => document.querySelector("[data-pdf-sticky-pin]:not(.is-active)"), "图钉移动完成并可再次打开");
    await waitFor(async () => {
      const saved = (await list())[0];
      return saved && Math.abs(saved.xRatio - expectedPoint.xRatio) < .002 && Math.abs(saved.yRatio - expectedPoint.yRatio) < .002;
    }, "拖动图钉保存新位置");
    if (panel()) throw new Error("拖动图钉后意外打开了便签面板。");
    document.querySelector("[data-pdf-sticky-pin]").click();
    await waitFor(() => panel()?.style.visibility === "visible", "打开可拖动的便签面板");
    const box = panel().getBoundingClientRect();
    const heading = panel().querySelector("header strong").getBoundingClientRect();
    const start = { x: Math.round(heading.left + 6), y: Math.round(heading.top + heading.height / 2) };
    return { start, end: { x: start.x - 55, y: start.y - 40 }, expectedPanel: { left: box.left - 55, top: box.top - 40 } };
  }
  if (stage === "sticky-panel-moved") {
    await waitFor(() => {
      const box = panel()?.getBoundingClientRect();
      return box && Math.abs(box.left - expectedPanel.left) < 2 && Math.abs(box.top - expectedPanel.top) < 2;
    }, "拖动标题栏移动便签面板");
    const saved = (await list())[0];
    if (Math.abs(saved.xRatio - expectedPoint.xRatio) >= .002 || Math.abs(saved.yRatio - expectedPoint.yRatio) >= .002) throw new Error("拖动便签面板不应移动图钉。");
    panel().querySelector('[aria-label="关闭便签"]').click();
    document.querySelector(".pdf-reader-back").click();
    await waitFor(() => !document.querySelector(".pdf-reader"), "保存便签后返回");
    if (card().querySelector(".card-note-content strong")?.textContent !== "Reader") throw new Error("阅读器加粗没有同步到卡片。");
    return true;
  }
  if (stage === "reopen-and-fail") {
    await waitFor(() => card(), "重载后文献卡片");
    card().querySelector(".paper-detail-title").click();
    await waitFor(() => document.querySelector("[data-pdf-sticky-pin]"), "重载后恢复便签");
    const pin = document.querySelector("[data-pdf-sticky-pin]").getBoundingClientRect();
    const page = surface().getBoundingClientRect();
    if (Math.abs((pin.left + pin.width / 2 - page.left) / page.width - expectedPoint.xRatio) >= .002
      || Math.abs((pin.top + pin.height / 2 - page.top) / page.height - expectedPoint.yRatio) >= .002) throw new Error("重载后未恢复移动过的便签位置。");
    document.querySelector("[data-pdf-sticky-pin]").click();
    await waitFor(() => stickyInput()?.querySelector("strong")?.textContent === "sticky", "恢复便签文本和加粗");
    const id = (await list())[0].id;
    window.__stickyId = id;
    await setText(stickyInput(), "Failed sticky draft retained.");
    await request("/papers/desktop-smoke", "DELETE");
    saveSticky();
    await waitFor(() => panel()?.querySelector('[role="alert"]') && stickyInput().getAttribute("aria-disabled") !== "true", "便签保存失败保留草稿");
    if (stickyInput().textContent !== "Failed sticky draft retained.") throw new Error("便签失败丢失草稿。");
    const keys = Object.keys(localStorage).filter((key) => key.startsWith("literature:pdf-sticky:desktop-smoke:"));
    if (!keys.some((key) => JSON.parse(localStorage.getItem(key)).body === "Failed sticky draft retained.")) throw new Error("便签失败没有本机恢复草稿。");
    const allowQuit = await new Promise((resolve) => window.dispatchEvent(new CustomEvent("literature-save-before-quit", { detail: { complete: resolve } })));
    if (allowQuit) throw new Error("未保存便签允许退出。");
    await request("/papers/desktop-smoke/restore", "POST");
    saveSticky();
    await waitFor(async () => !panel() && (await list())[0]?.body === "Failed sticky draft retained.", "便签重试保存");
    return true;
  }
  if (stage === "delete-and-leave") {
    document.querySelector("[data-pdf-sticky-pin]").click();
    await waitFor(() => panel(), "打开待删除便签");
    const confirm = window.confirm;
    window.confirm = () => true;
    try { panel().querySelector(".pdf-sticky-delete").click(); } finally { window.confirm = confirm; }
    await waitFor(async () => !panel() && !(await list()).length && !document.querySelector("[data-pdf-sticky-pin]"), "删除便签");
    const bytes = await (await fetch(window.literatureDesktop.pdfUrl(id))).arrayBuffer();
    const after = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).join(",");
    if (after !== pdfHash) throw new Error("外挂便签改写了原 PDF 文件。");
    await setText(readerInput(), "");
    await waitFor(async () => (await paper()).note === "", "清理临时阅读笔记");
    document.querySelector(".pdf-reader-back").click();
    await waitFor(() => !document.querySelector(".pdf-reader"), "便签验收结束");
    return true;
  }
  throw new Error(`未知富文本验收阶段：${stage}`);
}

export async function verifyDesktopRichNotes(window) {
  const step = (stage, options = {}) => {
    console.log(`[desktop-smoke] rich notes: ${stage}`);
    return window.webContents.executeJavaScript(`(${richNotesStep.toString()})(${JSON.stringify({ stage, ...options })})`);
  };
  const bold = async (modifier = "meta") => {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "B", modifiers: [modifier] });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "B", modifiers: [modifier] });
    await new Promise((resolve) => setTimeout(resolve, 70));
  };
  await step("card-select"); await bold(); await step("card-bold"); await bold("control"); await step("card-unbold");
  await bold(); const point = await step("reader-bold");
  window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
  window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
  await step("sticky-select"); await bold();
  if (process.env.LIBRARY_DESKTOP_SMOKE_RICH_NOTES_SCREENSHOT) await writeFile(process.env.LIBRARY_DESKTOP_SMOKE_RICH_NOTES_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
  const drag = async ({ start, end }) => {
    const input = window.webContents.debugger;
    await Promise.all([
      input.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1, clickCount: 1, ...start }),
      input.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", button: "left", buttons: 1, ...end }),
      input.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", buttons: 0, clickCount: 1, ...end }),
    ]);
  };
  const pin = await step("sticky-save");
  await drag(pin);
  const panel = await step("sticky-pin-moved", { expectedPoint: pin.expectedPoint });
  await drag(panel);
  await step("sticky-panel-moved", { expectedPoint: pin.expectedPoint, expectedPanel: panel.expectedPanel });
  await new Promise((resolve) => { window.webContents.once("did-finish-load", resolve); window.webContents.reload(); });
  await step("reopen-and-fail", { expectedPoint: pin.expectedPoint }); await step("delete-and-leave", { pdfHash: pin.pdfHash });
  return { visibleBold: true, metaAndControlB: true, toggleBold: true, cardBoldPersisted: true, readerBoldAutosaved: true, stickyNativePlacement: true, stickyBold: true, stickyScaling: true, stickyPinDragged: true, stickyPanelDragged: true, stickyPersistedAfterReload: true, stickySaveFailureDraftRetained: true, stickyFailureDeclinesQuit: true, stickyRetry: true, stickyDelete: true, originalPdfUnchanged: true };
}
