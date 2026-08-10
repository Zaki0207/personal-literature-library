import {
  dedupePaperIdentifiers,
  identifiersFromReference,
  normalizeArxivId,
  normalizeDoi,
  normalizePaperTitle,
  normalizePaperUrl,
} from "./paper-identifiers.mjs";
import { createProxyAwareFetch } from "./ai/providers.mjs";
import { normalizePrimaryInstitution } from "../lib/paper-display.mjs";
import { normalizePublicationSource } from "../lib/publication-source.mjs";

const MAX_INPUT_LENGTH = 4_096;
const MAX_REMOTE_BYTES = 2 * 1_024 * 1_024;
const FETCH_TIMEOUT_MS = 20_000;
const AI_ENRICHMENT_TIMEOUT_MS = 3 * 60_000;

class PaperIntakeError extends Error {
  constructor(message, { statusCode = 400, code = "PAPER_INTAKE_ERROR", details } = {}) {
    super(message);
    this.name = "PaperIntakeError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function validateReference(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new PaperIntakeError("请粘贴 DOI、arXiv 编号或论文链接。", {
      details: { field: "reference" },
    });
  }
  if (value.trim().length > MAX_INPUT_LENGTH) {
    throw new PaperIntakeError("论文链接或标识过长，请检查后重试。", {
      details: { field: "reference" },
    });
  }
  return value.trim();
}

function assertSafeRemoteUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new PaperIntakeError("论文链接格式无效。", {
      details: { field: "reference" },
    });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new PaperIntakeError("论文链接必须使用 http:// 或 https://。", {
      details: { field: "reference" },
    });
  }
  if (url.username || url.password) {
    throw new PaperIntakeError("论文链接不能包含用户名或密码。", {
      details: { field: "reference" },
    });
  }
  const host = url.hostname.toLocaleLowerCase("en");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    /^10\./u.test(host) ||
    /^192\.168\./u.test(host) ||
    /^169\.254\./u.test(host) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./u.test(host)
  ) {
    throw new PaperIntakeError("不能读取本机或局域网地址。", {
      details: { field: "reference" },
    });
  }
  return url;
}

async function fetchRemote(
  fetchImpl,
  value,
  accept,
  { headers = {}, detectPdf = false } = {},
) {
  let url = assertSafeRemoteUrl(value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    for (let redirect = 0; redirect <= 4; redirect += 1) {
      const response = await fetchImpl(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: accept,
          "User-Agent": "PersonalLiteratureLibrary/1.0 (local desktop app)",
          ...headers,
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location || redirect === 4) {
          throw new PaperIntakeError("论文页面重定向次数过多。", {
            statusCode: 502,
            code: "METADATA_UNAVAILABLE",
          });
        }
        url = assertSafeRemoteUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok) {
        throw new PaperIntakeError(`论文元数据服务返回了 ${response.status}。`, {
          statusCode: 502,
          code: "METADATA_UNAVAILABLE",
        });
      }
      const resolvedUrl = response.url || url.href;
      const contentType = String(
        response.headers.get("content-type") ?? "",
      )
        .split(";", 1)[0]
        .trim()
        .toLocaleLowerCase("en");
      const isPdf =
        contentType === "application/pdf" ||
        /\.pdf$/iu.test(new URL(resolvedUrl).pathname);
      if (detectPdf && isPdf) {
        try {
          await response.body?.cancel();
        } catch {
          // The response body may already be closed by a test or fetch adapter.
        }
        return {
          text: "",
          url: resolvedUrl,
          contentType,
          isPdf: true,
        };
      }
      const length = Number(response.headers.get("content-length") ?? 0);
      if (length > MAX_REMOTE_BYTES) {
        throw new PaperIntakeError("论文页面过大，无法安全读取元数据。", {
          statusCode: 413,
          code: "METADATA_TOO_LARGE",
        });
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_REMOTE_BYTES) {
        throw new PaperIntakeError("论文页面过大，无法安全读取元数据。", {
          statusCode: 413,
          code: "METADATA_TOO_LARGE",
        });
      }
      return {
        text: new TextDecoder().decode(bytes),
        url: resolvedUrl,
        contentType,
        isPdf: false,
      };
    }
  } catch (error) {
    if (error instanceof PaperIntakeError) throw error;
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new PaperIntakeError("读取论文元数据超时，请稍后重试。", {
        statusCode: 504,
        code: "METADATA_TIMEOUT",
      });
    }
    throw new PaperIntakeError("无法读取论文元数据，请检查链接或网络。", {
      statusCode: 502,
      code: "METADATA_UNAVAILABLE",
    });
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(value = "") {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"',
  };
  return value
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/giu, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&(amp|apos|gt|lt|quot);/giu, (_, name) => named[name.toLocaleLowerCase("en")])
    .replace(/\s+/gu, " ")
    .trim();
}

function stripMarkup(value = "") {
  return decodeEntities(value.replace(/<[^>]*>/gu, " "));
}

function firstDatePart(...candidates) {
  for (const parts of candidates) {
    if (!Array.isArray(parts) || !Array.isArray(parts[0])) continue;
    const [year, month, day] = parts[0];
    if (!year) continue;
    return [year, month, day]
      .filter((part) => part !== undefined)
      .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, "0")))
      .join("-");
  }
  return "";
}

