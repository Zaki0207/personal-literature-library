async function previewStep({ stage, title }) {
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`预览打开验收超时：${label}`);
  };
  const button = () => document.querySelector("[data-pdf-open-preview]");
  const state = () => ({
    page: document.querySelector(".pdf-reader-page-controls input")?.value,
    zoom: document.querySelector(".pdf-reader-zoom-controls input")?.value,
    note: document.querySelector(".pdf-reader-notes [data-note-input]")?.textContent,
  });
  if (stage === "open") {
    [...document.querySelectorAll(".paper-detail-title")].find((element) => element.textContent.trim() === title).click();
    await waitFor(() => button() && !button().disabled && document.querySelector(".pdf-reader-page-surface canvas"), "阅读器显示预览入口");
    const before = state();
    button().click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await waitFor(() => !button().disabled, "预览打开请求完成");
    if (document.querySelector("[data-pdf-preview-error]")) throw new Error("预览正常打开显示了错误。");
    if (JSON.stringify(state()) !== JSON.stringify(before)) throw new Error("打开预览改变了当前阅读内容或笔记。");
    return before;
  }
  if (stage === "failure") {
    button().click();
    await waitFor(() => document.querySelector("[data-pdf-preview-error]")?.textContent.includes("模拟预览启动失败") && !button().disabled, "启动失败显示原因并恢复可操作状态");
    return state();
  }
  if (stage === "retry") {
    document.querySelector("[data-pdf-preview-error] button").click();
    await waitFor(() => !document.querySelector("[data-pdf-preview-error]"), "重试清除启动错误");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await waitFor(() => !button().disabled, "重试打开完成");
    return state();
  }
  if (stage === "invalid") {
    for (const paperId of ["../outside.pdf", "/tmp/arbitrary.pdf", "not-present", "desktop-navigation-01"]) {
      let rejected = false;
      try { await window.literatureDesktop.openPdfInPreview(paperId); } catch { rejected = true; }
      if (!rejected) throw new Error(`没有本地PDF的预览打开请求未被拒绝：${paperId}`);
    }
    return true;
  }
  if (stage === "leave") {
    document.querySelector(".pdf-reader-back").click();
    await waitFor(() => !document.querySelector(".pdf-reader"), "返回文献库");
    return true;
  }
  throw new Error(`未知预览打开验收阶段：${stage}`);
}

export async function verifyDesktopPreviewOpen(window, { title, failNext, calls, expectedPath }) {
  console.log("[desktop-smoke] preview: open, failure, retry and archived-file resolution");
  const step = (stage) => window.webContents.executeJavaScript(`(${previewStep.toString()})(${JSON.stringify({ stage, title })})`);
  const before = await step("open");
  failNext();
  const failed = await step("failure");
  const retried = await step("retry");
  await step("invalid");
  const launches = calls();
  if (launches.length !== 3 || launches.some((call) => call.paperId !== "desktop-smoke" || call.executable !== "/usr/bin/open" || JSON.stringify(call.args) !== JSON.stringify(["-b", "com.apple.Preview", expectedPath]))) {
    throw new Error(`预览打开未绑定到准确的本地PDF与预览应用：${JSON.stringify(launches)}`);
  }
  if (JSON.stringify(before) !== JSON.stringify(failed) || JSON.stringify(before) !== JSON.stringify(retried)) throw new Error("预览打开失败或重试改变了原阅读内容与笔记。");
  await step("leave");
  return { readerButton: true, explicitPreviewBundle: true, archivedPdfResolved: true, failureVisible: true, retrySucceeded: true, readingStatePreserved: true, invalidAndMissingPdfRejected: true, launchRequests: launches.length, nativeLaunchStubbed: true };
}
