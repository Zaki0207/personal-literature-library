import assert from "node:assert/strict";
import test from "node:test";
import {
  errorPayload,
  parsePdfRange,
  routeAiConnection,
  routeAiModel,
  routeCategoryId,
  routePaperId,
  routeRadarItem,
} from "../scripts/library-api-http.mjs";

test("API 动态路径只匹配对应资源并安全解码 ID", () => {
  assert.equal(routePaperId("/api/papers/paper%201"), "paper 1");
  assert.equal(
    routePaperId("/api/papers/paper%201/pdf/archive", "pdf/archive"),
    "paper 1",
  );
  assert.equal(routeCategoryId("/api/categories/category-1"), "category-1");
  assert.equal(
    routeAiConnection(
      "/api/ai/connections/connection-1/models/verify",
      "models/verify",
    ),
    "connection-1",
  );
  assert.equal(
    routeAiModel("/api/ai/models/model-1/active", "active"),
    "model-1",
  );
  assert.equal(
    routeRadarItem("/api/radar/items/radar-1/discard", "discard"),
    "radar-1",
  );
  assert.equal(routePaperId("/api/categories/paper-1"), null);
  assert.throws(
    () => routePaperId("/api/papers/%E0%A4%A"),
    /论文 ID 编码无效/,
  );
});

test("PDF Range 解析支持完整、区间和后缀读取并拒绝非法范围", () => {
  assert.deepEqual(parsePdfRange(undefined, 100), { start: 0, end: 99 });
  assert.deepEqual(parsePdfRange("bytes=10-19", 100), {
    start: 10,
    end: 19,
  });
  assert.deepEqual(parsePdfRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(parsePdfRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.equal(parsePdfRange("bytes=100-101", 100), null);
  assert.equal(parsePdfRange("bytes=20-10", 100), null);
  assert.equal(parsePdfRange("items=0-1", 100), null);
});

test("内部错误响应隐藏实现细节，已分类错误保留可操作信息", () => {
  assert.deepEqual(errorPayload(new Error("数据库路径泄露")), {
    error: {
      code: "INTERNAL_ERROR",
      message: "本地文献库发生内部错误。",
    },
  });

  const validationError = new Error("输入不正确");
  validationError.statusCode = 400;
  validationError.code = "VALIDATION_ERROR";
  validationError.details = { field: "title" };
  assert.deepEqual(errorPayload(validationError), {
    error: {
      code: "VALIDATION_ERROR",
      message: "输入不正确",
      details: { field: "title" },
    },
  });
});