function authorNames(authors = []) {
  return authors
    .map((author) => [author.given, author.family].filter(Boolean).join(" ").trim() || author.name)
    .filter(Boolean)
    .join("; ");
}

function authorInstitutions(authors = []) {
  return [...new Set(authors.flatMap((author) => author.affiliation ?? []).map((item) => item?.name?.trim()).filter(Boolean))].join("; ");
}

function normalizedTokens(value) {
  return new Set(
    normalizePaperTitle(value)
      .split(" ")
      .filter((token) => token.length > 1),
  );
}

function tokenSimilarity(left, right) {
  const leftTokens = normalizedTokens(left);
  const rightTokens = normalizedTokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let common = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) common += 1;
  }
  return (2 * common) / (leftTokens.size + rightTokens.size);
}

function tokenCoverage(query, text) {
  const queryTokens = normalizedTokens(query);
  const textTokens = normalizedTokens(text);
  if (!queryTokens.size || !textTokens.size) return 0;
  let common = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) common += 1;
  }
  return common / queryTokens.size;
}

function authorSurnames(value) {
  return new Set(
    String(value ?? "")
      .split(/[;；、]/u)
      .map((name) =>
        normalizePaperTitle(name)
          .split(" ")
          .filter(Boolean)
          .at(-1),
      )
      .filter(Boolean),
  );
}

function authorSimilarity(left, right) {
  const leftNames = authorSurnames(left);
  const rightNames = authorSurnames(right);
  if (!leftNames.size || !rightNames.size) return 0;
  let common = 0;
  for (const name of leftNames) {
    if (rightNames.has(name)) common += 1;
  }
  return common / Math.min(leftNames.size, rightNames.size);
}

function publicationYear(value) {
  const match = String(value ?? "").match(/(?:19|20)\d{2}/u);
  return match ? Number(match[0]) : null;
}

function crossrefDirectPdfUrl(message) {
  const links = Array.isArray(message.link) ? message.link : [];
  for (const link of links) {
    if (
      String(link?.["intended-application"] ?? "").toLocaleLowerCase("en") ===
      "similarity-checking"
    ) {
      continue;
    }
    const normalized = normalizePaperUrl(link?.URL ?? "");
    if (!normalized) continue;
    const url = new URL(normalized);
    if (
      /pdf/iu.test(link?.["content-type"] ?? "") ||
      /\/(?:e?pdf)(?:\/|$)/iu.test(url.pathname) ||
      /\.pdf$/iu.test(url.pathname)
    ) {
      return normalized;
    }
  }
  return "";
}

function ieeeDocumentNumber(message) {
  const links = Array.isArray(message.link) ? message.link : [];
  const candidates = [
    message.resource?.primary?.URL,
    ...links.map((link) => link?.URL),
  ];
  for (const candidate of candidates) {
    const normalized = normalizePaperUrl(candidate ?? "");
    if (!normalized) continue;
    const url = new URL(normalized);
    const host = url.hostname.replace(/^www\./u, "").toLocaleLowerCase("en");
    if (
      host !== "ieeexplore.ieee.org" &&
      host !== "xplorestaging.ieee.org"
    ) {
      continue;
    }
    const documentMatch = url.pathname.match(/\/document\/(\d+)(?:\/|$)/u);
    const pdfMatch = url.pathname.match(/\/(\d+)\.pdf$/iu);
    const articleNumber =
      documentMatch?.[1] ||
      url.searchParams.get("arnumber")?.match(/^\d+$/u)?.[0] ||
      pdfMatch?.[1] ||
      "";
    if (articleNumber) return articleNumber;
  }
  return "";
}

function ieeePublisherPdfUrl(message) {
  const articleNumber = ieeeDocumentNumber(message);
  return articleNumber
    ? `https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=${articleNumber}`
    : "";
}

function crossrefMetadata(message, doi) {
  const pdfUrl = crossrefDirectPdfUrl(message);
  const source =
    message["container-title"]?.[0] ||
    message.event?.name ||
    message.publisher ||
    "";
  return {
    title: stripMarkup(message.title?.[0] ?? ""),
    authors: authorNames(message.author),
    institution: authorInstitutions(message.author),
    source: stripMarkup(source),
    date: firstDatePart(
      message.published?.["date-parts"],
      message["published-print"]?.["date-parts"],
      message["published-online"]?.["date-parts"],
      message.issued?.["date-parts"],
    ),
    abstract: stripMarkup(message.abstract ?? ""),
    originalUrl: `https://doi.org/${doi}`,
    pdfUrl: normalizePaperUrl(pdfUrl) ?? "",
    publisherPdfUrl: ieeePublisherPdfUrl(message),
    identifiers: dedupePaperIdentifiers([
      { kind: "doi", value: doi },
      { kind: "url", value: `https://doi.org/${doi}` },
      ...(message.URL ? [{ kind: "url", value: message.URL }] : []),
    ]),
    metadataSource: "Crossref",
    publicationStatus: "published",
    publicationMatch: { method: "doi", confidence: "high" },
  };
}

async function fetchCrossref(fetchImpl, doi) {
  const endpoint = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
  const { text } = await fetchRemote(fetchImpl, endpoint, "application/json");
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new PaperIntakeError("Crossref 返回了无法识别的元数据。", {
      statusCode: 502,
      code: "INVALID_METADATA",
    });
  }
  if (!payload?.message?.title?.[0]) {
    throw new PaperIntakeError("没有找到该 DOI 对应的论文元数据。", {
      statusCode: 404,
      code: "METADATA_NOT_FOUND",
    });
  }
  return crossrefMetadata(payload.message, doi);
}

