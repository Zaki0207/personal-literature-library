import { writeFile } from "node:fs/promises";

const DOCUMENT_METADATA = {
  source: "离线博客资料来源",
  institution: "离线资料发布机构",
  note: "首次入库的阅读备注。\n保留中文与多行笔记，不需要保存后再次编辑。",
};

// Run against real file grants and the isolated desktop smoke library.
async function documentImportStep({ stage, title, count, field, value, metadata = {} }) {
  const modal = () => document.querySelector(".paper-intake-modal");
  const input = (name) => modal()?.querySelector(`[data-intake-field="${name}"]`);
  const titleField = () => input("title");
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`普通 PDF 资料验收超时：${label}；${modal()?.textContent}`);
  };
  const library = async () => {
    const result = await window.literatureDesktop.request({ path: "/library" });
    if (result.status !== 200) throw new Error("无法读取隔离资料库。");
    return result.body;
  };
  const button = (text) => [...modal().querySelectorAll("button")].find((item) => item.textContent.trim() === text);
  const setTitle = (value) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(titleField(), value);
    titleField().dispatchEvent(new Event("input", { bubbles: true }));
  };
  const assertMetadata = (paper) => {
    for (const name of ["source", "institution", "note"]) {
      if (paper[name] !== (metadata[name] ?? "")) throw new Error(`首次入库没有保留 ${name}：${JSON.stringify(paper[name])}`);
    }
    if (paper.noteCount !== (metadata.note ? 1 : 0)) throw new Error("首次备注没有正确更新笔记数量。");
  };
  const assertDraft = () => {
    for (const name of ["source", "institution", "note"]) {
      if (input(name)?.value !== (metadata[name] ?? "")) throw new Error(`录入草稿丢失 ${name}。`);
    }
  };
  if (stage === "field-position") {
    const element = input(field);
    if (!element || element.disabled || element.readOnly) throw new Error(`入库前的 ${field} 不能编辑。`);
    element.scrollIntoView({ block: "center", behavior: "instant" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const bounds = element.getBoundingClientRect();
    const position = { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) };
    if (document.elementFromPoint(position.x, position.y) !== element) throw new Error(`${field} 输入被弹窗其他内容遮挡。`);
    return position;
  }
  if (stage === "field-focused") {
    await waitFor(() => document.activeElement === input(field), `鼠标点击聚焦 ${field}`);
    return true;
  }
  if (stage === "field-entered") {
    await waitFor(() => input(field)?.value === value, `实际键盘输入 ${field}`);
    if (document.activeElement !== input(field)) throw new Error(`输入 ${field} 后焦点被抢走。`);
    return true;
  }
  if (stage === "draft") {
    await waitFor(() => modal()?.dataset.pdfIntakeMode === "document" && titleField(), "资料草稿");
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (titleField().value !== title || !modal().textContent.includes("支持博客、教程、讲义")) throw new Error("本地资料没有沿用文件名或缺少非论文支持说明。");
    if (modal().querySelector(".paper-intake-steps, [data-paper-intake-prompt-editor], .is-ai-section") || modal().textContent.includes("未发现重复")) throw new Error("普通资料要求 AI 步骤或在检查前宣称无重复。");
    const required = [...modal().querySelectorAll("[required]")];
    if (required.length !== 1 || required[0] !== titleField()) throw new Error("普通资料除标题外还要求其他必填信息。");
    assertDraft();
    if (modal().scrollWidth > modal().clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1) throw new Error("资料导入弹窗横向溢出。");
    return { titleOnlyRequired: true, filenamePreserved: true, noAiStepRequired: true, honestDuplicateStatus: true, noHorizontalOverflow: true, count: (await library()).papers.length };
  }
  if (stage === "optional-recognition") {
    button("按论文识别").click();
    await waitFor(() => modal()?.querySelector(".paper-intake-start") && modal().querySelector('[data-paper-intake-prompt-editor]')?.getAttribute("aria-busy") === "false", "可选论文识别入口");
    if (modal().querySelector(".paper-intake-reference textarea").value !== title) throw new Error("切换论文识别丢失文件名线索。");
    button("手动填写").click();
    await waitFor(() => modal()?.dataset.pdfIntakeMode === "document" && !modal().querySelector('[data-paper-intake-prompt-editor]'), "返回普通资料草稿");
    assertDraft();
    return { optionalRecognitionPreservesFile: true, optionalRecognitionPreservesMetadataAndNote: true };
  }
  if (stage === "save") {
    setTitle(title);
    await waitFor(() => !modal().querySelector('button[type="submit"]').disabled, "中文标题允许保存");
    modal().querySelector('button[type="submit"]').click();
    const paper = await waitFor(async () => {
      const papers = (await library()).papers;
      const saved = papers.find((item) => item.title === title);
      return papers.length === count + 1 && saved?.pdfArchive?.status === "ready" && saved;
    }, "仅标题资料与本地 PDF 入库");
    await waitFor(() => !modal() || (modal().getAttribute("aria-busy") === "false" && titleField()?.value !== title), "保存后继续队列或关闭");
    assertMetadata(paper);
    if (paper.authors || paper.date || paper.identifiers.length || paper.categoryIds.length || paper.aiSummary) throw new Error("普通资料保存凭空填入了论文信息。");
    const response = await fetch(window.literatureDesktop.pdfUrl(paper.id), { headers: { Range: "bytes=0-4" } });
    if (response.status !== 206 || await response.text() !== "%PDF-") throw new Error("普通资料入库后不可读取本地 PDF。");
    return { title, chineseTitleSaved: true, sourceInstitutionAndNoteSaved: Boolean(metadata.note), optionalMetadataEmpty: !metadata.note, localPdfReadable: true, count: count + 1 };
  }
  if (stage === "read-note") {
    const paper = (await library()).papers.find((item) => item.title === title);
    assertMetadata(paper);
    const open = await waitFor(() => [...document.querySelectorAll(".paper-detail-title")].find((element) => element.textContent.trim() === title), "首次资料阅读入口");
    open.click();
    await waitFor(() => document.querySelector(".pdf-reader-notes textarea")?.value === metadata.note, "首次入库备注可在阅读器直接读取");
    document.querySelector(".pdf-reader-back").click();
    await waitFor(() => !document.querySelector(".pdf-reader"), "返回资料库");
    return { initialNoteReadable: true };
  }
  if (stage === "duplicate") {
    await waitFor(() => titleField(), "重复导入草稿");
    setTitle(title);
    await waitFor(() => !modal().querySelector('button[type="submit"]').disabled, "重复标题待保存");
    modal().querySelector('button[type="submit"]').click();
    await waitFor(() => modal()?.querySelector(".paper-intake-error")?.textContent.includes("重复") && modal().getAttribute("aria-busy") === "false", "重复标题被拦截");
    if ((await library()).papers.length !== count || titleField().value !== title) throw new Error("重复资料新增记录或丢失草稿。");
    assertDraft();
    modal().querySelector(".modal-close").click();
    await waitFor(() => !modal(), "关闭重复草稿");
    return { duplicateBlocked: true, duplicateDraftPreserved: true, duplicateMetadataAndNotePreserved: true };
  }
  throw new Error(`未知普通资料验收阶段：${stage}`);
}

