import { writeFile } from "node:fs/promises";

// Production UI checks against the isolated PDFs created by smoke-desktop.mjs.
async function readerStep({ stage, title, expectedAnchor }) {
  const trace = [];
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      const error = document.querySelector(".pdf-reader-empty[role='alert']");
      if (error) throw new Error(`${label}: ${error.textContent}`);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    throw new Error(`连续阅读验证超时：${label}；${JSON.stringify({ currentPage: document.querySelector(".pdf-reader-page-controls input")?.value, scrollTop: document.querySelector(".pdf-reader-viewport")?.scrollTop, scrollHeight: document.querySelector(".pdf-reader-viewport")?.scrollHeight, viewportHeight: document.querySelector(".pdf-reader-viewport")?.clientHeight, zoom: document.querySelector(".pdf-reader-zoom-controls span")?.textContent, navigation: { tab: document.querySelector('.pdf-navigation-tabs [aria-selected="true"]')?.textContent, bounds: document.querySelector(".pdf-reader-navigation")?.getBoundingClientRect().toJSON(), text: document.querySelector(".pdf-reader-navigation")?.textContent, thumbnails: [...document.querySelectorAll("[data-thumbnail-page]")].map((element) => ({ page: element.dataset.thumbnailPage, canvasWidth: element.querySelector("canvas")?.width, bounds: element.getBoundingClientRect().toJSON() })) }, pages: [...document.querySelectorAll(".pdf-reader-page-surface")].map((element) => ({ page: element.dataset.pageNumber, height: element.getBoundingClientRect().height, canvas: Boolean(element.querySelector("canvas")), text: element.querySelector(".pdf-reader-text-layer")?.textContent })) })}`);
  };
  const input = (element, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, String(value));
    element.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const currentPage = () => Number(document.querySelector(".pdf-reader-page-controls input")?.value);
  const viewport = () => document.querySelector(".pdf-reader-viewport");
  const frame = (page = currentPage()) => document.querySelector(`.pdf-reader-page-frame[data-page-number="${page}"]`);
  const surface = (page = currentPage()) => document.querySelector(`.pdf-reader-page-surface[data-page-number="${page}"]`);
  const pageTop = (page) => frame(page).getBoundingClientRect().top - viewport().getBoundingClientRect().top + viewport().scrollTop - viewport().clientTop;
  const anchor = () => ({ pageNumber: currentPage(), ratio: Math.max(0, Math.min(1, (viewport().scrollTop - pageTop(currentPage())) / surface().getBoundingClientRect().height)) });
  const renderedPage = (page) => surface(page)?.querySelector("canvas")?.width > 100 && surface(page)?.querySelector(".pdf-reader-text-layer")?.textContent.length > 10;
  const goToPage = async (page) => {
    const control = document.querySelector(".pdf-reader-page-controls input");
    input(control, page);
    control.closest("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => currentPage() === page && renderedPage(page), `页码定位第${page}页`);
  };
  const goToAnchor = async (page, ratio) => {
    viewport().scrollTo({ top: pageTop(page) + surface(page).getBoundingClientRect().height * ratio, behavior: "instant" });
    await waitFor(() => currentPage() === page && Math.abs(anchor().ratio - ratio) < 0.025, `滚动定位第${page}页内${ratio}`);
  };
  const checkAnchor = async (expected, label) => {
    let stable = 0;
    trace.push({ label, anchor: anchor(), width: viewport().clientWidth, pageHeight: surface().getBoundingClientRect().height, scale: document.querySelector(".pdf-reader-zoom-controls span")?.textContent });
    try { await waitFor(() => { stable = currentPage() === expected.pageNumber && Math.abs(anchor().ratio - expected.ratio) < 0.035 ? stable + 1 : 0; return stable >= 3; }, label); }
    catch (error) { throw new Error(`${error.message}；${JSON.stringify({ expected, actual: anchor(), scrollTop: viewport().scrollTop, viewportHeight: viewport().clientHeight, pageTop: pageTop(currentPage()), pageHeight: surface().getBoundingClientRect().height, scale: document.querySelector(".pdf-reader-zoom-controls span")?.textContent, trace })}`); }
    return anchor();
  };
  const navigationToggle = () => document.querySelector("[data-reader-navigation-toggle]");
  const setNavigation = async (visible) => {
    const changing = Boolean(document.querySelector(".pdf-reader-navigation")) !== visible;
    const width = viewport()?.clientWidth;
    if (changing) navigationToggle().click();
    await waitFor(() => Boolean(document.querySelector(".pdf-reader-navigation")) === visible, visible ? "展开目录" : "收起目录");
    if (changing) await waitFor(() => viewport().clientWidth !== width, "目录切换后的阅读宽度提交");
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  };
  const open = async () => {
    const button = await waitFor(() => [...document.querySelectorAll(".paper-detail-title")].find((candidate) => candidate.textContent.trim() === title), `打开${title}`);
    button.click();
    await waitFor(() => renderedPage(currentPage()), "打开连续PDF");
  };
  const leave = async () => {
    document.querySelector(".pdf-reader-back").click();
    await waitFor(() => !document.querySelector(".pdf-reader"), "保存阅读位置并返回");
  };

  if (stage === "legacy") {
    const button = await waitFor(() => [...document.querySelectorAll(".paper-detail-title")].find((candidate) => candidate.textContent.trim() === title), "准备旧版阅读进度");
    const paperId = button.dataset.titlePaper;
    const metadata = await window.literatureDesktop.request({ path: `/papers/${encodeURIComponent(paperId)}/reading-position` });
    if (metadata.status !== 200 || !metadata.body.pdfVersion) throw new Error("无法读取临时PDF版本以准备旧版进度。");
    const seeded = await window.literatureDesktop.request({ path: `/papers/${encodeURIComponent(paperId)}/reading-position`, method: "PUT", body: {
      pdfVersion: metadata.body.pdfVersion, pageNumber: 2, pageCount: 3, scale: 1.4,
      zoomMode: "custom", scrollOffset: 0.4, notesVisible: true, layoutMode: "single-page",
    } });
    if (seeded.status !== 200) throw new Error("无法写入临时旧版阅读进度。");
    await open();
    await waitFor(() => currentPage() === 2 && renderedPage(2), "旧版进度保留第2页");
    const height = surface(2).getBoundingClientRect().height;
    const expected = { pageNumber: 2, ratio: Math.min(1, Math.max(0, 0.4 * Math.max(0, height + 80 - viewport().clientHeight) / height)) };
    const converted = await checkAnchor(expected, "旧版单页偏移转换为连续页内偏移");
    await leave();
    const saved = await window.literatureDesktop.request({ path: `/papers/${encodeURIComponent(paperId)}/reading-position` });
    if (saved.status !== 200 || saved.body.position?.pageNumber !== 2 || saved.body.position?.layoutMode !== "continuous" || Math.abs(saved.body.position.scrollOffset - converted.ratio) > 0.035) throw new Error(`旧版进度首次保存未转为连续模式：${JSON.stringify(saved.body)}`);
    return { pagePreserved: true, offsetConverted: true, firstSaveContinuous: true, converted };
  }
  if (stage === "prepare-wheel") {
    await open();
    await setNavigation(false);
    await goToPage(1);
    const frames = [...viewport().querySelectorAll(".pdf-reader-page-frame[data-page-number]")];
    if (frames.length !== 3 || frames.some((element, index) => Number(element.dataset.pageNumber) !== index + 1)) throw new Error("3页PDF未连续排列在同一个滚动容器中。");
    if (frame(2).getBoundingClientRect().top < frame(1).getBoundingClientRect().bottom - 1) throw new Error("连续PDF页面发生重叠。");
    const bounds = viewport().getBoundingClientRect();
    return { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2), deltaY: -(pageTop(2) + surface(2).getBoundingClientRect().height * 0.2), continuousPages: frames.length };
  }
  if (stage === "functional") {
    await waitFor(() => currentPage() === 2 && renderedPage(2), "原生滚轮无需翻页到第2页");
    if (viewport().scrollTop < pageTop(2)) throw new Error("滚轮没有滚动到连续PDF第二页。");
    const report = { continuousPages: 3, nativeWheel: true, currentPageFollowsScroll: true };
    await goToPage(3);
    if (!surface(3).textContent.includes("Spectral analysis")) throw new Error("页码跳转未显示第3页内容。");
    report.pageInputJump = true;
    const search = document.querySelector(".pdf-reader-find input");
    input(search, "Gaussian reconstruction");
    await waitFor(() => document.querySelector(".pdf-reader-search-status")?.textContent.includes("1 / 1"), "全篇查找第1页");
    document.querySelector(".pdf-reader-search-status button").click();
    await waitFor(() => currentPage() === 1 && renderedPage(1), "搜索结果跳转第1页");
    input(search, "Dynamic reconstruction");
    await waitFor(() => document.querySelector(".pdf-reader-search-status")?.textContent.includes("1 / 1"), "全篇查找第2页");
    document.querySelector(".pdf-reader-search-status button").click();
    await waitFor(() => currentPage() === 2 && renderedPage(2), "搜索结果跳转第2页");
    report.searchPageJump = true;
    input(search, "");
    await setNavigation(true);
    await waitFor(() => document.querySelector('[data-outline-title="1. Gaussian Reconstruction"]'), "PDF真实内置目录");
    document.querySelector('[data-outline-title="1. Gaussian Reconstruction"]').click();
    await waitFor(() => currentPage() === 1, "章节目录定位");
    const summary = document.querySelector('summary[aria-label="展开或收起“1. Gaussian Reconstruction”的子章节"]');
    if (!summary) throw new Error("目录缺少可展开的子章节。");
    summary.click();
    if (summary.closest("details").open) throw new Error("目录子章节没有收起。");
    summary.click();
    if (!summary.closest("details").open) throw new Error("目录子章节没有展开。");
    document.querySelector('[data-outline-title="1.1 Dynamic Reconstruction"]').click();
    await waitFor(() => currentPage() === 2, "named destination子章节定位");
    document.querySelector('[data-outline-title="1.2 Spectral Analysis"]').click();
    await waitFor(() => currentPage() === 3 && renderedPage(3), "目录定位第3页");
    report.outlineNestedDestination = true;
    document.querySelector('#pdf-pages-tab').click();
    const thumbnail = await waitFor(() => document.querySelector('[data-thumbnail-page="2"]'), "缩略图列表提交");
    thumbnail.scrollIntoView({ block: "nearest", behavior: "instant" });
    await waitFor(() => thumbnail.querySelector("canvas")?.width > 20 && !thumbnail.querySelector(".pdf-thumbnail-placeholder"), "真实页面缩略图");
    thumbnail.click();
    await waitFor(() => currentPage() === 2 && renderedPage(2), "缩略图定位第2页");
    report.thumbnailNavigation = true;
    await setNavigation(false);
    await goToAnchor(2, 0.35);
    const before = anchor();
    const originalHeight = surface().getBoundingClientRect().height;
    document.querySelector('.pdf-reader-zoom-controls button[aria-label="放大"]').click();
    await waitFor(() => Math.abs(surface(2).getBoundingClientRect().height - originalHeight) > 1, "放大后的页面尺寸提交");
    await checkAnchor(before, "缩放保留页内阅读锚点");
    const zoomedHeight = surface().getBoundingClientRect().height;
    [...document.querySelectorAll(".pdf-reader-zoom-controls button")].find((button) => button.textContent === "适应宽度").click();
    await waitFor(() => document.querySelector('.pdf-reader-zoom-controls button[aria-pressed="true"]') && Math.abs(surface(2).getBoundingClientRect().height - zoomedHeight) > 1, "适应宽度后的页面尺寸提交");
    await checkAnchor(before, "适应宽度保留页内阅读锚点");
    await setNavigation(true);
    await checkAnchor(before, "展开目录保留页内阅读锚点");
    await setNavigation(false);
    await checkAnchor(before, "收起目录保留页内阅读锚点");
    report.zoomAnchor = true;
    report.navigationPanelAnchor = true;
    report.anchor = anchor();
    return report;
  }
  if (stage === "resize") return { resizeAnchor: await checkAnchor(expectedAnchor, "调整窗口宽度保留页内阅读锚点") };
  if (stage === "screenshot-navigation") { await setNavigation(true); return true; }
  if (stage === "screenshot-close-navigation") { await setNavigation(false); return true; }
  if (stage === "screenshot-boundary") {
    await open();
    [...document.querySelectorAll(".pdf-reader-zoom-controls button")].find((button) => button.textContent === "适应宽度").click();
    await setNavigation(true);
    viewport().scrollTo({ top: pageTop(2) - viewport().clientHeight * 0.45, behavior: "instant" });
    await waitFor(() => renderedPage(1) && renderedPage(2), "截取连续PDF页面交界");
    await new Promise((resolve) => setTimeout(resolve, 180));
    return true;
  }
  if (stage === "leave") { await leave(); return true; }
  if (stage === "prepare-pinch") {
    const box = surface().getBoundingClientRect();
    const view = viewport().getBoundingClientRect();
    const x = Math.round(view.left + view.width * 0.38);
    const y = Math.round(view.top + view.height * 0.42);
    return { pageNumber: currentPage(), x, y, ratioX: (x - box.left) / box.width, ratioY: (y - box.top) / box.height, width: box.width, devicePixelRatio: window.devicePixelRatio };
  }
  if (stage === "opposite-pinch") {
    const before = anchor();
    const box = surface().getBoundingClientRect();
    const view = viewport().getBoundingClientRect();
    const x = view.left + view.width * 0.4;
    const y = view.top + view.height * 0.4;
    for (const deltaY of [-10, 10]) viewport().dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, clientX: x, clientY: y, deltaY, bubbles: true, cancelable: true }));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (Math.abs(surface().getBoundingClientRect().width - box.width) > 1) throw new Error("同帧相反捏合未抵消缩放。");
    await checkAnchor(before, "同帧相反捏合保留阅读位置");
    await goToAnchor(2, 0.5);
    const scrolled = anchor();
    const height = surface().getBoundingClientRect().height;
    document.querySelector('.pdf-reader-zoom-controls button[aria-label="放大"]').click();
    await waitFor(() => Math.abs(surface(2).getBoundingClientRect().height - height) > 1, "相反捏合后滚动再放大");
    await checkAnchor(scrolled, "相反捏合后滚动与工具栏缩放保留位置");
    return { oppositeTicksCancelled: true, subsequentScrollAndToolbarAnchor: true, anchor: anchor() };
  }
  if (stage === "prepare-mixed-pinch") {
    [...document.querySelectorAll(".pdf-reader-zoom-controls button")].find((button) => button.textContent === "适应宽度").click();
    await goToPage(3);
    await checkAnchor({ pageNumber: 3, ratio: 0 }, "混合纸张宽度定位横向页");
    const box = surface(3).getBoundingClientRect();
    const view = viewport().getBoundingClientRect();
    const x = Math.round(view.left + view.width * 0.38);
    const y = Math.round(view.top + Math.min(view.height * 0.42, box.height * 0.5));
    return { pageNumber: 3, x, y, ratioX: (x - box.left) / box.width, ratioY: (y - box.top) / box.height, width: box.width, devicePixelRatio: window.devicePixelRatio };
  }
  if (stage === "pinch") {
    const point = expectedAnchor;
    await waitFor(() => Math.abs(surface(point.pageNumber).getBoundingClientRect().width - point.width) > 1, "触控板只缩放PDF内容");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const box = surface(point.pageNumber).getBoundingClientRect();
    const errorX = Math.abs(box.left + point.ratioX * box.width - point.x);
    const errorY = Math.abs(box.top + point.ratioY * box.height - point.y);
    if (window.devicePixelRatio !== point.devicePixelRatio) throw new Error("触控板缩放改变了整个应用的devicePixelRatio。");
    if (errorX > 3 || errorY > 3) throw new Error(`触控板缩放没有保持指定阅读点：${JSON.stringify({ errorX, errorY })}`);
    if (box.width <= point.width) throw new Error("放大捏合错误地缩小了PDF页面。");
    return { pointerAnchor: true, errorX, errorY, devicePixelRatioPreserved: true, zoomInDirection: true, anchor: anchor() };
  }
  if (stage === "restore") {
    await checkAnchor(expectedAnchor, "窗口还原后保留阅读锚点");
    await leave();
    await open();
    const restored = await checkAnchor(expectedAnchor, "重新打开恢复页码及页内偏移");
    await leave();
    return { pageAndOffsetRestored: true, restored };
  }
  if (stage === "long-open") {
    await open();
    await goToPage(1);
    const frames = viewport().querySelectorAll(".pdf-reader-page-frame[data-page-number]");
    if (frames.length !== 40) throw new Error("长文档缺少40个连续页面占位。");
    await setNavigation(true);
    await waitFor(() => document.querySelector(".pdf-navigation-message")?.textContent.includes("无内置目录") && document.querySelector('#pdf-pages-tab[aria-selected="true"]'), "无目录PDF自动回退缩略图");
    if (document.querySelectorAll("[data-thumbnail-page]").length !== 40) throw new Error("长文档缩略图列表缺少页面。");
    return { noOutlineFallback: true, pagePlaceholders: frames.length };
  }
  if (stage === "long-middle") {
    document.querySelector('[data-thumbnail-page="25"]').click();
    await waitFor(() => currentPage() === 25 && renderedPage(25), "长文档缩略图跳转中间页");
    await setNavigation(false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const fitCanvases = viewport().querySelectorAll(".pdf-reader-page-surface canvas").length;
    if (fitCanvases > 8 || fitCanvases < 1) throw new Error(`长文档未限制邻近页面canvas数量：${fitCanvases}`);
    return { thumbnailPage25: true, fitCanvases };
  }
  if (stage === "long-small") {
    const reduce = document.querySelector('.pdf-reader-zoom-controls button[aria-label="缩小"]');
    for (let index = 0; index < 35 && !reduce.disabled; index += 1) {
      reduce.click();
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    await waitFor(() => document.querySelector(".pdf-reader-zoom-controls span")?.textContent === "25%", "长文档缩小到25%");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const smallCanvases = viewport().querySelectorAll(".pdf-reader-page-surface canvas").length;
    if (smallCanvases > 16 || smallCanvases < 1) throw new Error(`25%缩放渲染了过多长文档页面：${smallCanvases}`);
    await leave();
    return { smallCanvases };
  }
  throw new Error(`未知连续阅读验证阶段：${stage}`);
}

const step = (window, value) => {
  console.log(`[desktop-smoke] continuous: ${value.stage}`);
  let timeout;
  return Promise.race([
    window.webContents.executeJavaScript(`(${readerStep.toString()})(${JSON.stringify(value)})`),
    new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error(`连续阅读阶段未完成：${value.stage}`)), 30_000); }),
  ]).finally(() => clearTimeout(timeout));
};

