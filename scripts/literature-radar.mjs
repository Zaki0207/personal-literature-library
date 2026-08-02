import {
  dedupePaperIdentifiers,
  identifiersFromReference,
  normalizePaperTitle,
  normalizePaperUrl,
} from "./paper-identifiers.mjs";

const MAX_ROUNDS = 3;
const MAX_AI_EXCLUSION_CHARS = 80_000;

class LiteratureRadarError extends Error {
  constructor(message, { code = "LITERATURE_RADAR_ERROR", statusCode = 502, details } = {}) {
    super(message);
    this.name = "LiteratureRadarError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function validateRunInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LiteratureRadarError("请求正文必须是 JSON 对象。", {
      code: "VALIDATION_ERROR",
      statusCode: 400,
    });
  }
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  if (!prompt) {
    throw new LiteratureRadarError("请先填写文献检索提示词。", {
      code: "VALIDATION_ERROR",
      statusCode: 400,
      details: { field: "prompt" },
    });
  }
  if (prompt.length > 10_000) {
    throw new LiteratureRadarError("文献检索提示词不能超过 10000 个字符。", {
      code: "VALIDATION_ERROR",
      statusCode: 400,
      details: { field: "prompt" },
    });
  }
  if (!Number.isSafeInteger(value.count) || value.count < 1 || value.count > 30) {
    throw new LiteratureRadarError("每次推送数量必须是 1 到 30 之间的整数。", {
      code: "VALIDATION_ERROR",
      statusCode: 400,
      details: { field: "count" },
    });
  }
  return { prompt, count: value.count };
}

function stringValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? "").trim()).filter(Boolean).join(", ");
  }
  return typeof value === "string" ? value.trim() : "";
}

