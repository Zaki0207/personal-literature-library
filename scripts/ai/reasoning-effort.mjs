export const REASONING_EFFORTS = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export const AI_REQUEST_TIMEOUT_MS = 20 * 60_000;

const GPT_5_6_EFFORTS = Object.freeze([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const GPT_5_5_EFFORTS = Object.freeze([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
]);
const GPT_5_5_PRO_EFFORTS = Object.freeze(["medium", "high", "xhigh"]);
const LEGACY_GPT_5_EFFORTS = Object.freeze([
  "minimal",
  "low",
  "medium",
  "high",
]);
const DEEPSEEK_EFFORTS = Object.freeze(["high", "max"]);

export function reasoningEffortOptions(model) {
  const normalized = typeof model === "string" ? model.trim().toLowerCase() : "";
  if (normalized.startsWith("deepseek-")) return DEEPSEEK_EFFORTS;
  if (normalized.startsWith("gpt-5.6")) return GPT_5_6_EFFORTS;
  if (normalized.startsWith("gpt-5.5-pro")) return GPT_5_5_PRO_EFFORTS;
  if (normalized.startsWith("gpt-5.5")) return GPT_5_5_EFFORTS;
  if (/^gpt-5(?:-|$)/u.test(normalized)) return LEGACY_GPT_5_EFFORTS;
  return Object.freeze([]);
}

export function defaultReasoningEffort(model) {
  const normalized = typeof model === "string" ? model.trim().toLowerCase() : "";
  if (normalized.startsWith("deepseek-")) return "max";
  if (normalized.startsWith("gpt-5.5-pro")) return "high";
  const options = reasoningEffortOptions(normalized);
  return options.includes("medium") ? "medium" : null;
}

export function aiRequestTimeoutMs() {
  return AI_REQUEST_TIMEOUT_MS;
}

export function isDeepSeekModel(model) {
  return (
    typeof model === "string" && model.trim().toLowerCase().startsWith("deepseek-")
  );
}