export async function verifyDesktopDocumentImport(window, { command, files, duplicateFile, screenshotPath }) {
  const originalBounds = window.getBounds();
  const step = (stage, title, count, extra = {}) => window.webContents.executeJavaScript(`(${documentImportStep.toString()})(${JSON.stringify({ stage, title, count, ...extra })})`);
  const fillMetadata = async () => {
    for (const [field, value] of Object.entries(DOCUMENT_METADATA)) {
      const position = await step("field-position", undefined, undefined, { field });
      window.webContents.sendInputEvent({ type: "mouseMove", ...position });
      window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...position });
      window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...position });
      await step("field-focused", undefined, undefined, { field });
      await window.webContents.insertText(value);
      await step("field-entered", undefined, undefined, { field, value });
    }
  };
  const firstTitle = files[0].name.replace(/\.pdf$/iu, "");
  window.show(); window.focus(); window.webContents.focus();
  window.setContentSize(920, 640, false);
  try {
  command({ type: "import-pdf", files }, window);
  const report = await step("draft", firstTitle);
  await fillMetadata();
  report.nativeMouseAndKeyboardInput = true;
  if (screenshotPath) {
    window.show(); window.focus(); window.webContents.focus();
    // DOM readiness can precede macOS compositing; retain the modal until the
    // native capture has a painted frame instead of the previous library view.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await writeFile(screenshotPath, (await window.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
  }
  Object.assign(report, await step("optional-recognition", firstTitle, undefined, { metadata: DOCUMENT_METADATA }));
  report.saved = [await step("save", firstTitle, report.count, { metadata: DOCUMENT_METADATA })];
  await step("draft", files[1].name.replace(/\.pdf$/iu, ""));
  report.saved.push(await step("save", "中文教程与讲义", report.count + 1));
  Object.assign(report, await step("read-note", firstTitle, undefined, { metadata: DOCUMENT_METADATA }));
  window.setContentSize(1280, 800, false);
  command({ type: "import-pdf", files: [duplicateFile] }, window);
  await step("draft", firstTitle);
  await fillMetadata();
  Object.assign(report, await step("duplicate", firstTitle, report.count + 2, { metadata: DOCUMENT_METADATA }));
  report.multipleFilesConfirmed = true;
  return report;
  } finally { window.setBounds(originalBounds, false); }
}
