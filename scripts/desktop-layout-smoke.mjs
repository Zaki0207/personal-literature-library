// Exercise the production renderer at sizes around the toolbar's wrapping boundary.
// All interactions use the isolated database created by smoke-desktop.mjs.
async function inspectLayout(kind) {
  await new Promise((resolve) => setTimeout(resolve, 280));
  const fail = (message) => { throw new Error(`${kind} ${innerWidth}×${innerHeight}: ${message}`); };
  if (document.documentElement.scrollWidth > innerWidth + 1) fail("页面出现横向溢出");
  const check = (elements, { vertical = false } = {}) => {
    for (const element of elements) {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (rect.left < -1 || rect.right > innerWidth + 1 || (vertical && (rect.top < -1 || rect.bottom > innerHeight + 1))) {
        fail(`控件被窗口裁切：${element.getAttribute("aria-label") || element.textContent?.trim() || element.className}`);
      }
    }
  };
  if (kind === "library") {
    const children = [...document.querySelector(".topbar").children];
    if (children.some((element) => !element.getBoundingClientRect().width)) fail("主工具栏控件被隐藏");
    check(children, { vertical: true });
    for (let i = 0; i < children.length; i += 1) {
      for (let j = i + 1; j < children.length; j += 1) {
        const a = children[i].getBoundingClientRect();
        const b = children[j].getBoundingClientRect();
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) fail("主工具栏控件重叠");
      }
    }
    check(document.querySelectorAll(".paper-card button, .paper-card .resource-slot, .paper-card .category-path, .paper-title-row button"));
    const search = document.querySelector(".search-box input");
    if (search.getBoundingClientRect().width < 200) fail("搜索框过窄");
    const filter = document.querySelector(".filter-anchor > button");
    filter.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    check([document.querySelector(".filter-popover")], { vertical: true });
    filter.click();
    return { width: innerWidth, height: innerHeight, toolbarRows: new Set(children.map((element) => Math.round(element.getBoundingClientRect().top))).size };
  }
  if (kind === "reader") {
    check(document.querySelectorAll(".pdf-reader-heading button, .pdf-reader-toolbar button, .pdf-reader-toolbar input"), { vertical: true });
    const viewport = document.querySelector(".pdf-reader-viewport").getBoundingClientRect();
    const notes = document.querySelector(".pdf-reader-notes").getBoundingClientRect();
    check([document.querySelector(".pdf-reader-viewport"), document.querySelector(".pdf-reader-notes")], { vertical: true });
    if (viewport.right > notes.left + 1) fail("PDF 与笔记栏重叠");
    if (viewport.height < 200 || notes.height < 200) fail("阅读或笔记区域被工具栏挤压");
    const navigation = document.querySelector(".pdf-reader-navigation");
    if (navigation) {
      check([navigation], { vertical: true });
      check(navigation.querySelectorAll(".pdf-navigation-tabs button"), { vertical: true });
      if (navigation.getBoundingClientRect().right > viewport.left + 1) fail("目录与阅读页面重叠");
    }
    return { width: innerWidth, height: innerHeight, viewportWidth: Math.round(viewport.width), notesWidth: Math.round(notes.width), navigationWidth: Math.round(navigation?.getBoundingClientRect().width ?? 0) };
  }
  if (kind === "settings") {
    check(document.querySelectorAll(".ai-settings-modal, .ai-settings-heading button, .ai-settings-footer button, .ai-current-model-bar, .ai-model-picker"), { vertical: true });
    check(document.querySelectorAll(".ai-settings-modal input, .ai-settings-modal select, .ai-settings-modal textarea, .ai-connection-editor button"));
    const editor = document.querySelector(".ai-connection-editor");
    if (editor && editor.scrollWidth > editor.clientWidth + 1) fail(`AI 设置编辑区域横向溢出：${editor.scrollWidth} > ${editor.clientWidth}`);
    return { width: innerWidth, height: innerHeight };
  }
  check(document.querySelectorAll(".radar-page input, .radar-page textarea, .radar-page button, .radar-hero-stats"));
  return { width: innerWidth, height: innerHeight };
}

const script = (fn, value) => `(${fn.toString()})(${JSON.stringify(value)})`;
const inspect = (window, kind) => window.webContents.executeJavaScript(script(inspectLayout, kind));
async function waitFor(window, selector) {
  await window.webContents.executeJavaScript(`(async () => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (document.querySelector(${JSON.stringify(selector)})) return;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    throw new Error('布局验证等待超时：' + ${JSON.stringify(selector)});
  })()`);
}

export async function verifyDesktopLayout(window, { command, showSettings }) {
  const original = window.getBounds();
  const report = { library: [], reader: [], radar: [], settings: [] };
  const sizes = [[920, 640], [980, 700], [1050, 700], [1140, 750], [1280, 800], [1440, 900]];
  try {
    for (const [width, height] of sizes) {
      window.setContentSize(width, height, false);
      report.library.push(await inspect(window, "library"));
    }
    window.setContentSize(920, 640, false);
    await window.webContents.executeJavaScript(`document.querySelector('.mobile-menu-button').click()`);
    report.collapsedSidebar = await inspect(window, "library");
    await window.webContents.executeJavaScript(`document.querySelector('.mobile-menu-button').click()`);
    await inspect(window, "library");
    await window.webContents.executeJavaScript(`document.querySelector('[data-title-paper="desktop-smoke"]').click()`);
    await waitFor(window, ".pdf-reader-page-surface canvas");
    await window.webContents.executeJavaScript(`if (!document.querySelector('.pdf-reader-navigation')) document.querySelector('[data-reader-navigation-toggle]').click()`);
    await waitFor(window, ".pdf-reader-navigation");
    for (const [width, height] of sizes) {
      window.setContentSize(width, height, false);
      report.reader.push(await inspect(window, "reader"));
    }
    await window.webContents.executeJavaScript(`document.querySelector('[data-reader-navigation-toggle]').click()`);
    await window.webContents.executeJavaScript(`document.querySelector('.pdf-reader-back').click()`);
    // The library remains mounted beneath the reader while its save finishes.
    // Wait for the actual return before dispatching a native radar command.
    await waitFor(window, ".library-app:not(.is-reading) .topbar");
    await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    command({ type: "radar" }, window);
    await waitFor(window, ".radar-page");
    for (const [width, height] of [sizes[0], sizes[2], sizes[4]]) {
      window.setContentSize(width, height, false);
      report.radar.push(await inspect(window, "radar"));
    }
    const settings = showSettings("ai");
    await waitFor(settings, ".ai-settings-workspace");
    // Open an unsaved service form without credentials or network calls.
    await settings.webContents.executeJavaScript(`document.querySelector('.ai-add-connection').click()`);
    for (const [width, height] of [[760, 640], [980, 780]]) {
      settings.setContentSize(width, height, false);
      report.settings.push(await inspect(settings, "settings"));
    }
    await settings.webContents.executeJavaScript(`document.querySelector('.ai-settings-heading .modal-close').click()`);
    settings.close();
    await window.webContents.executeJavaScript(`document.querySelector('.library-shortcuts .nav-item').click()`);
    await waitFor(window, ".paper-card");
    return report;
  } finally {
    window.setBounds(original, false);
  }
}
