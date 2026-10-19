/* eslint-disable @typescript-eslint/no-require-imports -- Electron sandboxed preload supports CommonJS only. */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const commands = new Set(["add-paper", "search", "radar", "command-search", "save-before-quit", "settings", "view-mode", "import-pdf"]);
contextBridge.exposeInMainWorld("literatureDesktop", Object.freeze({
  platform: "darwin",
  request: (input) => ipcRenderer.invoke("literature:request", input),
  cancelRequest: (id) => ipcRenderer.invoke("literature:cancel-request", id),
  pdfUrl: (paperId) => {
    if (typeof paperId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(paperId)) throw new Error("论文 ID 无效。");
    return `literature-pdf://paper/${encodeURIComponent(paperId)}`;
  },
  openExternal: (url) => ipcRenderer.invoke("literature:open-external", url),
  selectPdf: () => ipcRenderer.invoke("literature:select-pdf"),
  grantDroppedPdf: (file) => ipcRenderer.invoke("literature:grant-dropped-pdf", webUtils.getPathForFile(file)),
  importPdf: (paperId, grantId) => ipcRenderer.invoke("literature:import-pdf", paperId, grantId),
  showPdfInFinder: (paperId) => ipcRenderer.invoke("literature:show-pdf", paperId),
  showDataInFinder: (kind) => ipcRenderer.invoke("literature:show-data", kind),
  openSettings: (section) => ipcRenderer.invoke("literature:settings", section),
  onCommand: (callback) => {
    if (typeof callback !== "function") throw new TypeError("必须提供回调函数。");
    const listener = (_event, command) => {
      if (command && commands.has(command.type)) callback(command);
    };
    ipcRenderer.on("literature:command", listener);
    return () => ipcRenderer.removeListener("literature:command", listener);
  },
  ready: () => ipcRenderer.send("literature:ready"),
  acknowledgeQuit: (allow = true, requestId) => ipcRenderer.send("literature:quit-ready", { allow, requestId }),
}));
