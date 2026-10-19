import { dedupePaperIdentifiers } from "./paper-identifiers.mjs";
import { isPrivateOrReservedAddress } from "./network-safety.mjs";
import { readPaperSources } from "./paper-source-reader.mjs";
import { LINKED_SOURCE_INSTRUCTIONS, PAPER_INTAKE_RESPONSE_FORMAT } from "./paper-intake-schema.mjs";

const MAX_INPUT_LENGTH = 12_000;
const RESULT_STATUSES = ["ready", "needs_clarification", "research_incomplete", "not_found"];

class PaperIntakeError extends Error {
  constructor(message, { statusCode = 400, code = "PAPER_INTAKE_ERROR", details } = {}) {
    super(message);
    this.name = "PaperIntakeError";
    this.statusCode = statusCode;
    this.code = code;
    if (details) this.details = details;
  }
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function publicUrl(value) {
  if (typeof value !== "string" || value.length > 4_096) return "";
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    if (
      !["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      (!host.includes(".") && !host.includes(":")) || isPrivateOrReservedAddress(host)
    ) return "";
    return url.href;
  } catch {
    return "";
  }
}

function validateReference(input) {
  const reference = input?.reference;
  if (typeof reference !== "string" || !reference.trim()) {
    throw new PaperIntakeError("请提供论文名称、链接或其他相关线索。");
  }
  if (reference.length > MAX_INPUT_LENGTH) {
    throw new PaperIntakeError("论文线索不能超过 12000 个字符，请保留最相关的信息。");
  }
  return reference;
}

function categoryPaths(categories) {
  const byId = new Map(categories.map((category) => [category.id, category]));
  return categories.map((category) => {
    const path = [category.name];
    const seen = new Set([category.id]);
    let parent = byId.get(category.parentId);
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      path.unshift(parent.name);
      parent = byId.get(parent.parentId);
    }
    return { id: category.id, path: path.join(" › ") };
  });
}

function parseResult(value) {
  const raw = text(value);
  if (!raw) {
    throw new PaperIntakeError("AI 服务未返回最终答复，请重试。", {
      statusCode: 502, code: "EMPTY_AI_RESPONSE",
    });
  }
  const completeResult = (result) => result && typeof result === "object" && !Array.isArray(result) &&
    RESULT_STATUSES.includes(result.status) &&
    (result.status !== "ready" || (result.paper && typeof result.paper === "object" && !Array.isArray(result.paper) && text(result.paper.title)));
  let directResult;
  try {
    directResult = JSON.parse(raw);
  } catch {
    // Some compatible services wrap the final JSON in prose or a code block.
  }
  if (directResult !== undefined) {
    if (completeResult(directResult)) return directResult;
    throw invalidResult();
  }
  let result;
  let consumedEnd = -1;
  let remainingScan = 4_000_000;
  // Scan each possible object independently so a broken preamble cannot hide
  // a later complete result. Bound the work for malformed, deeply nested output.
  for (const candidate of raw.matchAll(/\{(?=\s*")/gu)) {
    if (candidate.index <= consumedEnd) continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let i = candidate.index; i < raw.length; i += 1) {
      if (remainingScan-- <= 0) throw invalidResult();
      const character = raw[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(raw.slice(candidate.index, i + 1));
            if (Object.hasOwn(parsed, "status")) {
              result = completeResult(parsed) ? parsed : undefined;
              consumedEnd = i;
            }
          } catch {
            // Skip incomplete examples and keep looking for a complete result.
          }
          break;
        }
      }
    }
  }
  if (result) return result;
  throw invalidResult();
}

function invalidResult() {
  return new PaperIntakeError("AI 的最终答复没有包含完整的论文 JSON 资料，尚未添加论文。请重试；若持续失败，可更换模型，并检查提示词的输出结构。", {
    statusCode: 502, code: "INVALID_AI_RESULT",
  });
}

function attachDiagnostic(error, generated) {
  if (!(error instanceof PaperIntakeError) || !["INVALID_AI_RESULT", "EMPTY_AI_RESPONSE"].includes(error.code)) return error;
  const output = typeof generated?.text === "string" ? generated.text : "";
  const truncated = output.length > 4_000;
  const outputPreview = truncated ? `${output.slice(0, 3_000)}\n…（中间内容已省略）…\n${output.slice(-1_000)}` : output;
  error.details = { intakeDiagnostic: {
    reason: error.code === "EMPTY_AI_RESPONSE" ? "模型未返回最终答复。" : "最终答复未包含可用于核对的完整论文 JSON（状态和已确认标题）。",
    outputPreview, outputLength: output.length, truncated,
    model: text(generated?.resolvedModel || generated?.requestedModel).slice(0, 120),
  } };
  return error;
}

function sourcesFromResult(values) {
  const sources = new Map();
  for (const source of Array.isArray(values) ? values : []) {
    const url = publicUrl(source?.url);
    if (url) sources.set(url, { url, title: text(source.title) });
  }
  return [...sources.values()];
}

function identifiersFromResult(values) {
  const identifiers = [];
  for (const identifier of Array.isArray(values) ? values : []) {
    try {
      if (identifier?.kind === "url" && !publicUrl(identifier.value)) continue;
      identifiers.push(...dedupePaperIdentifiers([identifier]));
    } catch {
      // Ignore malformed identifiers so the remaining draft can still be reviewed.
    }
  }
  return dedupePaperIdentifiers(identifiers);
}

