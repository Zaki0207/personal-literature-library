import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);

async function loadTypeScript(path, { component = false } = {}) {
  let source = await readFile(new URL(path, import.meta.url), "utf8");
  if (component) source = source.replace(/^import "\.\/paper-intake-diagnostic\.css";\s*$/m, "");
  let output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  if (component) output = output.replace(/"react\/jsx-runtime"/g, JSON.stringify(pathToFileURL(require.resolve("react/jsx-runtime")).href));
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

const { ApiRequestError, libraryRequest } = await loadTypeScript("../app/library/api-client.ts");
const { PaperIntakeDiagnostic } = await loadTypeScript("../app/library/components/paper-intake-diagnostic.tsx", { component: true });

const diagnostic = {
  reason: "模型返回了未执行的检索调用",
  outputPreview: '<|tool_calls|>{"name":"web.run"}<img src=x onerror="alert(1)">',
  outputLength: 73,
  truncated: false,
  model: "test-model",
};

test("intake errors retain only safe diagnostic fields in Web and desktop requests", async (t) => {
  for (const desktop of [false, true]) {
    await t.test(desktop ? "desktop IPC" : "Web HTTP", async () => {
      const previousWindow = globalThis.window;
      const previousFetch = globalThis.fetch;
      let requests = 0;
      const body = {
        error: {
          code: "INVALID_AI_RESULT", message: "论文资料不完整",
          details: { intakeDiagnostic: { ...diagnostic, apiKey: "must-not-return" }, apiKey: "must-not-return", rawResponse: { hidden: true } },
        },
      };
      try {
        if (desktop) {
          globalThis.window = { literatureDesktop: { request: async () => { requests += 1; return { status: 422, body }; } } };
          globalThis.fetch = async () => { throw new Error("IPC 请求不应触发 HTTP"); };
        } else {
          delete globalThis.window;
          globalThis.fetch = async () => { requests += 1; return new Response(JSON.stringify(body), { status: 422 }); };
        }
        await assert.rejects(libraryRequest("/paper-intake/analyze", { method: "POST", body: JSON.stringify({ reference: "project URL" }) }), (error) => {
          assert.ok(error instanceof ApiRequestError);
          assert.equal(error.message, "论文资料不完整");
          assert.equal(error.code, "INVALID_AI_RESULT");
          assert.deepEqual(error.details, { intakeDiagnostic: diagnostic });
          return true;
        });
        assert.equal(requests, 1, "格式错误不应自动触发第二次收费请求");
      } finally {
        globalThis.fetch = previousFetch;
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
      }
    });
  }
});

test("intake error diagnostics reject malformed and unrelated fields and bound previews", () => {
  assert.equal(new ApiRequestError("失败", "AI_TIMEOUT", { intakeDiagnostic: diagnostic }).details, undefined);
  assert.equal(new ApiRequestError("失败", "INVALID_AI_RESULT", { intakeDiagnostic: { ...diagnostic, outputLength: "73" } }).details, undefined);
  const error = new ApiRequestError("失败", "EMPTY_AI_RESPONSE", {
    action: "重试", intakeDiagnostic: { ...diagnostic, outputPreview: "x".repeat(20_000), outputLength: 20_000 },
  });
  assert.equal(error.details.action, "重试");
  assert.equal(error.details.intakeDiagnostic.outputPreview.length, 16_000);
  assert.equal(error.details.intakeDiagnostic.outputLength, 20_000);
  assert.equal(error.details.intakeDiagnostic.truncated, true);
});

test("diagnostic disclosure starts collapsed and renders untrusted model output as text", () => {
  const html = renderToStaticMarkup(createElement(PaperIntakeDiagnostic, { diagnostic }));
  assert.match(html, /<details[^>]*data-paper-intake-diagnostic/);
  assert.doesNotMatch(html, /<details[^>]*\bopen(?:=|\s|>)/);
  assert.match(html, /<summary>查看 AI 最终答复<\/summary>/);
  assert.match(html, /&lt;\|tool_calls\|&gt;/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img|<script|href=/);
  const empty = renderToStaticMarkup(createElement(PaperIntakeDiagnostic, { diagnostic: { ...diagnostic, outputPreview: "", outputLength: 0 } }));
  assert.match(empty, /AI 未返回最终文本/);
});
