import {
  dedupePaperIdentifiers,
  identifiersFromReference,
  normalizePaperTitle,
  normalizePaperUrl,
} from "./paper-identifiers.mjs";
import { DEFAULT_RADAR_PROMPT_TEMPLATE } from "./library-repository.mjs";

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

function jsonObjectCandidates(value) {
  const candidates = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(value.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return candidates;
}

function parsePaperResponse(text) {
  const raw = String(text ?? "")
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  const candidates = [...new Set([raw, ...jsonObjectCandidates(raw)])].filter(
    Boolean,
  );
  if (!candidates.length) {
    throw new LiteratureRadarError("AI 没有返回可识别的论文列表，请重试。", {
      code: "RADAR_INVALID_AI_RESPONSE",
    });
  }
  let parsedObject = false;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      parsedObject = true;
      if (Array.isArray(parsed?.papers)) return parsed.papers;
    } catch {
      // Continue in case the model placed a valid JSON object after prose or citations.
    }
  }
  if (parsedObject) {
    throw new LiteratureRadarError("AI 返回结果中缺少 papers 数组，请重试。", {
      code: "RADAR_INVALID_AI_RESPONSE",
    });
  }
  throw new LiteratureRadarError("AI 返回的论文列表格式无效，请重试。", {
    code: "RADAR_INVALID_AI_RESPONSE",
  });
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

function searchPrompt({ template, userPrompt, requested, exclusions, round }) {
  const replacements = new Map([
    ["{{research_scope}}", userPrompt],
    ["{{round}}", String(round)],
    ["{{requested_count}}", String(requested)],
    ["{{exclusions_json}}", JSON.stringify(exclusions)],
  ]);
  let rendered = template;
  for (const [variable, replacement] of replacements) {
    rendered = rendered.replaceAll(variable, () => replacement);
  }
  return rendered;
}

export function createLiteratureRadarService({ repository, aiService }) {
  if (!repository || !aiService) {
    throw new TypeError("文献雷达需要 repository 和 aiService。");
  }

  return {
    getState() {
      return repository.getRadarState();
    },

    getAiTrace() {
      return repository.getRadarAiTrace();
    },

    getDefaultPromptTemplate() {
      return DEFAULT_RADAR_PROMPT_TEMPLATE;
    },

    async savePromptTemplate(value) {
      await repository.saveRadarPromptTemplate(value);
      return repository.getRadarState();
    },

    async run(input) {
      const { prompt, count } = validateRunInput(input);
      const savedSettings = await repository.saveRadarSettings({
        prompt,
        count,
      });
      const promptTemplate = savedSettings.settings.promptTemplate;

      const trace = {
        status: "running",
        requestedCount: count,
        userPrompt: prompt,
        exchanges: [],
        startedAt: new Date().toISOString(),
        completedAt: "",
        errorMessage: "",
      };

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
        invalidResponses: 0,
      };
      let validResponseCount = 0;
      let lastInvalidResponseError = null;

      try {
        await repository.saveRadarAiTrace(trace);
        for (
          let round = 1;
          round <= MAX_ROUNDS && accepted.length < count;
          round += 1
        ) {
          const remaining = count - accepted.length;
          const requested = Math.min(30, remaining + Math.min(5, remaining));
          const aiPrompt = searchPrompt({
            template: promptTemplate,
            userPrompt: prompt,
            requested,
            exclusions: [...compact.provided, ...transientExclusions],
            round,
          });
          const exchange = {
            round,
            prompt: aiPrompt,
            response: "",
            startedAt: new Date().toISOString(),
            completedAt: "",
            provider: "",
            model: "",
            latencyMs: null,
            errorMessage: "",
          };
          trace.exchanges.push(exchange);
          await repository.saveRadarAiTrace(trace);
          const result = await aiService.generateText({
            input: aiPrompt,
            webSearch: true,
          });
          exchange.response = result.text;
          exchange.completedAt = new Date().toISOString();
          exchange.provider = result.provider ?? "";
          exchange.model = result.resolvedModel ?? result.requestedModel ?? "";
          exchange.latencyMs = result.latencyMs ?? null;
          await repository.saveRadarAiTrace(trace);
          stats.rounds = round;
          let rawPapers;
          try {
            rawPapers = parsePaperResponse(result.text);
            validResponseCount += 1;
          } catch (error) {
            if (error?.code !== "RADAR_INVALID_AI_RESPONSE") throw error;
            stats.invalidResponses += 1;
            lastInvalidResponseError = error;
            exchange.errorMessage = error.message;
            await repository.saveRadarAiTrace(trace);
            continue;
          }
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

        if (!validResponseCount && lastInvalidResponseError) {
          throw lastInvalidResponseError;
        }

        const saved = await repository.saveRadarCandidates(accepted);
        trace.status = "completed";
        trace.completedAt = new Date().toISOString();
        await repository.saveRadarAiTrace(trace);
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
      } catch (error) {
        trace.status = "failed";
        trace.completedAt = new Date().toISOString();
        trace.errorMessage =
          error instanceof Error ? error.message : "文献雷达运行失败。";
        const lastExchange = trace.exchanges.at(-1);
        if (lastExchange && !lastExchange.completedAt) {
          lastExchange.completedAt = trace.completedAt;
          lastExchange.errorMessage = trace.errorMessage;
        }
        try {
          await repository.saveRadarAiTrace(trace);
        } catch {
          // Preserve the original radar error if recording the trace also fails.
        }
        throw error;
      }
    },
  };
}