function parsePaperResponse(text) {
  const raw = String(text ?? "").trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new LiteratureRadarError("AI 没有返回可识别的论文列表，请重试。", {
      code: "RADAR_INVALID_AI_RESPONSE",
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new LiteratureRadarError("AI 返回的论文列表格式无效，请重试。", {
      code: "RADAR_INVALID_AI_RESPONSE",
    });
  }
  if (!Array.isArray(parsed?.papers)) {
    throw new LiteratureRadarError("AI 返回结果中缺少 papers 数组，请重试。", {
      code: "RADAR_INVALID_AI_RESPONSE",
    });
  }
  return parsed.papers;
}

function candidateFromAi(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const title = stringValue(raw.title);
  if (!title || !normalizePaperTitle(title)) return null;

  const explicitIdentifiers = Array.isArray(raw.identifiers)
    ? raw.identifiers
    : [];
  const references = [
    stringValue(raw.doi),
    stringValue(raw.arxiv),
    stringValue(raw.originalUrl || raw.url),
    stringValue(raw.pdfUrl),
  ].filter(Boolean);
  const identifiers = dedupePaperIdentifiers([
    ...explicitIdentifiers,
    ...references.flatMap(identifiersFromReference),
  ]);
  if (!identifiers.length) return null;

  let originalUrl = normalizePaperUrl(stringValue(raw.originalUrl || raw.url));
  if (!originalUrl) {
    const doi = identifiers.find((identifier) => identifier.kind === "doi");
    const arxiv = identifiers.find((identifier) => identifier.kind === "arxiv");
    originalUrl = doi
      ? `https://doi.org/${doi.value}`
      : arxiv
        ? `https://arxiv.org/abs/${arxiv.value}`
        : identifiers.find((identifier) => identifier.kind === "url")?.value ?? null;
  }
  const pdfUrl = normalizePaperUrl(stringValue(raw.pdfUrl));
  return {
    title,
    zhTitle: stringValue(raw.zhTitle || raw.chineseTitle),
    authors: stringValue(raw.authors),
    institution: stringValue(raw.institution),
    source: stringValue(raw.source || raw.venue || raw.journal),
    date: stringValue(raw.date || raw.publicationDate || raw.year),
    aiSummary: stringValue(raw.aiSummary || raw.summary),
    recommendationReason: stringValue(
      raw.recommendationReason || raw.reason,
    ),
    ...(originalUrl ? { originalUrl } : {}),
    ...(pdfUrl ? { pdfUrl } : {}),
    identifiers: dedupePaperIdentifiers([
      ...identifiers,
      ...(originalUrl ? [{ kind: "url", value: originalUrl }] : []),
    ]),
  };
}

function identifierKey(identifier) {
  return `${identifier.kind}:${identifier.value}`;
}

function compactExclusions(exclusions) {
  const entries = exclusions.map((entry, index) => ({
    n: index + 1,
    origin: entry.origin,
    status: entry.status,
    title: entry.title,
    ids: (entry.identifiers ?? []).map(identifierKey),
  }));
  const provided = [];
  let usedChars = 2;
  for (const entry of entries) {
    const serialized = JSON.stringify(entry);
    if (provided.length && usedChars + serialized.length + 1 > MAX_AI_EXCLUSION_CHARS) {
      break;
    }
    provided.push(entry);
    usedChars += serialized.length + 1;
  }
  return {
    provided,
    providedCount: provided.length,
    totalCount: entries.length,
  };
}

function searchPrompt({ userPrompt, requested, exclusions, round }) {
  return `你是网站内置的文献雷达。必须使用联网检索查找真实论文，并核验标题、作者、出处和原文链接。

用户可编辑的研究范围：
${userPrompt}

本轮任务：
- 这是第 ${round} 轮检索。
- 请返回 ${requested} 篇候选论文，尽量覆盖不同工作。
- 不得推荐下面排除清单中的任何论文，也不得推荐同一论文的不同链接或标题变体。
- 只返回有 DOI、arXiv 编号或可核验原文 URL 的论文。
- recommendationReason 说明它与用户研究范围的具体关系；aiSummary 用中文简要概括论文贡献。
- 不要编造论文、作者、出处或链接。

排除清单（来自当前知识库、历史待审/已加入/已丢弃记录及本次检索结果）：
${JSON.stringify(exclusions)}

只输出一个合法 JSON 对象，不要输出 Markdown 或额外文字。格式必须是：
{"papers":[{"title":"英文原题","zhTitle":"中文译题","authors":"作者，多个作者用逗号分隔","institution":"主要机构","source":"期刊/会议/arXiv","date":"YYYY-MM-DD 或 YYYY","aiSummary":"中文摘要","recommendationReason":"中文推荐理由","originalUrl":"论文原文或 DOI/arXiv 页面","pdfUrl":"可选 PDF URL","identifiers":[{"kind":"doi|arxiv|url","value":"规范标识"}]}]}`;
}

export function createLiteratureRadarService({ repository, aiService }) {
  if (!repository || !aiService) {
    throw new TypeError("文献雷达需要 repository 和 aiService。");
  }

  return {
    getState() {
      return repository.getRadarState();
    },

    async run(input) {
      const { prompt, count } = validateRunInput(input);
      await repository.saveRadarSettings({ prompt, count });

      const persistentExclusions = repository.getRadarExclusions();
      const compact = compactExclusions(persistentExclusions);
      const accepted = [];
      const seenTitles = new Set();
      const seenIdentifiers = new Set();
      const transientExclusions = [];
      const stats = {
        rounds: 0,
        examined: 0,
        excludedLibrary: 0,
        excludedHistory: 0,
        excludedWithinRun: 0,
        invalid: 0,
      };

      for (let round = 1; round <= MAX_ROUNDS && accepted.length < count; round += 1) {
        const remaining = count - accepted.length;
        const requested = Math.min(30, remaining + Math.min(5, remaining));
        const result = await aiService.generateText({
          input: searchPrompt({
            userPrompt: prompt,
            requested,
            exclusions: [...compact.provided, ...transientExclusions],
            round,
          }),
          webSearch: true,
        });
        stats.rounds = round;
        const rawPapers = parsePaperResponse(result.text);
        stats.examined += rawPapers.length;

        for (const rawPaper of rawPapers) {
          const candidate = candidateFromAi(rawPaper);
          if (!candidate) {
            stats.invalid += 1;
            continue;
          }
          const titleKey = normalizePaperTitle(candidate.title);
          const identifierKeys = candidate.identifiers.map(identifierKey);
          const withinRun =
            seenTitles.has(titleKey) ||
            identifierKeys.some((key) => seenIdentifiers.has(key));
          if (withinRun) {
            stats.excludedWithinRun += 1;
            continue;
          }

          const libraryMatches = repository.findPaperDuplicates(candidate);
          const radarMatches = repository.findRadarDuplicates(candidate);
          transientExclusions.push({
            n: `round-${round}-${transientExclusions.length + 1}`,
            origin: libraryMatches.length
              ? "library"
              : radarMatches.length
                ? "radar"
                : "current-run",
            title: candidate.title,
            ids: identifierKeys,
          });
          if (libraryMatches.length) {
            stats.excludedLibrary += 1;
            continue;
          }
          if (radarMatches.length) {
            stats.excludedHistory += 1;
            continue;
          }

          seenTitles.add(titleKey);
          identifierKeys.forEach((key) => seenIdentifiers.add(key));
          accepted.push(candidate);
          if (accepted.length >= count) break;
        }
      }

      const saved = await repository.saveRadarCandidates(accepted);
      const state = repository.getRadarState();
      return {
        ...state,
        lastRun: {
          requested: count,
          added: saved.inserted.length,
          insufficient: saved.inserted.length < count,
          ...stats,
        },
        context: {
          providedToAi: compact.providedCount,
          totalExclusions: compact.totalCount,
          locallyChecked: compact.totalCount,
        },
      };
    },
  };
}