async function fetchOpenAccessPdf(fetchImpl, doi) {
  const workId = encodeURIComponent(`https://doi.org/${doi}`);
  const endpoint = `https://api.openalex.org/works/${workId}`;
  try {
    const { text } = await fetchRemote(fetchImpl, endpoint, "application/json");
    const payload = JSON.parse(text);
    if (normalizeDoi(payload?.doi ?? "") !== doi) return "";
    const locations = [
      payload.best_oa_location,
      ...(Array.isArray(payload.locations) ? payload.locations : []),
      payload.primary_location,
    ];
    for (const location of locations) {
      if (!location || location.is_oa === false) continue;
      const pdfUrl = normalizePaperUrl(location.pdf_url ?? "");
      if (pdfUrl) return pdfUrl;
    }
  } catch {
    // Open-access discovery is best-effort; the publisher fallback remains usable.
  }
  return "";
}

async function searchCrossrefPublishedVersion(fetchImpl, metadata) {
  const endpoint = new URL("https://api.crossref.org/works");
  endpoint.searchParams.set("query.bibliographic", metadata.title);
  const firstAuthor = String(metadata.authors ?? "").split(/[;；、]/u)[0]?.trim();
  if (firstAuthor) endpoint.searchParams.set("query.author", firstAuthor);
  endpoint.searchParams.set("rows", "5");

  let payload;
  try {
    const { text } = await fetchRemote(fetchImpl, endpoint.href, "application/json");
    payload = JSON.parse(text);
  } catch {
    return null;
  }

  const preprintYear = publicationYear(metadata.date);
  const candidates = Array.isArray(payload?.message?.items)
    ? payload.message.items
    : [];
  let best = null;
  for (const item of candidates) {
    const doi = normalizeDoi(item?.DOI ?? "");
    const title = stripMarkup(item?.title?.[0] ?? "");
    if (!doi || !title) continue;
    const titleScore =
      normalizePaperTitle(title) === normalizePaperTitle(metadata.title)
        ? 1
        : tokenSimilarity(title, metadata.title);
    const candidateAuthors = authorNames(item.author);
    const authorScore = authorSimilarity(candidateAuthors, metadata.authors);
    const candidateDate = firstDatePart(
      item.published?.["date-parts"],
      item["published-print"]?.["date-parts"],
      item["published-online"]?.["date-parts"],
      item.issued?.["date-parts"],
    );
    const candidateYear = publicationYear(candidateDate);
    const plausibleYear =
      !preprintYear ||
      !candidateYear ||
      (candidateYear >= preprintYear - 2 && candidateYear <= preprintYear + 6);
    const accepted =
      plausibleYear &&
      titleScore >= 0.86 &&
      (authorScore >= 0.5 || (titleScore === 1 && authorScore > 0));
    if (!accepted) continue;
    const score = titleScore * 0.82 + authorScore * 0.18;
    if (!best || score > best.score) {
      best = { score, metadata: crossrefMetadata(item, doi) };
    }
  }
  if (!best) return null;
  return {
    ...best.metadata,
    publicationMatch: { method: "title-author", confidence: "high" },
  };
}

function xmlTag(value, name) {
  return decodeEntities(value.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "iu"))?.[1] ?? "");
}

async function fetchArxiv(fetchImpl, arxivId) {
  const endpoint = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`;
  const { text } = await fetchRemote(fetchImpl, endpoint, "application/atom+xml, application/xml;q=0.9");
  const entry = text.match(/<entry>([\s\S]*?)<\/entry>/iu)?.[1] ?? "";
  const title = xmlTag(entry, "title");
  if (!entry || !title) {
    throw new PaperIntakeError("没有找到该 arXiv 编号对应的论文。", {
      statusCode: 404,
      code: "METADATA_NOT_FOUND",
    });
  }
  const authorBlocks = [...entry.matchAll(/<author>([\s\S]*?)<\/author>/giu)];
  const authors = authorBlocks.map((match) => xmlTag(match[1], "name")).filter(Boolean).join("; ");
  const published = xmlTag(entry, "published");
  const doi = normalizeDoi(xmlTag(entry, "arxiv:doi"));
  const journalReference = xmlTag(entry, "arxiv:journal_ref");
  const primaryCategory = entry.match(/<arxiv:primary_category[^>]*term=["']([^"']+)/iu)?.[1] ?? "";
  const pdfHref = entry.match(/<link[^>]*title=["']pdf["'][^>]*href=["']([^"']+)/iu)?.[1] ?? `https://arxiv.org/pdf/${arxivId}`;
  const metadata = {
    title,
    authors,
    institution: "",
    source: journalReference || (primaryCategory ? `arXiv · ${primaryCategory}` : "arXiv"),
    date: published.slice(0, 10),
    abstract: xmlTag(entry, "summary"),
    originalUrl: `https://arxiv.org/abs/${arxivId}`,
    pdfUrl: normalizePaperUrl(pdfHref) ?? `https://arxiv.org/pdf/${arxivId}`,
    identifiers: dedupePaperIdentifiers([
      { kind: "arxiv", value: arxivId },
      { kind: "url", value: `https://arxiv.org/abs/${arxivId}` },
      ...(doi ? [{ kind: "doi", value: doi }] : []),
    ]),
    metadataSource: "arXiv",
    publicationStatus: "preprint",
    publicationMatch: { method: "none", confidence: "none" },
    preprint: {
      arxivId,
      url: `https://arxiv.org/abs/${arxivId}`,
      date: published.slice(0, 10),
    },
  };
  try {
    const publishedMetadata = doi
      ? await fetchCrossref(fetchImpl, doi)
      : await searchCrossrefPublishedVersion(fetchImpl, metadata);
    if (!publishedMetadata) return metadata;
    return mergeMetadata(metadata, publishedMetadata, {
      preferOverlay: true,
      metadataSource: doi
        ? "arXiv + Crossref（DOI）"
        : "arXiv + Crossref（标题与作者匹配）",
    });
  } catch {
    return metadata;
  }
}

