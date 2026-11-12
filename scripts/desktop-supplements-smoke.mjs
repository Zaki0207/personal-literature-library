import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const dialog = ".supplement-dialog";
const cardButton = '[data-paper-supplements="desktop-smoke"]';

export async function verifyDesktopSupplements(window, { files, openCalls }) {
  const { webContents } = window;
  const evaluate = (source) => webContents.executeJavaScript(source);
  const waitFor = (condition, label) => evaluate(`(async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (${condition}) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(${JSON.stringify(`补充材料验收等待超时：${label}`)} + ' ' + (document.querySelector(${JSON.stringify(dialog)})?.textContent || ''));
  })()`);
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const getPaper = () => evaluate(`window.literatureDesktop.request({ path: '/library' }).then(({ body }) => body.papers.find(({ id }) => id === 'desktop-smoke'))`);
  const getFiles = () => evaluate(`Array.from(document.querySelectorAll('${dialog} .supplement-file-name'), (entry) => entry.textContent)`);
  const close = () => click(`${dialog} .modal-close`);

  await waitFor(`document.querySelector(${JSON.stringify(cardButton)})`, "文献卡片入口");
  const before = await getPaper();
  await click(cardButton);
  await waitFor(`document.querySelector('${dialog} .supplement-empty')`, "初始空状态");
  assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`), "关闭补充材料");
  await assert.rejects(evaluate(`window.literatureDesktop.importSupplement('desktop-smoke', new File(['fake'], 'fake.txt'))`));

  const debuggerClient = webContents.debugger;
  const { root } = await debuggerClient.sendCommand("DOM.getDocument");
  const { nodeId } = await debuggerClient.sendCommand("DOM.querySelector", { nodeId: root.nodeId, selector: `${dialog} input[type=file]` });
  await debuggerClient.sendCommand("DOM.setFileInputFiles", { nodeId, files });
  await waitFor(`document.querySelectorAll('${dialog} .supplement-file-name').length === 2 && document.querySelector('${dialog} .supplement-status')?.textContent === '已添加 2 份'`, "通过实际文件输入多选导入");
  assert.deepEqual(await getFiles(), files.map((path) => basename(path)));
  assert.equal(await evaluate(`document.querySelector('${dialog}').scrollWidth <= document.querySelector('${dialog}').clientWidth + 1`), true);
  await close();
  await waitFor("document.activeElement.dataset.paperSupplements === 'desktop-smoke'", "关闭后焦点返回文献卡片");
  assert.match(await evaluate(`document.querySelector(${JSON.stringify(cardButton)}).textContent`), /2 份/u);

  await click('[data-title-paper="desktop-smoke"]');
  await waitFor("document.querySelector('[data-reader-supplements]')", "阅读器入口");
  await click("[data-reader-supplements]");
  await waitFor(`document.querySelectorAll('${dialog} .supplement-file-name').length === 2`, "从阅读器重新打开补充材料");
  await click(`${dialog} .supplement-file-name`);
  await waitFor(`document.querySelector('${dialog} .paper-supplements').getAttribute('aria-busy') === 'false'`, "打开归档文档");
  assert.equal(openCalls.length, 1);
  assert.equal(openCalls[0].paperId, "desktop-smoke");
  assert.notEqual(openCalls[0].path, files[0]);
  assert.deepEqual(await readFile(openCalls[0].path), await readFile(files[0]));

  await evaluate(`(() => {
    const confirm = window.confirm;
    try {
      window.confirm = () => true;
      document.querySelector('${dialog} .supplement-file-list li .secondary-button').click();
    } finally { window.confirm = confirm; }
  })()`);
  await waitFor(`document.querySelectorAll('${dialog} .supplement-file-name').length === 1 && document.querySelector('${dialog} .supplement-status')?.textContent === '已移除补充材料'`, "移除一份归档副本");
  assert.deepEqual(await getFiles(), [basename(files[1])]);
  await assert.rejects(readFile(openCalls[0].path), { code: "ENOENT" });
  await readFile(files[0]);
  const after = await getPaper();
  assert.deepEqual(after.pdfArchive, before.pdfArchive);
  assert.equal(after.note, before.note);
  assert.equal(after.supplements.length, 1);
  await close();
  await waitFor(`!document.querySelector('${dialog}')`, "关闭补充材料弹窗");
  await click(".pdf-reader-back");
  await waitFor("!document.querySelector('.library-app.is-reading')", "返回文献库");
  return { multipleFiles: true, openedFromReader: true, removedArchiveCopy: true, preservedMainPdf: true };
}
