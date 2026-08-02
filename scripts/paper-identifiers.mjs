const DOI_PATTERN = /10\.\d{4,9}\/[\w.()/:+-]+/iu;
const ARXIV_NEW_PATTERN = /^(\d{4}\.\d{4,5})(?:v\d+)?$/iu;
const ARXIV_OLD_PATTERN = /^([a-z-]+(?:\.[a-z-]+)?\/\d{7})(?:v\d+)?$/iu;

function trimIdentifierPunctuation(value) {
  return value.replace(/[\s.,;:!?)}\]>]+$/u, "");
}

export function normalizeDoi(value) {
  if (typeof value !== "string") return null;
  const decoded = decodeURIComponent(value.trim()).replace(
    /^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/iu,
    "",
  );
  const match = trimIdentifierPunctuation(decoded).match(DOI_PATTERN);
  return match ? match[0].toLocaleLowerCase("en") : null;
}

export function normalizeArxivId(value) {
  if (typeof value !== "string") return null;
  const input = value.trim();
  let decoded = input;
  if (/^https?:\/\//iu.test(input)) {
    try {
      const url = new URL(input);
      if (!/^(?:www\.)?arxiv\.org$/iu.test(url.hostname)) return null;
      decoded = url.pathname.replace(/^\/(?:abs|pdf|html)\//iu, "");
    } catch {
      return null;
    }
  }
  decoded = decodeURIComponent(decoded)
    .replace(/^arxiv:\s*/iu, "")
    .replace(/\.pdf$/iu, "");
  decoded = trimIdentifierPunctuation(decoded);
  const match = decoded.match(ARXIV_NEW_PATTERN) ?? decoded.match(ARXIV_OLD_PATTERN);
  return match ? match[1].toLocaleLowerCase("en") : null;
}

export function normalizePaperUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hash = "";
    url.username = "";
    url.password = "";
    url.hostname = url.hostname.toLocaleLowerCase("en").replace(/^www\./u, "");
    for (const name of [...url.searchParams.keys()]) {
      if (/^(?:utm_.+|fbclid|gclid|ref|source)$/iu.test(name)) {
        url.searchParams.delete(name);
      }
    }
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
}

export function normalizePaperTitle(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function normalizePaperIdentifier(identifier) {
  if (!identifier || typeof identifier !== "object") return null;
  const kind = String(identifier.kind ?? "").toLocaleLowerCase("en");
  const rawValue = String(identifier.value ?? "");
  const value =
    kind === "doi"
      ? normalizeDoi(rawValue)
      : kind === "arxiv"
        ? normalizeArxivId(rawValue)
        : kind === "url"
          ? normalizePaperUrl(rawValue)
          : null;
  return value ? { kind, value } : null;
}

export function dedupePaperIdentifiers(identifiers) {
  const result = [];
  const seen = new Set();
  for (const raw of identifiers ?? []) {
    const identifier = normalizePaperIdentifier(raw);
    if (!identifier) continue;
    const key = `${identifier.kind}:${identifier.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(identifier);
  }
  return result;
}

export function identifiersFromReference(value) {
  if (typeof value !== "string") return [];
  const identifiers = [];
  const doi = normalizeDoi(value);
  const arxiv = normalizeArxivId(value);
  const url = normalizePaperUrl(value);
  if (doi) identifiers.push({ kind: "doi", value: doi });
  if (arxiv) identifiers.push({ kind: "arxiv", value: arxiv });
  if (url) identifiers.push({ kind: "url", value: url });
  return dedupePaperIdentifiers(identifiers);
}
