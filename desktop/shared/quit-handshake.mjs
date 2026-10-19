import { randomUUID } from "node:crypto";

export function createQuitHandshake(windowIds, { timeoutMs = 10_000 } = {}) {
  const requestId = randomUUID();
  const waiting = new Set(windowIds);
  let finish;
  let settled = false;
  let timer;
  const result = new Promise((resolve) => {
    finish = (allowed) => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(allowed);
    };
    if (!waiting.size) finish(true);
    else timer = setTimeout(() => finish(false), timeoutMs);
  });
  return {
    requestId, result,
    acknowledge(windowId, response) {
      if (settled || !waiting.has(windowId) || response?.requestId !== requestId) return;
      if (response.allow !== true) { finish(false); return; }
      waiting.delete(windowId);
      if (!waiting.size) finish(true);
    },
  };
}