function metaValues(html, key) {
  const values = [];
  for (const tag of html.match(/<meta\b[^>]*>/giu) ?? []) {
    const attributes = {};
    for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(["'])(.*?)\2/gu)) {
      attributes[match[1].toLocaleLowerCase("en")] = decodeEntities(match[3]);
    }
    const name = (attributes.name ?? attributes.property ?? "").toLocaleLowerCase("en");
    if (name === key.toLocaleLowerCase("en") && attributes.content) values.push(attributes.content);
  }
  return values;
}

function classText(html, className) {
  const pattern = new RegExp(
    `<([a-z][\\w:-]*)\\b[^>]*\\bclass\\s*=\\s*(["'])[^"']*\\b${className}\\b[^"']*\\2[^>]*>([\\s\\S]*?)<\\/\\1>`,
    "iu",
  );
  return stripMarkup(html.match(pattern)?.[3] ?? "");
}

function htmlLinks(html, baseUrl) {
  const links = [];
  for (const match of html.matchAll(
    /<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/giu,
  )) {
    try {
      const url = normalizePaperUrl(new URL(decodeEntities(match[2]), baseUrl).href);
      if (!url) continue;
      links.push({ url, text: stripMarkup(match[3]) });
    } catch {
      // Ignore malformed links on third-party pages.
    }
  }
  return links;
}

function repositoryUrl(value) {
  const normalized = normalizePaperUrl(value);
  if (!normalized) return null;
  const url = new URL(normalized);
  const host = url.hostname.replace(/^www\./u, "");
  if (!["github.com", "gitlab.com", "bitbucket.org"].includes(host)) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const reserved = new Set([
    "about",
    "collections",
    "customer-stories",
    "enterprise",
    "events",
    "explore",
    "features",
    "marketplace",
    "orgs",
    "pricing",
    "search",
    "settings",
    "sponsors",
    "topics",
  ]);
  if (reserved.has(parts[0].toLocaleLowerCase("en"))) return null;
  return `${url.protocol}//${url.hostname}/${parts[0]}/${parts[1].replace(/\.git$/iu, "")}`;
}

function resourceProvider(value) {
  try {
    const host = new URL(value).hostname.replace(/^www\./u, "");
    if (host === "github.com") return "GitHub";
    if (host === "gitlab.com") return "GitLab";
    if (host === "bitbucket.org") return "Bitbucket";
  } catch {
    return "代码仓库";
  }
  return "代码仓库";
}

function directResourcesFromHtml(html, baseUrl) {
  const links = htmlLinks(html, baseUrl);
  const metaCode = [
    ...metaValues(html, "citation_code_url"),
    ...metaValues(html, "code_url"),
  ];
  let codeUrl = null;
  let projectUrl = null;
  for (const candidate of [...metaCode.map((url) => ({ url, text: "code" })), ...links]) {
    const repo = repositoryUrl(candidate.url);
    if (!codeUrl && (repo || /\b(?:code|github|gitlab|repository)\b/iu.test(candidate.text))) {
      codeUrl = repo ?? normalizePaperUrl(candidate.url);
    }
    if (
      !projectUrl &&
      /\b(?:project(?:\s+page)?|project\s+website|homepage|demo)\b/iu.test(
        candidate.text,
      ) &&
      !repo
    ) {
      projectUrl = normalizePaperUrl(candidate.url);
    }
    if (codeUrl && projectUrl) break;
  }
  return {
    ...(codeUrl
      ? {
          codeUrl,
          codeProvider: resourceProvider(codeUrl),
          codeEvidence: "论文页面直接链接",
        }
      : {}),
    ...(projectUrl
      ? {
          projectUrl,
          projectProvider: "项目主页",
          projectEvidence: "论文页面直接链接",
        }
      : {}),
  };
}

function identifierAppearsInText(identifiers, text) {
  const normalizedText = String(text ?? "").toLocaleLowerCase("en");
  return identifiers
    .filter((identifier) => identifier.kind === "doi" || identifier.kind === "arxiv")
    .some((identifier) => normalizedText.includes(identifier.value.toLocaleLowerCase("en")));
}

async function searchGithubRepository(fetchImpl, metadata) {
  const endpoint = new URL("https://api.github.com/search/repositories");
  const queryTitle = metadata.title.replace(/["']/gu, " ").slice(0, 180);
  endpoint.searchParams.set("q", `\"${queryTitle}\" in:name,description,readme`);
  endpoint.searchParams.set("per_page", "5");
  let items;
  try {
    const { text } = await fetchRemote(fetchImpl, endpoint.href, "application/vnd.github+json", {
      headers: { "X-GitHub-Api-Version": "2022-11-28" },
    });
    const payload = JSON.parse(text);
    items = Array.isArray(payload?.items) ? payload.items : [];
  } catch {
    return null;
  }

  for (const item of items.slice(0, 3)) {
    if (!item?.full_name || !item?.html_url || item.archived || item.fork) continue;
    let readme = "";
    try {
      const endpoint = `https://api.github.com/repos/${item.full_name}/readme`;
      readme = (
        await fetchRemote(fetchImpl, endpoint, "application/vnd.github.raw+json", {
          headers: { "X-GitHub-Api-Version": "2022-11-28" },
        })
      ).text;
    } catch {
      readme = "";
    }
    const evidenceText = `${item.name ?? ""} ${item.description ?? ""} ${readme.slice(0, 80_000)}`;
    const identifierMatch = identifierAppearsInText(
      metadata.identifiers ?? [],
      evidenceText,
    );
    const titleScore = tokenCoverage(metadata.title, evidenceText);
    if (!identifierMatch && titleScore < 0.72) continue;
    const codeUrl = repositoryUrl(item.html_url);
    if (!codeUrl) continue;
    const homepage = normalizePaperUrl(item.homepage ?? "");
    return {
      codeUrl,
      codeProvider: "GitHub",
      codeEvidence: identifierMatch
        ? "GitHub README 引用了论文标识"
        : "GitHub 仓库标题与论文高度匹配",
      ...(homepage && !repositoryUrl(homepage)
        ? {
            projectUrl: homepage,
            projectProvider: "项目主页",
            projectEvidence: "GitHub 仓库主页字段",
          }
        : {}),
    };
  }
  return null;
}

async function discoverPaperResources(fetchImpl, metadata) {
  const pages = [
    metadata.preprint?.url,
    metadata.pdfLandingPageUrl,
    metadata.resourcePageUrl,
    metadata.originalUrl,
  ]
    .map(normalizePaperUrl)
    .filter(Boolean);
  let resources = metadata.pdfLandingPageUrl
    ? {
        projectUrl: metadata.pdfLandingPageUrl,
        projectProvider: "项目主页",
        projectEvidence: "由 PDF 直链定位到对应论文页面",
      }
    : {};
  for (const pageUrl of [...new Set(pages)]) {
    try {
      const { text, url } = await fetchRemote(
        fetchImpl,
        pageUrl,
        "text/html, application/xhtml+xml;q=0.9",
      );
      const direct = directResourcesFromHtml(text, url);
      resources = {
        ...direct,
        ...resources,
      };
      if (resources.codeUrl && resources.projectUrl) break;
    } catch {
      // Resource discovery is best-effort and must not block paper intake.
    }
  }

  if (!resources.codeUrl) {
    const github = await searchGithubRepository(fetchImpl, metadata);
    if (github) resources = { ...github, ...resources };
  }
  return resources;
}

function mergeMetadata(base, overlay, { preferOverlay = false, metadataSource } = {}) {
  const pick = (field) =>
    preferOverlay ? overlay[field] || base[field] || "" : base[field] || overlay[field] || "";
  return {
    title: pick("title"),
    authors: pick("authors"),
    institution: pick("institution"),
    source: pick("source"),
    date: pick("date"),
    abstract: pick("abstract"),
    originalUrl: preferOverlay
      ? overlay.originalUrl || base.originalUrl || ""
      : base.originalUrl || overlay.originalUrl || "",
    pdfUrl: base.pdfUrl || overlay.pdfUrl || "",
    identifiers: dedupePaperIdentifiers([...(base.identifiers ?? []), ...(overlay.identifiers ?? [])]),
    metadataSource: metadataSource ?? [base.metadataSource, overlay.metadataSource].filter(Boolean).join(" + "),
    publicationStatus:
      overlay.publicationStatus || base.publicationStatus || "unknown",
    publicationMatch:
      overlay.publicationMatch || base.publicationMatch || {
        method: "none",
        confidence: "none",
      },
    resourcePageUrl: base.resourcePageUrl || overlay.resourcePageUrl || "",
    pdfLandingPageUrl:
      base.pdfLandingPageUrl || overlay.pdfLandingPageUrl || "",
    publisherPdfUrl:
      base.publisherPdfUrl || overlay.publisherPdfUrl || "",
    ...(base.preprint ? { preprint: base.preprint } : {}),
  };
}

async function metadataFromWebPage(
  fetchImpl,
  { text, resolvedUrl, pdfUrl = "", pdfLandingPageUrl = "" },
) {
  const linkedDoi = htmlLinks(text, resolvedUrl)
    .map((link) => normalizeDoi(link.url))
    .find(Boolean);
  const bibtexDoi = text.match(
    /\bdoi\s*=\s*[{"']\s*(10\.\d{4,9}\/[^\s}"']+)/iu,
  )?.[1];
  const doi = normalizeDoi(
    metaValues(text, "citation_doi")[0] ??
      metaValues(text, "dc.identifier")[0] ??
      linkedDoi ??
      bibtexDoi ??
      "",
  );
  const authors = metaValues(text, "citation_author");
  const institutions = metaValues(text, "citation_author_institution");
  const source =
    metaValues(text, "citation_conference_title")[0] ||
    metaValues(text, "citation_journal_title")[0] ||
    metaValues(text, "citation_publisher")[0] ||
    classText(text, "venue") ||
    "";
  const pageMetadata = {
    title:
      metaValues(text, "citation_title")[0] ||
      metaValues(text, "og:title")[0] ||
      stripMarkup(text.match(/<title[^>]*>([\s\S]*?)<\/title>/iu)?.[1] ?? ""),
    authors: authors.join("; "),
    institution: [...new Set(institutions)].join("; "),
    source,
    date:
      metaValues(text, "citation_publication_date")[0] ||
      metaValues(text, "citation_date")[0] ||
      "",
    abstract:
      metaValues(text, "citation_abstract")[0] ||
      metaValues(text, "description")[0] ||
      metaValues(text, "og:description")[0] ||
      classText(text, "abstract").replace(/^abstract\s+/iu, "") ||
      "",
    originalUrl: normalizePaperUrl(resolvedUrl) ?? resolvedUrl,
    pdfUrl:
      normalizePaperUrl(pdfUrl) ??
      normalizePaperUrl(metaValues(text, "citation_pdf_url")[0] ?? "") ??
      "",
    identifiers: dedupePaperIdentifiers([
      ...identifiersFromReference(pdfUrl || resolvedUrl),
      { kind: "url", value: resolvedUrl },
      ...(doi ? [{ kind: "doi", value: doi }] : []),
    ]),
    metadataSource: new URL(resolvedUrl).hostname.replace(/^www\./u, ""),
    publicationStatus: doi ? "published" : "unknown",
    publicationMatch: {
      method: doi ? "page-doi" : "none",
      confidence: doi ? "high" : "none",
    },
    resourcePageUrl: normalizePaperUrl(resolvedUrl) ?? "",
    ...(pdfLandingPageUrl
      ? { pdfLandingPageUrl: normalizePaperUrl(pdfLandingPageUrl) ?? "" }
      : {}),
  };
  if (!pageMetadata.title) {
    throw new PaperIntakeError("该页面没有可识别的论文标题，请改用 DOI 或 arXiv 链接。", {
      statusCode: 422,
      code: "METADATA_INCOMPLETE",
    });
  }
  if (!doi) return pageMetadata;
  try {
    const crossref = await fetchCrossref(fetchImpl, doi);
    return mergeMetadata(pageMetadata, crossref, {
      preferOverlay: true,
      metadataSource: `${pageMetadata.metadataSource} + Crossref`,
    });
  } catch {
    return pageMetadata;
  }
}

function pdfLandingPageCandidates(pdfUrl) {
  const url = new URL(pdfUrl);
  const pathname = url.pathname;
  const filename = pathname.split("/").filter(Boolean).at(-1) ?? "";
  const stem = filename.replace(/\.pdf$/iu, "");
  const directory = new URL(".", url);
  const candidates = [directory.href];

  if (stem) {
    candidates.push(new URL(stem, directory).href);
    candidates.push(new URL(`${stem}.html`, directory).href);
  }
  if (/\/(?:pdf|papers?|downloads?)\/$/iu.test(directory.pathname)) {
    candidates.push(new URL("..", directory).href);
  }
  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = normalizePaperUrl(candidate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
}

async function fetchPdfLandingPage(fetchImpl, pdfUrl) {
  for (const candidate of pdfLandingPageCandidates(pdfUrl)) {
    try {
      const page = await fetchRemote(
        fetchImpl,
        candidate,
        "text/html, application/xhtml+xml;q=0.9",
        { detectPdf: true },
      );
      if (page.isPdf) continue;
      return await metadataFromWebPage(fetchImpl, {
        text: page.text,
        resolvedUrl: page.url,
        pdfUrl,
        pdfLandingPageUrl: page.url,
      });
    } catch (error) {
      if (
        error instanceof PaperIntakeError &&
        !["METADATA_INCOMPLETE", "METADATA_UNAVAILABLE"].includes(error.code)
      ) {
        throw error;
      }
    }
  }
  throw new PaperIntakeError(
    "该链接是 PDF，但没有找到可识别的论文页面。请改用 DOI、arXiv 或论文项目页链接。",
    {
      statusCode: 422,
      code: "PDF_METADATA_INCOMPLETE",
      details: {
        action: "也可以返回上一步，改为粘贴论文标题页或 DOI。",
      },
    },
  );
}

async function fetchWebPage(fetchImpl, inputUrl) {
  const page = await fetchRemote(
    fetchImpl,
    inputUrl,
    "text/html, application/xhtml+xml;q=0.9, application/pdf;q=0.5",
    { detectPdf: true },
  );
  if (page.isPdf) return fetchPdfLandingPage(fetchImpl, page.url);
  return metadataFromWebPage(fetchImpl, {
    text: page.text,
    resolvedUrl: page.url,
  });
}

function referenceKind(reference) {
  const doi = normalizeDoi(reference);
  const arxivId = normalizeArxivId(reference);
  const url = normalizePaperUrl(reference);
  if (
    doi &&
    (/^(?:doi:\s*)?10\.\d{4,9}\//iu.test(reference) ||
      /doi\.org\//iu.test(reference) ||
      (url && normalizeDoi(new URL(url).pathname) === doi))
  ) {
    const pdfUrl =
      url &&
      (/\/(?:e?pdf)(?:\/|$)/iu.test(new URL(url).pathname) ||
        /\.pdf$/iu.test(new URL(url).pathname))
        ? url
        : "";
    return {
      kind: "doi",
      value: doi,
      ...(url ? { sourceUrl: url } : {}),
      ...(pdfUrl ? { pdfUrl } : {}),
    };
  }
  if (/^(?:arxiv:\s*)?(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z-]+)?\/\d{7})(?:v\d+)?$/iu.test(reference) || /arxiv\.org\//iu.test(reference)) {
    return { kind: "arxiv", value: arxivId };
  }
  if (url) return { kind: "url", value: url };
  if (doi) return { kind: "doi", value: doi };
  if (arxivId) return { kind: "arxiv", value: arxivId };
  throw new PaperIntakeError("无法识别该内容，请粘贴 DOI、arXiv 编号或完整论文链接。", {
    details: { field: "reference" },
  });
}

async function resolveMetadata(fetchImpl, reference) {
  const parsed = referenceKind(reference);
  if (parsed.kind === "doi") {
    const metadata = await fetchCrossref(fetchImpl, parsed.value);
    const openAccessPdfUrl =
      parsed.pdfUrl || metadata.pdfUrl
        ? ""
        : await fetchOpenAccessPdf(fetchImpl, parsed.value);
    return {
      ...metadata,
      pdfUrl:
        parsed.pdfUrl ||
        metadata.pdfUrl ||
        openAccessPdfUrl ||
        metadata.publisherPdfUrl ||
        "",
      identifiers: dedupePaperIdentifiers([
        ...(metadata.identifiers ?? []),
        ...(parsed.sourceUrl
          ? [{ kind: "url", value: parsed.sourceUrl }]
          : []),
      ]),
      ...(!parsed.pdfUrl && parsed.sourceUrl
        ? { resourcePageUrl: parsed.sourceUrl }
        : {}),
    };
  }
  if (parsed.kind === "arxiv") return fetchArxiv(fetchImpl, parsed.value);
  return fetchWebPage(fetchImpl, parsed.value);
}

function categoryPaths(categories) {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const pathFor = (category) => {
    const path = [category.name];
    let parent = category.parentId ? byId.get(category.parentId) : null;
    const seen = new Set([category.id]);
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      path.unshift(parent.name);
      parent = parent.parentId ? byId.get(parent.parentId) : null;
    }
    return path.join(" › ");
  };
  return categories.map((category) => ({ id: category.id, path: pathFor(category) }));
}

function aiPrompt(metadata, categories) {
  return `你是个人论文知识库的录入助手。根据下方权威元数据，只返回一个 JSON 对象，不要使用 Markdown，不要解释，也不要增加字段。

必须严格使用以下结构：
{"zhTitle":"","institution":"","source":"","aiSummary":"","categoryIds":[]}

要求：
1. zhTitle：忠实、自然的简体中文论文标题。
2. institution：只能整理权威元数据中的 institution，不得根据作者、标题或常识猜测。只保留第一作者的首个顶层机构，使用简洁的通行名称；删除 Department、School、Lab、Research Center、院系、实验室、地址和括号内说明，也不要列出其他作者的机构。例如输入“Tsinghua University, Beijing National Research Center..., Department of Computer Science...; Hong Kong University...”时只返回“Tsinghua University”。无法确认时返回空字符串。
3. source：严格整理为“会议或期刊通行简称 年份 (附加属性)”，例如“CVPR 2025 (Oral)”或“ICCV 2023”。只允许使用英文半角括号；没有附加属性时不得添加括号。必须以权威元数据中的 source、date 和 publicationStatus 为准，不得猜测会议、期刊、年份或 Oral 等属性。已匹配正式发表版本时不得写 arXiv；无法确认时返回权威元数据中的 source 原值或空字符串。
4. aiSummary：100 到 220 个简体中文字符，说明研究问题、方法和主要贡献；优先依据正式发表版本和摘要，信息不足时明确保守表达，禁止虚构实验结论。
5. categoryIds：只能从候选分类 ID 中选择 0 到 3 个最具体、最匹配的分类；不确定时返回空数组。

权威元数据：
${JSON.stringify({
    title: metadata.title,
    authors: metadata.authors,
    institution: metadata.institution,
    source: metadata.source,
    date: metadata.date,
    publicationStatus: metadata.publicationStatus,
    preprint: metadata.preprint ?? null,
    codeUrl: metadata.codeUrl ?? "",
    projectUrl: metadata.projectUrl ?? "",
    abstract: metadata.abstract.slice(0, 12_000),
  })}

候选分类：
${JSON.stringify(categories)}`;
}

function jsonObjectFromText(text) {
  if (typeof text !== "string") return null;
  const cleaned = text.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function validateAiFields(text, allowedCategoryIds, metadata) {
  const value = jsonObjectFromText(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PaperIntakeError("AI 返回的论文信息无法解析，请重试或切换模型。", {
      statusCode: 502,
      code: "INVALID_AI_RESULT",
    });
  }
  const zhTitle = typeof value.zhTitle === "string" ? value.zhTitle.trim().slice(0, 2_000) : "";
  const metadataInstitution = normalizePrimaryInstitution(metadata.institution);
  const generatedInstitution =
    typeof value.institution === "string"
      ? normalizePrimaryInstitution(value.institution.slice(0, 2_000))
      : "";
  const normalizedEvidence = normalizePaperTitle(metadata.institution);
  const normalizedGenerated = normalizePaperTitle(generatedInstitution);
  const institution =
    generatedInstitution &&
    (generatedInstitution === metadataInstitution ||
      (normalizedGenerated && normalizedEvidence.includes(normalizedGenerated)))
      ? generatedInstitution
      : metadataInstitution;
  const generatedSource =
    typeof value.source === "string"
      ? normalizePublicationSource(value.source, metadata.date, {
          title: metadata.title,
        })
      : "";
  const source =
    generatedSource === metadata.source ? generatedSource : metadata.source;
  const aiSummary = typeof value.aiSummary === "string" ? value.aiSummary.trim().slice(0, 4_000) : "";
  const categoryIds = Array.isArray(value.categoryIds)
    ? [...new Set(value.categoryIds.filter((id) => typeof id === "string" && allowedCategoryIds.has(id)))].slice(0, 3)
    : [];
  if (!zhTitle && !institution && !aiSummary && !categoryIds.length) {
    throw new PaperIntakeError("AI 没有返回可用的论文补全信息，请重试或切换模型。", {
      statusCode: 502,
      code: "INVALID_AI_RESULT",
    });
  }
  return { zhTitle, institution, source, aiSummary, categoryIds };
}

function publicAiError(error) {
  return {
    code: error?.code ?? "AI_ENRICHMENT_FAILED",
    message: error?.message || "AI 补全失败。",
    ...(error?.details?.action ? { action: error.details.action } : {}),
  };
}

export function createPaperIntakeService({
  repository,
  aiService,
  fetchImpl = createProxyAwareFetch(),
} = {}) {
  if (!repository || !aiService || typeof fetchImpl !== "function") {
    throw new TypeError("Paper Intake 需要 repository、AI Service 和 fetch。 ");
  }
  return {
    async analyze(input = {}) {
      const reference = validateReference(input.reference);
      const initialIdentifiers = identifiersFromReference(reference);
      const initialDuplicates = repository.findPaperDuplicates({ identifiers: initialIdentifiers });
      if (initialDuplicates.length) {
        return { status: "duplicate", reference, duplicates: initialDuplicates };
      }

      const resolvedMetadata = await resolveMetadata(fetchImpl, reference);
      const metadata = {
        ...resolvedMetadata,
        source: normalizePublicationSource(
          resolvedMetadata.source,
          resolvedMetadata.date,
          { title: resolvedMetadata.title },
        ),
      };
      const identifiers = dedupePaperIdentifiers([
        ...initialIdentifiers,
        ...(metadata.identifiers ?? []),
      ]);
      const duplicates = repository.findPaperDuplicates({
        identifiers,
        title: metadata.title,
      });
      if (duplicates.length) {
        return { status: "duplicate", reference, metadata, duplicates };
      }

      const resources = await discoverPaperResources(fetchImpl, metadata);
      const enrichedMetadata = { ...metadata, ...resources };

      const categories = repository.getCategories().categories.filter((category) => !category.deletedAt);
      const candidates = categoryPaths(categories);
      let ai = null;
      let aiError = null;
      try {
        const generated = await aiService.generateText({
          input: aiPrompt(enrichedMetadata, candidates),
          timeoutMs: AI_ENRICHMENT_TIMEOUT_MS,
          ...(input.modelId ? { modelId: input.modelId } : {}),
        });
        ai = {
          ...validateAiFields(
            generated.text,
            new Set(candidates.map((category) => category.id)),
            enrichedMetadata,
          ),
          model: generated.resolvedModel || generated.requestedModel,
        };
      } catch (error) {
        aiError = publicAiError(error);
      }

      return {
        status: "ready",
        reference,
        metadata: {
          title: metadata.title,
          authors: metadata.authors,
          institution: metadata.institution,
          source: ai?.source || metadata.source,
          date: metadata.date,
          originalUrl: metadata.originalUrl,
          pdfUrl: metadata.pdfUrl,
          identifiers,
          metadataSource: metadata.metadataSource,
          publicationStatus: metadata.publicationStatus,
          publicationMatch: metadata.publicationMatch,
          preprint: metadata.preprint ?? null,
          codeUrl: resources.codeUrl ?? "",
          codeProvider: resources.codeProvider ?? "",
          codeEvidence: resources.codeEvidence ?? "",
          projectUrl: resources.projectUrl ?? "",
          projectProvider: resources.projectProvider ?? "",
          projectEvidence: resources.projectEvidence ?? "",
        },
        ai,
        aiError,
        draft: {
          title: metadata.title,
          zhTitle: ai?.zhTitle ?? "",
          authors: metadata.authors,
          institution:
            ai?.institution || normalizePrimaryInstitution(metadata.institution),
          source: ai?.source || metadata.source,
          date: metadata.date,
          aiSummary: ai?.aiSummary ?? "",
          categoryIds: ai?.categoryIds ?? [],
          originalUrl: metadata.originalUrl,
          pdfUrl: metadata.pdfUrl,
          hasPdf: Boolean(metadata.pdfUrl),
          codeUrl: resources.codeUrl ?? "",
          codeProvider: resources.codeProvider ?? "",
          projectUrl: resources.projectUrl ?? "",
          projectProvider: resources.projectProvider ?? "",
          identifiers,
        },
      };
    },
  };
}
