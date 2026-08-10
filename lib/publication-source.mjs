const VENUE_RULES = Object.freeze([
  {
    abbreviation: "SIGGRAPH Asia",
    patterns: [/\bsiggraph\s+asia\b/iu],
  },
  {
    abbreviation: "SIGGRAPH",
    patterns: [
      /\bsiggraph\b/iu,
      /special\s+interest\s+group\s+on\s+computer\s+graphics\s+and\s+interactive\s+techniques(?:\s+conference)?/iu,
    ],
  },
  {
    abbreviation: "CVPR",
    patterns: [
      /\bcvpr\b/iu,
      /conference\s+on\s+computer\s+vision\s+and\s+pattern\s+recognition/iu,
    ],
  },
  {
    abbreviation: "ICCV",
    patterns: [
      /\biccv\b/iu,
      /international\s+conference\s+on\s+computer\s+vision/iu,
    ],
  },
  {
    abbreviation: "ECCV",
    patterns: [
      /\beccv\b/iu,
      /european\s+conference\s+on\s+computer\s+vision/iu,
    ],
  },
  {
    abbreviation: "WACV",
    patterns: [
      /\bwacv\b/iu,
      /winter\s+conference\s+on\s+applications\s+of\s+computer\s+vision/iu,
    ],
  },
  {
    abbreviation: "ACCV",
    patterns: [
      /\baccv\b/iu,
      /asian\s+conference\s+on\s+computer\s+vision/iu,
    ],
  },
  {
    abbreviation: "BMVC",
    patterns: [
      /\bbmvc\b/iu,
      /british\s+machine\s+vision\s+conference/iu,
    ],
  },
  {
    abbreviation: "3DV",
    patterns: [
      /\b3dv\b/iu,
      /international\s+conference\s+on\s+3d\s+vision/iu,
    ],
  },
  {
    abbreviation: "NeurIPS",
    patterns: [
      /\bneurips\b/iu,
      /\bnips\b/iu,
      /neural\s+information\s+processing\s+systems/iu,
    ],
  },
  {
    abbreviation: "ICLR",
    patterns: [
      /\biclr\b/iu,
      /international\s+conference\s+on\s+learning\s+representations/iu,
    ],
  },
  {
    abbreviation: "ICML",
    patterns: [
      /\bicml\b/iu,
      /international\s+conference\s+on\s+machine\s+learning/iu,
    ],
  },
  {
    abbreviation: "AAAI",
    patterns: [
      /\baaai\b/iu,
      /aaai\s+conference\s+on\s+artificial\s+intelligence/iu,
    ],
  },
  {
    abbreviation: "IJCAI",
    patterns: [
      /\bijcai\b/iu,
      /international\s+joint\s+conference\s+on\s+artificial\s+intelligence/iu,
    ],
  },
  {
    abbreviation: "ACM MM",
    patterns: [
      /\bacm\s+mm\b/iu,
      /acm\s+(?:international\s+conference\s+on\s+)?multimedia/iu,
    ],
  },
  {
    abbreviation: "KDD",
    patterns: [
      /\bkdd\b/iu,
      /knowledge\s+discovery\s+and\s+data\s+mining/iu,
    ],
  },
  {
    abbreviation: "PACM CGIT",
    patterns: [
      /\bpacm\s+cgit\b/iu,
      /proceedings\s+of\s+the\s+acm\s+on\s+computer\s+graphics\s+and\s+interactive\s+techniques/iu,
    ],
  },
  {
    abbreviation: "ACM TOG",
    patterns: [
      /\bacm\s+tog\b/iu,
      /(?:acm\s+)?transactions\s+on\s+graphics/iu,
    ],
  },
  {
    abbreviation: "IEEE TPAMI",
    patterns: [
      /\b(?:ieee\s+)?tpami\b/iu,
      /transactions\s+on\s+pattern\s+analysis\s+and\s+machine\s+intelligence/iu,
    ],
  },
  {
    abbreviation: "IJCV",
    patterns: [
      /\bijcv\b/iu,
      /international\s+journal\s+of\s+computer\s+vision/iu,
    ],
  },
  {
    abbreviation: "IEEE TVCG",
    patterns: [
      /\b(?:ieee\s+)?tvcg\b/iu,
      /transactions\s+on\s+visualization\s+and\s+computer\s+graphics/iu,
    ],
  },
  {
    abbreviation: "IEEE TIP",
    patterns: [
      /\b(?:ieee\s+)?tip\b/iu,
      /transactions\s+on\s+image\s+processing/iu,
    ],
  },
  {
    abbreviation: "CGF",
    patterns: [/\bcgf\b/iu, /computer\s+graphics\s+forum/iu],
  },
  {
    abbreviation: "JFM",
    patterns: [/\bjfm\b/iu, /journal\s+of\s+fluid\s+mechanics/iu],
  },
  {
    abbreviation: "arXiv",
    patterns: [/\barxiv\b/iu],
  },
]);

