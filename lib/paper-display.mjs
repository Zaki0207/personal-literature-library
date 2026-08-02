function cleanText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
}

export function formatAuthorsForDisplay(value, limit = 3) {
  const text = cleanText(value);
  if (!text) return "";

  const hasRemainingAuthors = /(?:\s+等(?:\s*\d+\s*位)?|\s+et\s+al\.?)$/iu.test(
    text,
  );
  const withoutRemainder = text
    .replace(/(?:\s+等(?:\s*\d+\s*位)?|\s+et\s+al\.?)$/iu, "")
    .trim();
  const authors = withoutRemainder
    .split(/[;；、]+/u)
    .map((author) => author.trim())
    .filter(Boolean);
  if (!authors.length) return "";

  const visible = authors.slice(0, Math.max(1, limit));
  const hasMore = hasRemainingAuthors || authors.length > visible.length;
  return `${visible.join("、")}${hasMore ? " 等" : ""}`;
}

const INSTITUTION_ALIASES = Object.freeze([
  {
    pattern: /\buniversity\s+of\s+california\s*,?\s*berkeley\b/iu,
    label: "UC Berkeley",
  },
  {
    pattern: /\buniversity\s+of\s+california\s*,?\s*los\s+angeles\b/iu,
    label: "UCLA",
  },
  {
    pattern: /\bmassachusetts\s+institute\s+of\s+technology\b/iu,
    label: "MIT",
  },
  {
    pattern: /\bcarnegie\s+mellon\s+university\b/iu,
    label: "Carnegie Mellon University",
  },
  {
    pattern: /\btsinghua\s+university\b/iu,
    label: "Tsinghua University",
  },
  {
    pattern: /\bpeking\s+university\b/iu,
    label: "Peking University",
  },
  {
    pattern: /\bhong\s+kong\s+university\s+of\s+science\s+and\s+technology\b/iu,
    label: "HKUST",
  },
]);

const ORGANIZATION_PATTERN =
  /\b(?:university|institute|college|academy|research\s+center|laborator(?:y|ies)|group|corporation|company)\b/iu;
const PRIMARY_ORGANIZATION_PATTERN =
  /\b(?:university|institute|college|academy|group|corporation|company)\b/iu;
const SUBUNIT_PATTERN =
  /\b(?:department|school|faculty|division|center\s+for|centre\s+for|laboratory\s+of|lab\s+of)\b/iu;

function firstAffiliation(value) {
  return value.split(/[;；、]+/u)[0]?.trim() ?? "";
}

export function normalizePrimaryInstitution(value) {
  const text = cleanText(value);
  if (!text) return "";
  const affiliation = firstAffiliation(text);
  if (!affiliation) return "";

  for (const alias of INSTITUTION_ALIASES) {
    if (alias.pattern.test(affiliation)) return alias.label;
  }

  const parts = affiliation
    .split(/\s*,\s*/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const primaryOrganization = parts.find(
    (part) =>
      PRIMARY_ORGANIZATION_PATTERN.test(part) && !SUBUNIT_PATTERN.test(part),
  );
  if (primaryOrganization) return primaryOrganization;

  const organization = parts.find(
    (part) => ORGANIZATION_PATTERN.test(part) && !SUBUNIT_PATTERN.test(part),
  );
  if (organization) return organization;

  const nonSubunit = parts.find((part) => !SUBUNIT_PATTERN.test(part));
  return nonSubunit || parts[0] || affiliation;
}

export function formatInstitutionForDisplay(value) {
  return normalizePrimaryInstitution(value);
}

export function formatPublicationForDisplay(source, date) {
  const sourceText = cleanText(source);
  const year = cleanText(date).match(/(?:19|20)\d{2}/u)?.[0] ?? "";
  if (!sourceText) return year;
  if (!year || /(?:19|20)\d{2}/u.test(sourceText)) return sourceText;
  return `${sourceText} · ${year}`;
}
