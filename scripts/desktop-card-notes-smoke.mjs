// Runs against the isolated library used by smoke-desktop.mjs.
import { writeFile } from "node:fs/promises";

async function cardNotesStep({ stage }) {
  const paperId = "desktop-smoke";
  const note = "阅读要点\n\n  - 方法：保留缩进\n\t后续实验 <script>literal text</script>\n中文备注与很长的链接 https://example.test/" + "a".repeat(160);
  const editedNote = `${note}\n\n结论：继续复现。`;
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`卡片笔记验收超时：${label}`);
  };
  const card = () => document.querySelector(`[data-card-note-edit="${paperId}"], [data-card-note-editor="${paperId}"]`)?.closest(".paper-card");
  const input = () => card()?.querySelector("[data-card-note-input]");
  const content = () => card()?.querySelector(".card-note-content");
  const paper = async () => {
    const result = await window.literatureDesktop.request({ path: "/library" });
    return result.body.papers.find((item) => item.id === paperId);
  };
  const change = async (value) => {
    input().textContent = value;
    input().dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 40));
  };
  const open = async () => {
    await waitFor(() => card(), "笔记快捷入口");
    document.querySelector(`[data-card-note-edit="${paperId}"]`).click();
    await waitFor(() => input() && document.activeElement === input(), "快捷编辑自动聚焦");
    if (document.querySelector(".edit-drawer")) throw new Error("快捷笔记打开了完整编辑抽屉。");
  };
  const save = (key, meta = false) => input().dispatchEvent(new KeyboardEvent("keydown", { key, metaKey: meta, ctrlKey: !meta, bubbles: true, cancelable: true }));
  if (stage === "add") {
    await waitFor(() => card(), "空笔记卡片");
    const addButton = document.querySelector(`[data-card-note-edit="${paperId}"]`);
    if (card().querySelector(".note-row") || !addButton.closest(".paper-card-footer")) throw new Error("没有笔记的卡片仍占用独立笔记区域。");
    await open();
    if (input().textContent !== "") throw new Error("空笔记没有正确初始化。");
    await change(note);
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input().dispatchEvent(enter);
    if (enter.defaultPrevented || (await paper()).note) throw new Error("Enter 换行意外触发保存。");
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    if (!unload.defaultPrevented) throw new Error("未保存笔记没有关闭保护。");
    save("Enter");
    await waitFor(() => !input() && content()?.textContent === note, "多行笔记保存回卡片");
    const saved = await paper();
    if (saved.note !== note || saved.noteCount !== 1 || saved.title !== "Desktop runtime verification" || saved.aiSummary !== "离线测试：运行真实 PDF 阅读器。") throw new Error("笔记保存未保留完整内容或改变了其他论文信息。");
    const element = content();
    const firstCharacter = document.createRange();
    firstCharacter.setStart(element.firstChild, 0);
    firstCharacter.setEnd(element.firstChild, 1);
    const firstLine = firstCharacter.getBoundingClientRect();
    const label = card().querySelector(".note-label").getBoundingClientRect();
    if (firstLine.top >= label.bottom || firstLine.bottom <= label.top || firstLine.left <= label.right) throw new Error("笔记内容没有直接跟在标签后面。");
    if (getComputedStyle(element).whiteSpace !== "pre-wrap" || element.querySelector("script")) throw new Error("笔记没有按纯文本保留换行。");
    const line = (offset) => {
      const range = document.createRange();
      range.setStart(element.firstChild, offset);
      range.setEnd(element.firstChild, offset + 1);
      return range.getBoundingClientRect().top;
    };
    if (line(note.indexOf("方法")) - line(0) < parseFloat(getComputedStyle(element).lineHeight) * 1.8) throw new Error("保存后的空行没有实际显示。");
    if (element.scrollWidth > element.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1) throw new Error("长笔记引起横向溢出。");
    return { emptyNoteUsesFooterOnly: true, contentFollowsLabel: true, oneClickAdd: true, focusedInlineEditor: true, multilineAndBlankLinesRendered: true, indentAndLiteralHtmlPreserved: true, longTextWrapped: true, enterDoesNotSave: true, controlEnterSaved: true, unsavedCloseProtected: true, metadataPreserved: true };
  }
  if (stage === "edit-failure") {
    await open();
    if (input().textContent !== note) throw new Error("重载后笔记没有持久保存。");
    await change(editedNote);
    await window.literatureDesktop.request({ path: `/papers/${paperId}`, method: "DELETE" });
    save("s", true);
    await waitFor(() => card()?.querySelector('[role="alert"]') && input().getAttribute("aria-disabled") !== "true", "保存失败保留草稿并允许重试");
    if (input().textContent !== editedNote) throw new Error("保存失败丢失笔记草稿。");
    await window.literatureDesktop.request({ path: `/papers/${paperId}/restore`, method: "POST" });
    save("s", true);
    await waitFor(() => !input() && content()?.textContent === editedNote, "快捷键重试保存");
    if ((await paper()).note !== editedNote) throw new Error("编辑后的笔记没有写入数据库。");
    await open();
    card().querySelector(".card-note-actions .secondary-button").click();
    await waitFor(() => !input(), "取消未修改的编辑");
    if ((await paper()).note !== editedNote) throw new Error("取消改变了已保存笔记。");
    await open();
    await change("");
    card().querySelector('.card-note-actions [type="submit"]').click();
    await waitFor(() => !input() && !content(), "清空笔记");
    const cleared = await paper();
    if (cleared.note !== "" || cleared.noteCount !== 0 || !document.querySelector(`[data-card-note-edit="${paperId}"]`).textContent.includes("添加笔记")) throw new Error("清空笔记没有恢复添加入口或正确数量。");
    if (card().querySelector(".note-row")) throw new Error("清空笔记后仍显示空白笔记区域。");
    return { persistedAfterReload: true, editExisting: true, saveFailureDraftRetained: true, retrySucceeded: true, metaSSaved: true, cancelPreservesSavedNote: true, clearNote: true };
  }
  throw new Error(`未知卡片笔记验收阶段：${stage}`);
}

export async function verifyDesktopCardNotes(window) {
  const step = (stage) => window.webContents.executeJavaScript(`(${cardNotesStep.toString()})(${JSON.stringify({ stage })})`);
  const report = await step("add");
  if (process.env.LIBRARY_DESKTOP_SMOKE_CARD_NOTES_SCREENSHOT) {
    await writeFile(process.env.LIBRARY_DESKTOP_SMOKE_CARD_NOTES_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
  }
  await new Promise((resolveLoaded) => {
    window.webContents.once("did-finish-load", resolveLoaded);
    window.webContents.reload();
  });
  return { ...report, ...await step("edit-failure") };
}
