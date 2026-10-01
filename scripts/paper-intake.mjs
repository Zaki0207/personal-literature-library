import { readFileSync } from "node:fs";
import { dedupePaperIdentifiers } from "./paper-identifiers.mjs";
import { isPrivateOrReservedAddress } from "./network-safety.mjs";

const MAX_INPUT_LENGTH = 12_000;
const RESEARCH_PROMPT = readFileSync(new URL("./prompts/paper-intake.txt", import.meta.url), "utf8").trim();
const RESULT_STATUSES = ["ready", "needs_clarification", "research_incomplete", "not_found"];

class PaperIntakeError extends Error {
  constructor(message, { statusCode = 400, code = "PAPER_INTAKE_ERROR" } = {}) {
    super(message);
    this.name = "PaperIntakeError";
    this.statusCode = statusCode;
    this.code = code;
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
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const character = raw[i];
    if (depth === 0) {
      if (character === "{") {
        start = i;
        depth = 1;
        quoted = false;
        escaped = false;
      }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{") {
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        try {
          const result = JSON.parse(raw.slice(start, i + 1));
          if (RESULT_STATUSES.includes(result.status)) return result;
        } catch {
          // Accept a complete JSON result even if the model wraps it in prose.
        }
      }
    }
  }
  throw invalidResult();
}

function invalidResult() {
  return new PaperIntakeError("AI 返回的论文资料格式不完整，请重试或切换模型。", {
    statusCode: 502, code: "INVALID_AI_RESULT",
  });
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

export function createPaperIntakeService({ repository, aiService } = {}) {
  if (!repository || typeof aiService?.generateText !== "function") {
    throw new TypeError("Paper Intake 需要 repository 和 AI Service。");
  }
  return {
    async analyze(input = {}) {
      const reference = validateReference(input);
      const categories = categoryPaths(repository.getCategories().categories.filter((category) => !category.deletedAt));
      const generated = await aiService.generateText({
        input: [RESEARCH_PROMPT, "", "用户线索（JSON 字符串）：", JSON.stringify(reference),
          "", "现有分类：", JSON.stringify(categories)].join("\n"),
        webSearch: true,
        ...(input.modelId ? { modelId: input.modelId } : {}),
      });
      const result = parseResult(generated.text);
      const sources = sourcesFromResult(result.sources);
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
          ...draft, metadataSource: "AI 联网整理",
          publicationStatus: ["published", "preprint"].includes(result.paper.publicationStatus)
            ? result.paper.publicationStatus : "unknown",
          codeEvidence: draft.codeUrl ? "AI 整理，请核对是否为官方代码" : "",
          projectEvidence: draft.projectUrl ? "AI 整理" : "",
          sources, matchReason: text(result.matchReason),
          warnings: (Array.isArray(result.warnings) ? result.warnings : []).map(text).filter(Boolean),
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
