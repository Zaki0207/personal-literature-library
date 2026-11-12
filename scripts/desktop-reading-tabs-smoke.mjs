import { writeFile } from "node:fs/promises";

// Runs only against the isolated database and synthetic PDFs in smoke-desktop.mjs.
async function verifyReadingTabs() {
  const first = "desktop-smoke";
  const second = "desktop-long-smoke";
  const report = {};
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`论文标签验收超时：${label}；${JSON.stringify({ tabs: document.querySelector('.reading-tabs')?.textContent, currentPage: document.querySelector('.pdf-reader-page-controls input')?.value, error: document.querySelector('.pdf-reader-position-error')?.textContent, note: document.querySelector('.pdf-reader-notes-heading')?.textContent })}`);
  };
  const tick = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const home = () => document.querySelector('[data-reading-tab=""]');
  const tab = (id) => document.querySelector(`[data-reading-tab="${id}"]`);
  const close = (id) => document.querySelector(`[data-reading-close="${id}"]`);
  const selected = () => document.querySelector('.reading-tabs [aria-selected="true"]')?.getAttribute("data-reading-tab");
  const page = () => Number(document.querySelector(".pdf-reader-page-controls input")?.value);
  const viewport = () => document.querySelector(".pdf-reader-viewport");
  const surface = () => document.querySelector(`.pdf-reader-page-surface[data-page-number="${page()}"]`);
  const note = () => document.querySelector(".pdf-reader-notes [data-note-input]");
  const request = (path, method = "GET") => window.literatureDesktop.request({ path, method });
  const idle = () => waitFor(() => document.querySelector(".reading-tabs")?.getAttribute("aria-busy") !== "true", "标签保存完成");
  const input = async (element, value) => {
    if (element.isContentEditable) element.textContent = value;
    else Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
  };
  const ready = async (id) => {
    await waitFor(() => selected() === id && document.querySelector(".pdf-reader-page-controls input")?.id === `pdf-page-${id}` && surface()?.querySelector("canvas")?.width > 100, `切到${id}`);
    await idle();
  };
  const goHome = async () => { home().click(); await waitFor(() => selected() === "" && !document.querySelector(".pdf-reader"), "文献库主页"); await idle(); };
  const open = async (id) => { document.querySelector(`[data-title-paper="${id}"]`).click(); await ready(id); };
  const goTo = async (number) => {
    const control = document.querySelector(".pdf-reader-page-controls input");
    await input(control, String(number)); control.closest("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => page() === number && surface()?.querySelector("canvas")?.width > 100, `第${number}页`);
  };
  const zoom = async (value) => {
    const control = document.querySelector(".pdf-reader-zoom-controls input");
    await input(control, value); control.closest("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => document.querySelector(".pdf-reader-zoom-controls input")?.value === value, "缩放生效");
  };
  const showNotes = async () => {
    if (!note()) [...document.querySelectorAll(".pdf-reader-heading button")].find((button) => button.textContent === "显示笔记").click();
    await waitFor(note, "笔记面板");
  };
  const ratio = () => {
    const top = surface().getBoundingClientRect().top - viewport().getBoundingClientRect().top + viewport().scrollTop;
    return (viewport().scrollTop - top) / surface().getBoundingClientRect().height;
  };
  await goHome();
  while (document.querySelector("[data-reading-close]")) {
    const button = document.querySelector("[data-reading-close]"); button.click();
    await waitFor(() => !button.isConnected, "关闭已有测试标签"); await idle();
  }
  if (home().querySelector("[data-reading-close]") || document.querySelector('.reading-tabs [data-action="picker"]')) throw new Error("固定主页出现关闭或新建标签入口。");
  report.fixedHome = true;
  const topbar = document.querySelector(".topbar");
  const sidebar = document.querySelector(".sidebar");
  const cards = document.querySelector(".paper-card");
  const search = document.querySelector(".search-box input");
  const original = { query: search.value, margin: getComputedStyle(document.querySelector(".main-content")).marginLeft, sidebarWidth: sidebar.getBoundingClientRect().width };
  const baseline = (await request("/library")).body.papers;
  const oldFirstNote = baseline.find((paper) => paper.id === first).note || "";
  const oldSecondNote = baseline.find((paper) => paper.id === second).note || "";

  await open(first); await showNotes();
  await zoom("148%"); await goTo(2);
  if (!document.querySelector(".pdf-reader-navigation")) document.querySelector("[data-reader-navigation-toggle]").click();
  await waitFor(() => document.querySelector(".pdf-reader-navigation"), "目录展开"); await tick();
  await input(document.querySelector(".pdf-reader-find input"), "Dynamic");
  const top = surface().getBoundingClientRect().top - viewport().getBoundingClientRect().top + viewport().scrollTop;
  viewport().scrollTop = top + surface().getBoundingClientRect().height * .25;
  await waitFor(() => Math.abs(ratio() - .25) < .03, "记录页内滚动位置");
  const firstScroll = { ratio: ratio(), left: viewport().scrollLeft };
  await input(note(), "Tab A: save immediately before switching.");
  await goHome();
  if (!tab(first) || search.value !== original.query || document.querySelector(".topbar") !== topbar || document.querySelector(".paper-card") !== cards || getComputedStyle(document.querySelector(".main-content")).marginLeft !== original.margin || sidebar.getBoundingClientRect().width !== original.sidebarWidth) throw new Error("回主页改变了原布局、搜索或文献卡片。");
  if ([...document.querySelectorAll(".main-content button")].some((button) => button.textContent.trim() === "切回阅读")) throw new Error("主页新增了切回阅读按钮。");
  report.homeLayoutAndStatePreserved = true;

  await open(second); await showNotes(); await zoom("80%"); await goTo(7);
  await input(document.querySelector(".pdf-reader-find input"), "geometry");
  await input(note(), "Tab B: independent reading note.");
  tab(first).click(); await ready(first);
  await waitFor(() => page() === 2 && Math.abs(ratio() - firstScroll.ratio) < .035, "恢复第一个标签的阅读锚点");
  if (document.querySelector(".pdf-reader-zoom-controls input").value !== "148%" || document.querySelector(".pdf-reader-find input").value !== "Dynamic" || !document.querySelector(".pdf-reader-navigation") || note().textContent !== "Tab A: save immediately before switching." || Math.abs(viewport().scrollLeft - firstScroll.left) > 2) throw new Error("切回论文丢失缩放、全文搜索、目录、笔记或横向位置。");
  window.dispatchEvent(new CustomEvent("literature-reader-find"));
  if (document.activeElement !== document.querySelector(".pdf-reader-find input")) throw new Error("后台标签抢占全文搜索焦点。");
  report.independentPageZoomSearchNotesAndNavigation = true;
  report.scrollAnchorRestored = true;
  const saved = (await request("/library")).body.papers;
  if (saved.find((paper) => paper.id === first).note !== "Tab A: save immediately before switching." || saved.find((paper) => paper.id === second).note !== "Tab B: independent reading note.") throw new Error("切换标签没有保存各自的笔记。");
  report.switchFlushesBothNotes = true;
  await input(note(), oldFirstNote); await goHome();
  await open(first);
  if (document.querySelectorAll(`[data-reading-tab="${first}"]`).length !== 1 || document.querySelectorAll("[data-reading-close]").length !== 2) throw new Error("重复打开论文产生了额外标签。");
  report.noDuplicateTabs = true;
  close(second).click(); await waitFor(() => !tab(second), "关闭后台标签"); await idle();
  if (selected() !== first || !document.querySelector(".pdf-reader")) throw new Error("关闭后台标签改变了当前阅读论文。");
  close(first).click(); await waitFor(() => !tab(first) && selected() === "" && !document.querySelector(".pdf-reader"), "最后一个标签关闭后回主页"); await idle();
  report.backgroundCloseAndLastClose = true;

  await open(first); await showNotes();
  await request(`/papers/${first}`, "DELETE");
  await input(note(), "Failed tab note remains in this tab.");
  home().click();
  await waitFor(() => document.querySelector(".pdf-reader-notes-heading .is-failed"), "切换时保存失败"); await idle();
  if (selected() !== first || note().textContent !== "Failed tab note remains in this tab." || !tab(first).querySelector(".reading-tab-error")) throw new Error("失败保存切走了论文或丢失草稿及标签提示。");
  close(first).click(); await idle();
  if (!tab(first) || localStorage.getItem(`literature:reading-note:${first}`) !== "Failed tab note remains in this tab.") throw new Error("关闭失败标签丢失草稿。");
  const allow = await new Promise((resolve) => window.dispatchEvent(new CustomEvent("literature-save-before-quit", { detail: { complete: resolve } })));
  if (allow) throw new Error("标签的笔记未保存时允许退出。");
  await idle();
  report.failedSwitchCloseAndQuitPreserveDraft = true;
  await request(`/papers/${first}/restore`, "POST");
  document.querySelector(".pdf-reader-note-error button").click();
  await waitFor(() => document.querySelector(".pdf-reader-notes-heading .is-saved"), "标签笔记重试保存");
  await input(note(), oldFirstNote); await goHome();
  await open(second); await showNotes(); await input(note(), oldSecondNote); await goHome();
  while (document.querySelector("[data-reading-close]")) {
    const button = document.querySelector("[data-reading-close]"); button.click();
    await waitFor(() => !button.isConnected, "清理标签测试"); await idle();
  }
  return report;
}

export async function verifyDesktopReadingTabs(window) {
  const report = await window.webContents.executeJavaScript(`(${verifyReadingTabs.toString()})()`);
  if (process.env.LIBRARY_DESKTOP_SMOKE_TABS_SCREENSHOT) await writeFile(process.env.LIBRARY_DESKTOP_SMOKE_TABS_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
  return report;
}