const GENERIC_SOURCES = Object.freeze([
  /^association\s+for\s+computing\s+machinery$/iu,
  /^acm$/iu,
  /^ieee$/iu,
  /^elsevier$/iu,
  /^springer(?:\s+nature)?$/iu,
  /^doi\b/iu,
  /^(?:会议论文|期刊论文|预印本)$/u,
]);

const PRESENTATION_QUALIFIERS = Object.freeze([
  { label: "Oral", patterns: [/\boral\b/iu, /口头报告/u] },
  { label: "Spotlight", patterns: [/\bspotlight\b/iu, /聚光灯/u] },
  { label: "Poster", patterns: [/\bposter\b/iu, /海报/u] },
  { label: "Workshop", patterns: [/\bworkshops?\b/iu, /研讨会/u] },
  { label: "Highlight", patterns: [/\bhighlight\b/iu] },
  { label: "Best Paper", patterns: [/\bbest\s+paper\b/iu, /最佳论文/u] },
]);

function cleanText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[–—]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim();
}

function publicationYear(...values) {
  for (const value of values) {
    const match = cleanText(value).match(/(?:19|20)\d{2}/u);
    if (match) return match[0];
  }
  return "";
}

function matchesRule(rule, value) {
  return rule.patterns.some((pattern) => pattern.test(value));
}

function venueRuleFor(value) {
  return VENUE_RULES.find((rule) => matchesRule(rule, value)) ?? null;
}

function qualifierLabels(value) {
  return PRESENTATION_QUALIFIERS.filter((qualifier) =>
    qualifier.patterns.some((pattern) => pattern.test(value)),
  ).map((qualifier) => qualifier.label);
}

function inferFromGenericSource(source, title) {
  if (!GENERIC_SOURCES.some((pattern) => pattern.test(source))) return null;
  return venueRuleFor(title);
}

export function normalizePublicationSource(
  rawSource,
  publicationDate = "",
  { title = "" } = {},
) {
  const source = cleanText(rawSource);
  const normalizedTitle = cleanText(title);
  if (!source) return "";

  const isTog = matchesRule(
    VENUE_RULES.find((rule) => rule.abbreviation === "ACM TOG"),
    source,
  );
  const siggraphAsia = /\bsiggraph\s+asia\b/iu.test(source);
  const siggraph = /\bsiggraph\b/iu.test(source);
  let rule = isTog
    ? VENUE_RULES.find((candidate) => candidate.abbreviation === "ACM TOG")
    : venueRuleFor(source);
  const genericSource = GENERIC_SOURCES.some((pattern) => pattern.test(source));
  if (!rule) rule = inferFromGenericSource(source, normalizedTitle);
  if (!rule && genericSource) return "";
  if (!rule) return source.replace(/\s*\((?:arxiv\s*(?:版|version)?)\)\s*/giu, " ").trim();

  const year = publicationYear(
    source,
    publicationDate,
    genericSource ? normalizedTitle : "",
  );
  const qualifiers = [];
  if (isTog && siggraphAsia) qualifiers.push("SIGGRAPH Asia");
  else if (isTog && siggraph) qualifiers.push("SIGGRAPH");
  for (const qualifier of qualifierLabels(source)) {
    if (!qualifiers.includes(qualifier)) qualifiers.push(qualifier);
  }

  return [
    rule.abbreviation,
    year,
    qualifiers.length ? `(${qualifiers.join(", ")})` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
