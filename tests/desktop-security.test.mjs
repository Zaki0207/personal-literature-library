import assert from "node:assert/strict";
import test from "node:test";
import { parsePdfUrl, safeExternalUrl, validateApiRequest } from "../desktop/shared/security.mjs";
import { createQuitHandshake } from "../desktop/shared/quit-handshake.mjs";

test("desktop bridge restricts methods and routes instead of allowing arbitrary HTTP", () => {
  assert.equal(validateApiRequest({ path: "/api/papers/local-123", method: "PATCH", body: { note: "saved" } }).method, "PATCH");
  assert.equal(validateApiRequest({ path: "/api/ai/models/model-1/active", method: "PUT" }).method, "PUT");
  assert.equal(validateApiRequest({ path: "/api/papers/local-1/reading-position?pdfVersion=fingerprint%3Aabc123" }).method, "GET");
  assert.equal(validateApiRequest({ path: "/api/paper-intake/prompt-template" }).method, "GET");
  assert.equal(validateApiRequest({ path: "/api/paper-intake/prompt-template", method: "PUT", body: { promptTemplate: "research instructions" } }).method, "PUT");
  assert.equal(validateApiRequest({ path: "/api/paper-intake/prompt-template/reset", method: "POST" }).method, "POST");
  assert.throws(() => validateApiRequest({ path: "/api/paper-intake/prompt-template", method: "DELETE" }));
  assert.throws(() => validateApiRequest({ path: "/api/paper-intake/prompt-template/reset", method: "PUT" }));
  for (const path of ["https://example.com/api/library", "/api/../secret", "/api/papers/%2e%2e", "/api/papers/id/pdf/import", "/api/library?path=/etc/passwd"]) {
    assert.throws(() => validateApiRequest({ path, method: "POST" }));
  }
  assert.throws(() => validateApiRequest({ path: "/api/library", method: "DELETE" }));
  assert.throws(() => validateApiRequest({ path: "/api/library", headers: { Authorization: "secret" } }));
  assert.throws(() => validateApiRequest({ path: "/api/papers", method: "POST", body: { note: "a".repeat(1_048_577) } }));
});

test("PDF protocol accepts stable paper IDs and never accepts filesystem locations", () => {
  assert.equal(parsePdfUrl("literature-pdf://paper/local-123"), "local-123");
  for (const url of ["file:///etc/passwd", "literature-pdf://other/local-123", "literature-pdf://paper/%2fetc%2fpasswd", "literature-pdf://paper/id?path=/etc/passwd", "literature-pdf://paper/../../secret"]) assert.throws(() => parsePdfUrl(url));
});

test("external navigation allows normal web links and blocks executable and credential URLs", () => {
  assert.equal(safeExternalUrl("https://arxiv.org/abs/2601.00001"), "https://arxiv.org/abs/2601.00001");
  for (const value of ["file:///etc/passwd", "javascript:alert(1)", "https://user:password@example.com", "mailto:user@example.com"]) assert.throws(() => safeExternalUrl(value));
});

test("application quit requires permission from every window", async () => {
  const handshake = createQuitHandshake([1, 2], { timeoutMs: 100 });
  handshake.acknowledge(1, { allow: true, requestId: handshake.requestId });
  handshake.acknowledge(2, { allow: true, requestId: handshake.requestId });
  assert.equal(await handshake.result, true);
});

test("refused or missing quit acknowledgement preserves the application", async () => {
  const refusal = createQuitHandshake([1], { timeoutMs: 100 });
  refusal.acknowledge(1, { allow: false, requestId: refusal.requestId });
  assert.equal(await refusal.result, false);
  const absent = createQuitHandshake([1], { timeoutMs: 10 });
  absent.acknowledge(1, { allow: true, requestId: "previous-quit-attempt" });
  assert.equal(await absent.result, false);
});