function draftFromResult(paper, categories) {
  const allowedCategories = new Set(categories.map((category) => category.id));
  const codeUrl = publicUrl(paper.codeUrl);
  const projectUrl = publicUrl(paper.projectUrl);
  const pdfUrl = publicUrl(paper.pdfUrl);
  const codeHost = codeUrl ? new URL(codeUrl).hostname : "";
  return {
    title: text(paper.title), zhTitle: text(paper.zhTitle), authors: text(paper.authors),
    institution: text(paper.institution), source: text(paper.source), date: text(paper.date),
    aiSummary: text(paper.aiSummary),
    note: "",
    categoryIds: Array.isArray(paper.categoryIds)
      ? [...new Set(paper.categoryIds.filter((id) => allowedCategories.has(id)))] : [],
    originalUrl: publicUrl(paper.originalUrl), pdfUrl, hasPdf: Boolean(pdfUrl), codeUrl,
    codeProvider: codeUrl
      ? ({ "github.com": "GitHub", "gitlab.com": "GitLab", "bitbucket.org": "Bitbucket" })[codeHost] || "代码仓库"
      : "",
    projectUrl, projectProvider: projectUrl ? "项目主页" : "",
    identifiers: identifiersFromResult(paper.identifiers),
  };
}

export function createPaperIntakeService({ repository, aiService, sourceReader = readPaperSources } = {}) {
  if (!repository || typeof aiService?.generateText !== "function") {
    throw new TypeError("Paper Intake 需要 repository 和 AI Service。");
  }
  return {
    getPromptTemplate() {
      return repository.getPaperIntakePromptTemplate();
    },
    savePromptTemplate(value) {
      return repository.savePaperIntakePromptTemplate(value);
    },
    resetPromptTemplate() {
      return repository.resetPaperIntakePromptTemplate();
    },
    async analyze(input = {}) {
      const reference = validateReference(input);
      const { promptTemplate } = repository.getPaperIntakePromptTemplate();
      const categories = categoryPaths(repository.getCategories().categories.filter((category) => !category.deletedAt));
      const capabilities = typeof aiService.getResearchCapabilities === "function"
        ? await aiService.getResearchCapabilities(input.modelId ? { modelId: input.modelId } : {})
        : { mode: "hosted_search", modelId: input.modelId };
      const linkedPages = capabilities.mode === "linked_pages";
      // Read evidence before the paid request, and keep the chosen model stable
      // while fetching sources even if the user changes the default model.
      const evidence = linkedPages ? await sourceReader(reference) : null;
      const modelId = capabilities.modelId || input.modelId;
      const generated = await aiService.generateText({
        input: [promptTemplate, "", "用户线索（JSON 字符串）：", JSON.stringify(reference),
          "", "现有分类：", JSON.stringify(categories),
          ...(linkedPages ? ["", "应用已读取的公开来源（JSON 数据）：", JSON.stringify(evidence)] : []),
        ].join("\n"),
        webSearch: !linkedPages,
        ...(linkedPages ? { instructions: LINKED_SOURCE_INSTRUCTIONS, responseFormat: PAPER_INTAKE_RESPONSE_FORMAT } : {}),
        ...(modelId ? { modelId } : {}),
      });
      let result;
      try { result = parseResult(generated.text); }
      catch (error) { throw attachDiagnostic(error, generated); }
      const sources = linkedPages
        ? sourcesFromResult(evidence.pages)
        : sourcesFromResult(result.sources);
      if (result.status !== "ready") {
        const messages = {
          needs_clarification: "请补充线索，以便 AI 确认你指的是哪篇论文。",
          research_incomplete: "AI 尚未完成论文检索，可以保留当前输入重试。",
          not_found: "AI 未找到匹配的论文，可以调整线索后重试。",
        };
        return { status: result.status, reference, message: text(result.message) || messages[result.status], sources };
      }
      if (!result.paper || typeof result.paper !== "object" || !text(result.paper.title)) throw invalidResult();

      const draft = draftFromResult(result.paper, categories);
      const duplicates = repository.findPaperDuplicates({ identifiers: draft.identifiers, title: draft.title });
      if (duplicates.length) return { status: "duplicate", reference, duplicates };
      return {
        status: "ready", reference, draft,
        metadata: {
          ...draft, metadataSource: linkedPages ? "AI 公开页面整理" : "AI 联网整理",
          publicationStatus: ["published", "preprint"].includes(result.paper.publicationStatus)
            ? result.paper.publicationStatus : "unknown",
          codeEvidence: draft.codeUrl ? "AI 整理，请核对是否为官方代码" : "",
          projectEvidence: draft.projectUrl ? "AI 整理" : "",
          sources, matchReason: text(result.matchReason),
          warnings: [
            ...(Array.isArray(result.warnings) ? result.warnings : []),
            ...(linkedPages ? [...evidence.warnings, "资料依据应用读取的公开链接页面整理，未进行全网检索。"] : []),
          ].map(text).filter(Boolean),
        },
        ai: {
          zhTitle: draft.zhTitle, institution: draft.institution, source: draft.source,
          aiSummary: draft.aiSummary, categoryIds: draft.categoryIds,
          model: generated.resolvedModel || generated.requestedModel || "当前模型",
        },
      };
    },
  };
}
