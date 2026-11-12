async function pdfLinksStep({ stage, scale, label }) {
  const waitFor = async (predicate, message) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`PDF 链接验收超时：${message}`);
  };
  const viewport = () => document.querySelector(".pdf-reader-viewport");
  const surface = (number) => document.querySelector(`.pdf-reader-page-surface[data-page-number="${number}"]`);
  const link = (value) => [...document.querySelectorAll(".pdf-reader-link-layer a")].find((element) => element.getAttribute("aria-label") === value);
  const input = (element, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const goToPage = async (number) => {
    const field = document.querySelector(".pdf-reader-page-controls input");
    input(field, String(number));
    field.closest("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await waitFor(() => field.value === String(number) && surface(number).querySelector("canvas"), "页码导航");
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  };
  if (stage === "open") {
    const title = [...document.querySelectorAll(".paper-detail-title")].find((element) => element.textContent === "Desktop PDF citation links verification");
    title.click();
    await waitFor(() => link("Citation [1]"), "正文引用链接层");
    return true;
  }
  if (stage === "prepare") {
    if (scale) {
      if (scale === "fit-width") [...document.querySelectorAll(".pdf-reader-zoom-controls button")].find((button) => button.textContent === "适应宽度").click();
      else {
        const zoom = document.querySelector(".pdf-reader-zoom-controls input");
        input(zoom, scale);
        zoom.closest("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      }
      await waitFor(() => document.querySelector(".pdf-reader-zoom-controls input").value === (scale === "fit-width" ? "适应宽度" : scale), "链接测试缩放");
      await goToPage(1);
    }
    await waitFor(() => link(label), label);
    link(label).scrollIntoView({ block: "center", inline: "center" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const bounds = link(label).getBoundingClientRect();
    const x = Math.round(bounds.left + bounds.width / 2);
    const y = Math.round(bounds.top + bounds.height / 2);
    if (document.elementFromPoint(x, y) !== link(label)) throw new Error(`引用链接被文字层遮挡：${label}`);
    return { x, y };
  }
  if (["named", "back", "same-page", "rotated"].includes(stage)) {
    const page = stage === "named" ? 2 : stage === "rotated" ? 3 : 1;
    const ratio = stage === "named" ? 397 / 792 : stage === "rotated" ? 280 / 612 : stage === "same-page" ? 477 / 792 : 82 / 792;
    await waitFor(() => {
      const bounds = surface(page).getBoundingClientRect();
      return Math.abs(bounds.top + bounds.height * ratio - viewport().getBoundingClientRect().top - 16) < 2;
    }, `${stage} 精确落到目标段落`);
    if (Number(document.querySelector(".pdf-reader-page-controls input").value) !== page) throw new Error("引用跳转后的页码错误。");
    if (document.querySelector("[data-pdf-link-error]")) throw new Error("有效引用跳转显示了错误。");
    return true;
  }
  if (stage === "external-and-error") {
    await goToPage(1);
    await waitFor(() => link("External DOI"), "外部资源链接");
    if (link("External DOI").href !== "https://doi.org/10.0000/test" || link("External DOI").target !== "_blank" || link("Unsafe script link")) throw new Error("外部引用链接未安全配置。");
    const before = viewport().scrollTop;
    link("Broken citation [9]").click();
    await waitFor(() => document.querySelector("[data-pdf-link-error]"), "无效引用显示错误");
    document.querySelector("[data-pdf-link-error] button").click();
    await waitFor(() => !document.querySelector("[data-pdf-link-error]"), "关闭引用错误");
    if (Math.abs(viewport().scrollTop - before) > 2 || Number(document.querySelector(".pdf-reader-page-controls input").value) !== 1) throw new Error("无效引用改变了阅读位置。");
    if (document.querySelector(".pdf-reader-notes [data-note-input]").textContent !== "Citation test note retained.") throw new Error("引用跳转改变了笔记。");
    document.querySelector(".pdf-reader-back").click();
    await waitFor(() => !document.querySelector(".pdf-reader"), "链接验收返回文献库");
    return { externalWebLink: true, unsafeLinkExcluded: true, brokenDestinationRecoverable: true, notePreserved: true };
  }
  throw new Error(`未知 PDF 链接验收阶段：${stage}`);
}

export async function verifyDesktopPdfLinks(window) {
  const step = (stage, options = {}) => window.webContents.executeJavaScript(`(${pdfLinksStep.toString()})(${JSON.stringify({ stage, ...options })})`);
  await step("open");
  const debuggerApi = window.webContents.debugger;
  const attached = debuggerApi.isAttached();
  if (!attached) debuggerApi.attach("1.3");
  try {
    await debuggerApi.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    const click = async (label, scale) => {
      const point = await step("prepare", { label, scale });
      await debuggerApi.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1, clickCount: 1, ...point });
      await debuggerApi.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", buttons: 0, clickCount: 1, ...point });
    };
    for (const scale of ["100%", "196%", "fit-width"]) {
      await click("Citation [1]", scale);
      await step("named");
      await click("Reference [1] (back)");
      await step("back");
      await click("Same page section");
      await step("same-page");
      await click("Rotated target [2]", scale);
      await step("rotated");
      await click("Rotated backlink");
      await step("back");
    }
    const details = await step("external-and-error");
    return { nativeClicks: true, namedCitation: true, explicitBacklink: true, samePageTarget: true, rotatedPageTarget: true, scaledHitAreas: ["100%", "196%", "fit-width"], exactParagraphPosition: true, ...details };
  } finally {
    if (debuggerApi.isAttached()) {
      await debuggerApi.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: false });
      if (!attached) debuggerApi.detach();
    }
  }
}
