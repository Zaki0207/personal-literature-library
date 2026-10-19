import { writeFile } from "node:fs/promises";

export const INTAKE_DIAGNOSTIC_PREVIEW = `<|tool_calls|>{"name":"web.run"}\n<img src=x onerror="alert(1)">\n${"LongUnbrokenModelOutput".repeat(180)}`;
export const INTAKE_DIAGNOSTIC_REFERENCE = "https://project.example.test/offline-diagnostic";

async function diagnosticStep({ stage, preview, reference }) {
  const modal = () => document.querySelector(".paper-intake-modal");
  const diagnostic = () => modal()?.querySelector("details[data-paper-intake-diagnostic]");
  const start = () => modal()?.querySelector(".paper-intake-start");
  const referenceField = () => modal()?.querySelector(".paper-intake-reference textarea");
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`AI 答复诊断验收超时：${label}`);
  };
  const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const submit = () => start().querySelector('button[type="submit"]');
  const setText = (element, value) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const awaitFailure = async () => {
    await waitFor(() => diagnostic() && modal()?.getAttribute("aria-busy") === "false", "返回格式错误详情");
    if (!modal().querySelector(".paper-intake-error")?.textContent.includes("尚未添加论文")) throw new Error("格式错误丢失原有错误说明。");
    if (referenceField()?.value !== reference) throw new Error("格式错误丢失用户论文线索。");
    if (diagnostic().open) throw new Error("AI 最终答复默认应折叠。");
    if (diagnostic().querySelector("pre").textContent !== preview) throw new Error("最终答复预览没有保留原始文本。");
    if (!diagnostic().textContent.includes("test-diagnostic-model") || !diagnostic().textContent.includes("共 8000 字符")) throw new Error("诊断没有显示模型或截断说明。");
  };

  if (stage === "first-failure") {
    await waitFor(() => start() && modal().querySelector('[data-paper-intake-prompt-editor]')?.getAttribute("aria-busy") === "false", "添加入口加载");
    setText(referenceField(), reference);
    await waitFor(() => !submit().disabled, "有效线索允许整理");
    submit().click();
    await awaitFailure();
    diagnostic().querySelector("summary").click();
    await waitFor(() => diagnostic().open, "用户展开最终答复");
    if (diagnostic().querySelector("img, script, a, iframe")) throw new Error("AI 最终答复被当作 HTML 或可点击资源执行。");
    return { errorDetailsPreserved: true, initiallyCollapsed: true, outputPlainText: true, modelAndTruncationVisible: true, referencePreserved: true };
  }
  if (stage === "layout") {
    diagnostic().querySelector("pre").scrollIntoView({ block: "center", behavior: "instant" });
    await settle();
    const element = diagnostic().querySelector("pre");
    if (document.documentElement.scrollWidth > innerWidth + 1 || modal().scrollWidth > modal().clientWidth + 1 || element.scrollWidth > element.clientWidth + 1) throw new Error(`诊断预览在 ${innerWidth}px 窗口横向溢出。`);
    if (element.scrollHeight <= element.clientHeight + 1 || element.clientHeight < 80) throw new Error("长最终答复缺少可用内部滚动区域。");
    if (diagnostic().querySelector("img, script, a, iframe")) throw new Error("诊断布局包含模型注入的 HTML。");
    await waitFor(() => !document.querySelector(".toast"), "瞬态提示消失");
    return { width: innerWidth, height: innerHeight, internalScroll: true, noHorizontalOverflow: true };
  }
  if (stage === "begin-retry") {
    submit().click();
    await waitFor(() => modal()?.getAttribute("aria-busy") === "true", "再次整理开始");
    if (diagnostic() || modal().querySelector(".paper-intake-error")) throw new Error("新一次整理未清除旧诊断。");
    modal().querySelector(".modal-close").click();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    if (!modal() || referenceField()?.value !== reference) throw new Error("整理中关闭或 Escape 丢失草稿。");
    return { retryClearsOldDiagnostic: true, busyCloseAndEscapeProtected: true };
  }
  if (stage === "manual-and-reopen") {
    await awaitFailure();
    const manual = [...start().querySelectorAll("button")].find((button) => button.textContent.trim() === "手动填写");
    manual.click();
    await waitFor(() => modal()?.querySelector(".paper-intake-review"), "手动核对保留线索");
    if (diagnostic() || modal().querySelector(".paper-intake-error")) throw new Error("手动填写仍显示过期 AI 诊断。");
    if (modal().querySelector(".paper-intake-review .paper-intake-section textarea")?.value !== reference) throw new Error("手动填写没有沿用用户线索。");
    const retry = [...modal().querySelectorAll("button")].find((button) => button.textContent.trim() === "重新识别");
    retry.click();
    await waitFor(() => start(), "从核对页返回线索");
    modal().querySelector(".modal-close").click();
    await waitFor(() => !modal(), "用户明确关闭草稿");
    [...document.querySelectorAll(".topbar button")].find((button) => button.textContent.includes("添加论文")).click();
    await waitFor(() => start(), "新添加入口");
    if (diagnostic() || modal().querySelector(".paper-intake-error") || referenceField().value) throw new Error("新添加继承上次失败的诊断或线索。");
    modal().querySelector(".modal-close").click();
    await waitFor(() => !modal(), "清理隔离验收弹窗");
    return { manualClearsDiagnostic: true, manualPreservesReference: true, reopenClearsDiagnostic: true };
  }
  throw new Error(`未知 AI 诊断验收阶段：${stage}`);
}

export async function verifyDesktopIntakeDiagnostic(window, { command, protectDraftQuit, holdRetry, screenshotPath }) {
  const original = window.getBounds();
  const step = (stage) => window.webContents.executeJavaScript(`(${diagnosticStep.toString()})(${JSON.stringify({ stage, preview: INTAKE_DIAGNOSTIC_PREVIEW, reference: INTAKE_DIAGNOSTIC_REFERENCE })})`);
  const report = { layout: [] };
  try {
    command({ type: "add-paper" }, window);
    Object.assign(report, await step("first-failure"));
    await protectDraftQuit();
    report.quitProtectsReference = true;
    for (const [width, height] of [[920, 640], [1280, 800]]) {
      window.setContentSize(width, height, false);
      report.layout.push(await step("layout"));
      if (screenshotPath) {
        const path = width === 1280 ? screenshotPath : screenshotPath.replace(/\.png$/u, `-${width}.png`);
        await writeFile(path, (await window.webContents.capturePage()).toPNG());
      }
    }
    const release = holdRetry();
    try { Object.assign(report, await step("begin-retry")); }
    finally { release(); }
    Object.assign(report, await step("manual-and-reopen"));
    return report;
  } finally { window.setBounds(original, false); }
}
