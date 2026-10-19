import { writeFile } from "node:fs/promises";

// Exercise the production prompt editor against the isolated smoke database.
// The main process records requests and refuses any AI or radar execution.
async function promptStep({ stage, expectedDraft }) {
  const marker = (name) => document.querySelector(`[data-paper-intake-prompt-${name}]`);
  const modal = () => document.querySelector(".paper-intake-modal");
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`添加论文提示词验证超时：${label}；${JSON.stringify({ modal: Boolean(modal()), editor: Boolean(marker("editor")), busy: marker("editor")?.getAttribute("aria-busy"), inputLength: marker("input")?.value.length, error: document.querySelector(".paper-intake-prompt-error")?.textContent, status: document.querySelector(".paper-intake-prompt-validation")?.textContent })}`);
  };
  const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const setText = (element, value) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const readTemplate = async () => {
    const result = await window.literatureDesktop.request({ path: "/paper-intake/prompt-template" });
    if (result.status !== 200) throw new Error(`无法读取烟测提示词：${result.status}`);
    return result.body;
  };
  const expand = async () => {
    await waitFor(() => marker("toggle") && marker("editor")?.getAttribute("aria-busy") === "false", "提示词加载");
    if (marker("toggle").getAttribute("aria-expanded") !== "true") marker("toggle").click();
    return waitFor(() => !marker("input")?.disabled && marker("input"), "展开完整提示词");
  };
  const close = async () => {
    modal().querySelector('.modal-close[aria-label="关闭"]').click();
    await waitFor(() => !modal(), "关闭添加弹窗");
  };
  const reopen = async () => {
    const button = [...document.querySelectorAll(".topbar button")].find((item) => item.textContent.includes("添加论文"));
    if (!button) throw new Error("工具栏缺少添加论文入口。");
    button.click();
    await waitFor(() => modal(), "重新打开添加论文");
    return expand();
  };

  if (stage === "functional") {
    await waitFor(() => modal() && marker("editor"), "原生添加论文命令显示提示词入口");
    const initial = await readTemplate();
    if (!initial.usingDefault || initial.promptTemplate !== initial.defaultPromptTemplate || initial.promptTemplate.length < 500) throw new Error("新库未提供完整默认提示词。");
    await waitFor(() => marker("editor")?.getAttribute("aria-busy") === "false", "默认提示词请求完成");
    if (!marker("toggle").textContent.includes("默认提示词")) throw new Error("入口没有标明正在使用默认提示词。");
    const input = await expand();
    if (input.value !== initial.defaultPromptTemplate) {
      const difference = [...initial.defaultPromptTemplate].findIndex((_character, index) => input.value[index] !== initial.defaultPromptTemplate[index]);
      throw new Error(`编辑器显示的默认提示词与实际 API 模板不一致：${JSON.stringify({ inputLength: input.value.length, templateLength: initial.defaultPromptTemplate.length, difference, inputSlice: input.value.slice(Math.max(0, difference - 20), difference + 20), templateSlice: initial.defaultPromptTemplate.slice(Math.max(0, difference - 20), difference + 20) })}`);
    }
    const custom = `${initial.defaultPromptTemplate}\n\n个人整理要求：中文摘要请控制在 150 字以内，优先说明研究问题、方法与局限。`;
    setText(input, custom);
    await waitFor(() => marker("save") && !marker("save").disabled && marker("toggle").textContent.includes("未保存"), "默认全文编辑后可保存");
    marker("save").click();
    await waitFor(async () => { const value = await readTemplate(); return value.promptTemplate === custom && !value.usingDefault && marker("editor")?.getAttribute("aria-busy") === "false"; }, "自定义提示词持久化");
    if (!marker("toggle").textContent.includes("自定义提示词") || marker("toggle").textContent.includes("未保存")) throw new Error("保存后未更新自定义状态。");
    await close();
    const reopened = await reopen();
    if (reopened.value !== custom || !marker("toggle").textContent.includes("自定义提示词")) throw new Error("关闭重开没有保留已保存提示词。");

    const reference = modal().querySelector(".paper-intake-reference textarea");
    setText(reference, "Synthetic offline prompt verification DOI");
    const unsaved = `${custom}\n这条尚未保存，不应覆盖已保存模板。`;
    setText(reopened, unsaved);
    await waitFor(() => marker("cancel") && marker("toggle").textContent.includes("未保存"), "提示词编辑草稿状态");
    const analyze = modal().querySelector('.paper-intake-start button[type="submit"]');
    await waitFor(() => analyze?.disabled, "未保存提示词禁用 AI 整理");
    // A disabled submit button alone is insufficient; Enter/form submit must also be guarded.
    modal().querySelector(".paper-intake-start").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    modal().querySelector('.modal-close[aria-label="关闭"]').click();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    if (!modal() || marker("input")?.value !== unsaved) throw new Error("关闭或 Escape 丢失尚未保存的提示词草稿。");
    const layer = modal().closest(".modal-layer");
    layer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await settle();
    if (!modal() || marker("input")?.value !== unsaved) throw new Error("点击遮罩丢失尚未保存的提示词草稿。");
    if ((await readTemplate()).promptTemplate !== custom) throw new Error("尚未保存的草稿提前写入数据库。");
    marker("cancel").click();
    await waitFor(() => marker("input")?.value === custom && !marker("cancel"), "取消修改恢复已保存模板");
    await waitFor(() => !modal().querySelector('.paper-intake-start button[type="submit"]').disabled, "取消修改后恢复 AI 按钮");

    setText(marker("input"), "   \n\t");
    await waitFor(() => marker("save")?.disabled && document.querySelector(".paper-intake-prompt-validation")?.textContent.includes("不能为空"), "空白模板校验");
    marker("save").click();
    await settle();
    if ((await readTemplate()).promptTemplate !== custom) throw new Error("空白模板覆盖了已保存提示词。");
    marker("cancel").click();
    await waitFor(() => marker("input")?.value === custom, "空白草稿取消");
    marker("reset").click();
    await waitFor(async () => { const value = await readTemplate(); return value.usingDefault && value.promptTemplate === initial.defaultPromptTemplate && marker("input")?.value === initial.defaultPromptTemplate && marker("editor")?.getAttribute("aria-busy") === "false"; }, "恢复完整默认模板");
    if (!marker("toggle").textContent.includes("默认提示词")) throw new Error("恢复后未显示默认状态。");
    return { defaultVisible: true, fullTemplateLength: initial.defaultPromptTemplate.length, customSaved: true, closeReopenPreserved: true, unsavedCloseEscapeBackdropProtected: true, unsavedSubmitGuarded: true, cancelRestoresSaved: true, blankRejected: true, resetDefault: true };
  }

  if (stage === "prepare-save-failure") {
    const input = await expand();
    const original = await readTemplate();
    const draft = `${original.promptTemplate}\n保存失败后的重试要求：保留并使用这段编辑内容。`;
    setText(input, draft);
    await waitFor(() => marker("save") && !marker("save").disabled, "准备一次保存失败");
    return { draft, originalTemplate: original.promptTemplate };
  }
  if (stage === "save-failure") {
    marker("save").click();
    await waitFor(() => document.querySelector(".paper-intake-prompt-error")?.textContent.includes("离线模拟保存失败") && marker("editor")?.getAttribute("aria-busy") === "false", "显示保存失败");
    if (marker("input")?.value !== expectedDraft.draft || !marker("toggle").textContent.includes("未保存")) throw new Error("保存失败后丢失提示词草稿。");
    if ((await readTemplate()).promptTemplate !== expectedDraft.originalTemplate) throw new Error("失败请求改写已保存模板。");
    if (marker("save").disabled) throw new Error("保存失败后无法重试。");
    marker("save").click();
    await waitFor(async () => { const value = await readTemplate(); return value.promptTemplate === expectedDraft.draft && !value.usingDefault && marker("editor")?.getAttribute("aria-busy") === "false"; }, "失败后重试成功");
    marker("reset").click();
    await waitFor(async () => { const value = await readTemplate(); return value.usingDefault && value.promptTemplate === expectedDraft.originalTemplate && marker("input")?.value === value.promptTemplate && marker("editor")?.getAttribute("aria-busy") === "false"; }, "重试验收后恢复默认");
    return { failedSaveDraftPreserved: true, failedSaveDidNotWrite: true, retryAfterFailureSaved: true };
  }

  if (stage === "layout") {
    const input = await expand();
    const persisted = await readTemplate();
    const longDraft = `${persisted.promptTemplate}\n${"离线布局验收：完整提示词很长时应在编辑框内滚动。\n".repeat(400)}${"LongUnbrokenSyntheticPromptText".repeat(200)}`;
    if (longDraft.length > 40_000) throw new Error("布局合成提示词超过应用限制。");
    setText(input, longDraft);
    await waitFor(() => marker("cancel") && input.value === longDraft, "长提示词编辑");
    await settle();
    const fail = (message) => { throw new Error(`提示词布局 ${innerWidth}×${innerHeight}：${message}`); };
    const dialog = modal();
    if (document.documentElement.scrollWidth > innerWidth + 1 || dialog.scrollWidth > dialog.clientWidth + 1) fail("弹窗横向溢出");
    const rect = dialog.getBoundingClientRect();
    if (rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1) fail("弹窗超出窗口");
    if (input.scrollHeight <= input.clientHeight + 1 || input.clientHeight < 90) fail("长模板缺少可用的内部滚动编辑区域");
    const visible = (element, label) => {
      const bounds = element.getBoundingClientRect();
      if (bounds.left < -1 || bounds.right > innerWidth + 1 || bounds.top < -1 || bounds.bottom > innerHeight + 1 || bounds.width < 20 || bounds.height < 20) fail(`${label}控件不可见或被裁切`);
    };
    input.scrollIntoView({ block: "center", behavior: "instant" });
    await settle();
    visible(input, "提示词编辑框");
    marker("save").scrollIntoView({ block: "nearest", behavior: "instant" });
    await settle();
    for (const name of ["reset", "cancel", "save"]) visible(marker(name), name);
    const reference = dialog.querySelector(".paper-intake-reference textarea");
    reference.scrollIntoView({ block: "center", behavior: "instant" });
    await settle();
    visible(reference, "论文线索");
    const analyze = dialog.querySelector('.paper-intake-start button[type="submit"]');
    analyze.scrollIntoView({ block: "nearest", behavior: "instant" });
    await settle();
    visible(analyze, "添加操作");
    if (!analyze.disabled) fail("长草稿没有禁用 AI 整理");
    marker("cancel").click();
    await waitFor(() => !marker("cancel") && marker("input")?.value === persisted.promptTemplate, "布局测试取消草稿");
    if ((await readTemplate()).promptTemplate !== persisted.promptTemplate) fail("布局测试改写了已保存提示词");
    return { width: innerWidth, height: innerHeight, draftLength: longDraft.length, modalWidth: Math.round(rect.width), modalHeight: Math.round(rect.height), editorHeight: input.clientHeight, internalScroll: true, actionsAccessible: true };
  }

  if (stage === "review") {
    await expand();
    const original = marker("input").value;
    const manual = [...modal().querySelectorAll(".paper-intake-start button")].find((button) => button.textContent.trim() === "手动填写");
    if (!manual || manual.disabled) throw new Error("已保存模板状态下无法进入手动核对。");
    manual.click();
    const review = await waitFor(() => modal()?.querySelector(".paper-intake-review"), "手动填写切到核对资料");
    if (!marker("input") || marker("input").value !== original) throw new Error("核对界面丢失提示词编辑器或已保存模板。");
    const draft = `${original}\n核对阶段尚未保存的提示词内容。`;
    setText(marker("input"), draft);
    await waitFor(() => marker("cancel"), "核对阶段编辑草稿");
    const submit = review.querySelector('button[type="submit"]');
    await waitFor(() => submit.disabled, "提示词草稿禁用确认入库");
    if (marker("input").value !== draft) throw new Error("切入核对后没有保留可编辑草稿。");
    marker("cancel").click();
    await waitFor(() => !marker("cancel") && !submit.disabled, "核对阶段取消草稿恢复确认入库");
    submit.scrollIntoView({ block: "nearest", behavior: "instant" });
    await settle();
    const box = submit.getBoundingClientRect();
    if (box.top < 0 || box.bottom > innerHeight + 1 || box.left < 0 || box.right > innerWidth + 1) throw new Error("核对界面底部确认按钮不可滚动到可见位置。");
    const retry = [...review.querySelectorAll("button")].find((button) => button.textContent.trim() === "重新识别");
    if (!retry || retry.disabled) throw new Error("核对界面不能返回提供线索。");
    retry.click();
    await waitFor(() => modal()?.querySelector(".paper-intake-start") && marker("input")?.value === original, "重新识别返回线索阶段并保留模板");
    return { reviewPromptVisible: true, reviewDraftProtected: true, reviewSubmitGuarded: true, reviewCancelReenablesSubmit: true, reviewFooterAccessible: true };
  }

  if (stage === "cleanup") {
    await close();
    return { restored: true };
  }
  if (stage === "collapse") {
    if (marker("toggle")?.getAttribute("aria-expanded") === "true") marker("toggle").click();
    await settle();
    return { collapsed: true };
  }
  if (stage === "screenshot") {
    await waitFor(() => !document.querySelector(".toast"), "瞬态提示自然消失后截图");
    modal().querySelector(".paper-intake-start").scrollTo({ top: 0, behavior: "instant" });
    await settle();
    return { settled: true };
  }
  throw new Error(`未知提示词验收阶段：${stage}`);
}