export async function verifyContinuousDesktopReader(window, { title, longTitle }) {
  const bounds = window.getBounds();
  const visible = window.isVisible();
  try {
    const legacy = await step(window, { stage: "legacy", title });
    const wheel = await step(window, { stage: "prepare-wheel", title });
    // Electron requires a focused BrowserWindow for native input. Only this
    // isolated test window is shown, never the user's actual library window.
    window.show(); window.focus(); window.webContents.focus();
    window.webContents.sendInputEvent({ type: "mouseMove", x: wheel.x, y: wheel.y });
    window.webContents.sendInputEvent({ type: "mouseWheel", x: wheel.x, y: wheel.y, deltaY: wheel.deltaY, deltaX: 0, canScroll: true, hasPreciseScrollingDeltas: true });
    const report = await step(window, { stage: "functional" });
    report.legacy = legacy;
    const browserZoom = window.webContents.getZoomFactor();
    const pinch = await step(window, { stage: "prepare-pinch" });
    for (let tick = 0; tick < 8; tick += 1) {
      window.webContents.sendInputEvent({ type: "mouseWheel", modifiers: ["control"], x: pinch.x, y: pinch.y, deltaY: 10, deltaX: 0, canScroll: true, hasPreciseScrollingDeltas: true });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    report.pinch = await step(window, { stage: "pinch", expectedAnchor: pinch });
    if (window.webContents.getZoomFactor() !== browserZoom) throw new Error("触控板缩放改变了整个应用的浏览器缩放。");
    report.pinch.browserZoomPreserved = true;
    report.pinch.nativeTicksAcrossFrames = 8;
    report.oppositePinch = await step(window, { stage: "opposite-pinch" });
    report.anchor = report.oppositePinch.anchor;
    await step(window, { stage: "screenshot-navigation" });
    await writeFile("/tmp/literature-reader-zoom-0.1.3.png", (await window.webContents.capturePage()).toPNG());
    await step(window, { stage: "screenshot-close-navigation" });
    window.setContentSize(1050, 700, false);
    report.resize = await step(window, { stage: "resize", expectedAnchor: report.anchor });
    window.setBounds(bounds, false);
    report.restore = await step(window, { stage: "restore", title, expectedAnchor: report.anchor });
    await step(window, { stage: "prepare-wheel", title });
    const mixedPinch = await step(window, { stage: "prepare-mixed-pinch" });
    window.webContents.sendInputEvent({ type: "mouseWheel", modifiers: ["control"], x: mixedPinch.x, y: mixedPinch.y, deltaY: 80, deltaX: 0, canScroll: true, hasPreciseScrollingDeltas: true });
    report.mixedPagePinch = await step(window, { stage: "pinch", expectedAnchor: mixedPinch });
    if (window.webContents.getZoomFactor() !== browserZoom) throw new Error("混合页面捏合改变了浏览器缩放。");
    await step(window, { stage: "leave" });
    await step(window, { stage: "screenshot-boundary", title });
    await writeFile("/tmp/literature-reader-0.1.3.png", (await window.webContents.capturePage()).toPNG());
    await step(window, { stage: "leave" });
    report.longDocument = await step(window, { stage: "long-open", title: longTitle });
    Object.assign(report.longDocument, await step(window, { stage: "long-middle" }));
    Object.assign(report.longDocument, await step(window, { stage: "long-small" }));
    report.screenshots = ["/tmp/literature-reader-0.1.3.png", "/tmp/literature-reader-zoom-0.1.3.png"];
    return report;
  } finally {
    window.setBounds(bounds, false);
    if (!visible) window.hide();
  }
}
