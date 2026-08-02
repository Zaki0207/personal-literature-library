const FIELD_WEIGHTS = Object.freeze({
  identifier: 140,
  source: 110,
  year: 105,
  title: 100,
  zhTitle: 100,
  authors: 85,
  institution: 75,
  categories: 60,
  aiSummary: 38,
  note: 28,
  resources: 18,
});

const FIELD_ORDER = Object.freeze(Object.keys(FIELD_WEIGHTS));

const SEARCH_ALIAS_GROUPS = Object.freeze([
  {
    key: "cvpr",
    kind: "venue",
    aliases: [
      "cvpr",
      "ieee cvf cvpr",
      "computer vision and pattern recognition",
      "ieee conference on computer vision and pattern recognition",
    ],
  },
  {
    key: "iccv",
    kind: "venue",
    aliases: [
      "iccv",
      "international conference on computer vision",
      "ieee international conference on computer vision",
    ],
  },
  {
    key: "eccv",
    kind: "venue",
    aliases: [
      "eccv",
      "european conference on computer vision",
    ],
  },
  {
    key: "neurips",
    kind: "venue",
    aliases: [
      "neurips",
      "nips",
      "neural information processing systems",
    ],
  },
  {
    key: "iclr",
    kind: "venue",
    aliases: [
      "iclr",
      "international conference on learning representations",
    ],
  },
  {
    key: "aaai",
    kind: "venue",
    aliases: [
      "aaai",
      "aaai conference on artificial intelligence",
    ],
  },
  {
    key: "siggraph asia",
    kind: "venue",
    aliases: ["siggraph asia", "acm siggraph asia"],
  },
  {
    key: "siggraph",
    kind: "venue",
    aliases: ["siggraph", "acm siggraph"],
  },
  {
    key: "acm mm",
    kind: "venue",
    aliases: ["acm mm", "acm multimedia"],
  },
  {
    key: "3dv",
    kind: "venue",
    aliases: ["3dv", "international conference on 3d vision"],
  },
  {
    key: "smoke",
    kind: "concept",
    aliases: [
      "烟雾",
      "烟气",
      "smoke",
      "smoke simulation",
      "volumetric smoke",
    ],
  },
  {
    key: "fluid",
    kind: "concept",
    aliases: ["流体", "fluid", "fluid simulation", "fluid dynamics"],
  },
  {
    key: "reconstruction",
    kind: "concept",
    aliases: ["重建", "reconstruction", "reconstruct"],
  },
  {
    key: "gaussian splatting",
    kind: "concept",
    aliases: [
      "高斯泼溅",
      "高斯溅射",
      "gaussian splatting",
      "3d gaussian splatting",
      "3dgs",
    ],
  },
  {
    key: "rendering",
    kind: "concept",
    aliases: ["渲染", "render", "rendering"],
  },
  {
    key: "surface",
    kind: "concept",
    aliases: ["表面", "surface"],
  },
  {
    key: "dynamic",
    kind: "concept",
    aliases: ["动态", "dynamic", "dynamics"],
  },
  {
    key: "physics",
    kind: "concept",
    aliases: ["物理", "physics", "physical"],
  },
]);

export function normalizeSearchText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeCompact(value) {
  return normalizeSearchText(value).replace(/\s+/gu, "");
}

const NORMALIZED_ALIAS_GROUPS = SEARCH_ALIAS_GROUPS.map((group) => ({
  ...group,
  aliases: [...new Set(group.aliases.map(normalizeSearchText).filter(Boolean))],
}));

const ALIAS_GROUP_BY_VALUE = new Map(
  NORMALIZED_ALIAS_GROUPS.flatMap((group) =>
    group.aliases.map((alias) => [alias, group]),
  ),
);