const step = (window, stage, expectedDraft) => window.webContents.executeJavaScript(`(${promptStep.toString()})(${JSON.stringify({ stage, expectedDraft })})`);

export async function verifyDesktopIntakePrompt(window, { command, screenshotPath, failNextSave }) {
  const original = window.getBounds();
  const report = { layout: [] };
  try {
    command({ type: "add-paper" }, window);
    Object.assign(report, await step(window, "functional"));
    if (failNextSave) {
      const draft = await step(window, "prepare-save-failure");
      failNextSave();
      Object.assign(report, await step(window, "save-failure", draft));
    }
    window.setContentSize(920, 640, false);
    Object.assign(report, await step(window, "review"));
    for (const [width, height] of [[920, 640], [1280, 800]]) {
      window.setContentSize(width, height, false);
      report.layout.push(await step(window, "layout"));
      if (screenshotPath) {
        await step(window, "screenshot");
        const screenshot = await window.webContents.capturePage();
        const path = width === 1280 ? screenshotPath : screenshotPath.replace(/\.png$/u, `-${width}.png`);
        await writeFile(path, screenshot.toPNG());
      }
    }
    if (screenshotPath) {
      await step(window, "collapse");
      await step(window, "screenshot");
      await writeFile(screenshotPath.replace(/\.png$/u, "-collapsed.png"), (await window.webContents.capturePage()).toPNG());
    }
    await step(window, "cleanup");
    return report;
  } finally {
    window.setBounds(original, false);
  }
}