function paperIdentifierValues(paper) {
  const values = Array.isArray(paper.identifiers)
    ? paper.identifiers.flatMap((identifier) => [
        identifier?.value,
        identifier?.kind && identifier?.value
          ? `${identifier.kind}:${identifier.value}`
          : "",
      ])
    : [];
  for (const rawUrl of [paper.originalUrl, paper.pdfUrl]) {
    if (typeof rawUrl !== "string" || !rawUrl.trim()) continue;
    values.push(rawUrl.trim());
    try {
      const url = new URL(rawUrl);
      values.push(url.hostname, decodeURIComponent(url.pathname));
      if (/^(?:dx\.)?doi\.org$/iu.test(url.hostname)) {
        values.push(decodeURIComponent(url.pathname).replace(/^\/+/, ""));
      }
      const arxivMatch = url.pathname.match(
        /^\/(?:abs|pdf)\/([^/?#]+?)(?:\.pdf)?$/iu,
      );
      if (arxivMatch) values.push(arxivMatch[1].replace(/v\d+$/iu, ""));
    } catch {
      // URL validity is enforced by the repository; ignore legacy malformed data.
    }
  }
  return values;
}

function normalizedField(value) {
  const text = normalizeSearchText(value);
  return { text, compact: text.replace(/\s+/gu, "") };
}

export function buildPaperSearchDocument(paper, { categoryNames = [] } = {}) {
  const yearMatch = String(paper.date ?? "").match(/(?:^|\D)((?:19|20)\d{2})(?:\D|$)/u);
  const directCategoryNames = Array.isArray(paper.tags)
    ? paper.tags.map((tag) => tag?.label).filter(Boolean)
    : [];
  const fields = {
    identifier: paperIdentifierValues(paper).join(" "),
    source: paper.source ?? "",
    year: yearMatch?.[1] ?? "",
    title: paper.title ?? "",
    zhTitle: paper.zhTitle ?? "",
    authors: paper.authors ?? "",
    institution: paper.institution ?? "",
    categories: [...directCategoryNames, ...categoryNames].join(" "),
    aiSummary: paper.aiSummary ?? "",
    note: paper.note ?? "",
    resources: [
      paper.codeProvider,
      paper.codeUrl,
      paper.projectProvider,
      paper.projectUrl,
    ]
      .filter(Boolean)
      .join(" "),
  };

  return {
    paperId: paper.id,
    fields: Object.fromEntries(
      Object.entries(fields).map(([name, value]) => [name, normalizedField(value)]),
    ),
  };
}

function parseIdentifierQuery(query) {
  const trimmed = String(query ?? "").normalize("NFKC").trim();
  const doiMatch = trimmed.match(
    /^(?:(?:https?:\/\/(?:dx\.)?doi\.org\/)|(?:doi\s*:\s*))?(10\.\d{4,9}\/\S+)$/iu,
  );
  if (doiMatch) {
    return {
      kind: "doi",
      value: doiMatch[1].replace(/[.,;]+$/u, "").toLocaleLowerCase("en"),
    };
  }

  const arxivMatch = trimmed.match(
    /^(?:(?:https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/)|(?:arxiv\s*:\s*))?((?:[a-z-]+(?:\.[a-z-]+)?\/\d{7})|(?:\d{4}\.\d{4,5}))(?:v\d+)?(?:\.pdf)?$/iu,
  );
  if (arxivMatch) {
    return { kind: "arxiv", value: arxivMatch[1].toLocaleLowerCase("en") };
  }

  if (/^https?:\/\//iu.test(trimmed)) {
    return { kind: "url", value: trimmed.toLocaleLowerCase("en") };
  }
  return null;
}

function parseQueryParts(query) {
  const phrases = [];
  const remainder = String(query ?? "").replace(
    /["“”]([^"“”]+)["“”]/gu,
    (_match, phrase) => {
      const normalized = normalizeSearchText(phrase);
      if (normalized) phrases.push(normalized);
      return " ";
    },
  );
  const words = normalizeSearchText(remainder).split(/\s+/gu).filter(Boolean);
  return [...phrases, ...words];
}

function queryGroupForTerm(term) {
  const aliasGroup = ALIAS_GROUP_BY_VALUE.get(term);
  if (!aliasGroup) return { term, aliases: [term], kind: "literal" };
  return {
    term,
    aliases: aliasGroup.aliases,
    kind: aliasGroup.kind,
    key: aliasGroup.key,
  };
}

function fieldMatchScore(field, aliases, originalTerm) {
  let best = null;
  for (const alias of aliases) {
    if (!alias) continue;
    const compactAlias = normalizeCompact(alias);
    let quality = 0;
    if (field.text === alias || field.compact === compactAlias) quality = 64;
    else if (field.text.startsWith(`${alias} `)) quality = 46;
    else if (field.text.includes(alias)) quality = 32;
    else if (compactAlias && field.compact.includes(compactAlias)) quality = 22;
    if (!quality) continue;
    const expandedPenalty = alias === originalTerm ? 0 : 8;
    const candidate = { quality: Math.max(1, quality - expandedPenalty), alias };
    if (!best || candidate.quality > best.quality) best = candidate;
  }
  return best;
}

function fieldsForIntent(intent) {
  if (intent === "venue") return ["source"];
  if (intent === "year") return ["year"];
  if (intent === "identifier") return ["identifier"];
  return FIELD_ORDER;
}

export function matchPaperSearch(paper, query, options = {}) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return { matched: true, score: 0, matchedFields: [], intent: "empty" };
  }

  const document = buildPaperSearchDocument(paper, options);
  const identifierQuery = parseIdentifierQuery(query);
  if (identifierQuery) {
    const match = fieldMatchScore(
      document.fields.identifier,
      [normalizeSearchText(identifierQuery.value)],
      normalizeSearchText(identifierQuery.value),
    );
    return {
      matched: Boolean(match),
      score: match ? FIELD_WEIGHTS.identifier + match.quality + 100 : 0,
      matchedFields: match ? ["identifier"] : [],
      intent: "identifier",
    };
  }

  const exactAliasGroup = ALIAS_GROUP_BY_VALUE.get(normalizedQuery);
  const yearOnly = /^(?:19|20)\d{2}$/u.test(normalizedQuery);
  const intent =
    exactAliasGroup?.kind === "venue"
      ? "venue"
      : yearOnly
        ? "year"
        : "general";
  const queryParts = parseQueryParts(query);
  const groups = (queryParts.length ? queryParts : [normalizedQuery]).map(
    queryGroupForTerm,
  );
  const allowedFields = fieldsForIntent(intent);
  const matchedFields = new Set();
  let score = 0;

  for (const group of groups) {
    let bestForGroup = null;
    for (const fieldName of allowedFields) {
      const field = document.fields[fieldName];
      const match = fieldMatchScore(field, group.aliases, group.term);
      if (!match) continue;
      const candidate = {
        fieldName,
        score: FIELD_WEIGHTS[fieldName] + match.quality,
      };
      if (!bestForGroup || candidate.score > bestForGroup.score) {
        bestForGroup = candidate;
      }
    }
    if (!bestForGroup) {
      return { matched: false, score: 0, matchedFields: [], intent };
    }
    matchedFields.add(bestForGroup.fieldName);
    score += bestForGroup.score;
  }

  if (intent === "general") {
    for (const fieldName of FIELD_ORDER) {
      const field = document.fields[fieldName];
      if (
        field.text.includes(normalizedQuery) ||
        field.compact.includes(normalizedQuery.replace(/\s+/gu, ""))
      ) {
        score += Math.round(FIELD_WEIGHTS[fieldName] * 0.35);
        matchedFields.add(fieldName);
      }
    }
  }

  return {
    matched: true,
    score,
    matchedFields: [...matchedFields].sort(
      (left, right) => FIELD_WEIGHTS[right] - FIELD_WEIGHTS[left],
    ),
    intent,
  };
}

export function comparePaperSearchMatches(left, right) {
  return (right?.score ?? 0) - (left?.score ?? 0);
}
