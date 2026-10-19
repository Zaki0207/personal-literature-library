import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createProxyAwareFetch } from "./ai/providers.mjs";
import { assertPublicHostname, isPrivateOrReservedAddress } from "./network-safety.mjs";

const MAX_BYTES = 2 * 1_024 * 1_024;
const MAX_TEXT = 16_000;
const MAX_LINKS = 40;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_QUERY = /^(?:api[-_]?key|access[-_]?token|token|authorization|secret|password)$/iu;

export class PaperSourceError extends Error {
  constructor(message, code = "PAPER_SOURCE_UNAVAILABLE") {
    super(message);
    this.name = "PaperSourceError";
    this.code = code;
    this.statusCode = 422;
  }
}

function sourceRequired() {
  return new PaperSourceError(
    "请提供一篇论文的项目链接、arXiv 链接或编号、DOI。当前模型无法自行联网检索；仅有题目时请使用支持联网检索的模型。",
    "PAPER_SOURCE_REQUIRED",
  );
}

function safeUrl(value, base) {
  const url = new URL(value, base);
  const host = url.hostname.replace(/^\[|\]$/gu, "").replace(/\.$/u, "").toLowerCase();
  if (
    !["http:", "https:"].includes(url.protocol) || url.username || url.password ||
    !host || host === "localhost" || host.endsWith(".localhost") ||
    host.endsWith(".local") || (!host.includes(".") && !isIP(host)) ||
    (isIP(host) && isPrivateOrReservedAddress(host)) ||
    [...url.searchParams.keys()].some((name) => SENSITIVE_QUERY.test(name))
  ) {
    throw new PaperSourceError("来源链接必须是无需凭据的公开网页，不能指向本机或局域网。");
  }
  url.hash = "";
  if (["arxiv.org", "www.arxiv.org", "export.arxiv.org"].includes(host)) {
    const match = /^\/(?:pdf|abs)\/(.+?)(?:\.pdf)?$/u.exec(url.pathname);
    if (match) {
      url.hostname = "arxiv.org";
      url.pathname = `/abs/${match[1]}`;
      url.search = "";
    }
  }
  return url;
}

function rootUrl(reference) {
  const value = String(reference ?? "").trim()
    .replace(/\[[^\]]*\]\((https?:\/\/[^\s]+?)\)/giu, "$1");
  const candidates = value.match(/https?:\/\/[^\s<>"'`]+/giu) ?? [];
  if (candidates.length) {
    const unique = [...new Set(candidates.map((candidate) =>
      safeUrl(candidate.replace(/[\])）,，。;；]+$/gu, "")).href,
    ))];
    if (unique.length !== 1) throw sourceRequired();
    return safeUrl(unique[0]);
  }
  const doi = /(?:^|\s|doi\s*:\s*)(10\.\d{4,9}\/[^\s<>]+)/iu.exec(value)?.[1];
  if (doi) return safeUrl(`https://doi.org/${doi.replace(/[),，。;；]+$/gu, "")}`);
  const arxiv = /^(?:arxiv\s*:\s*)?((?:\d{4}\.\d{4,5}|[a-z.-]+\/\d{7})(?:v\d+)?)$/iu.exec(value)?.[1];
  if (arxiv) return safeUrl(`https://arxiv.org/abs/${arxiv}`);
  throw sourceRequired();
}

function cancelBody(response) {
  try { void response?.body?.cancel()?.catch(() => {}); } catch { /* A canceled or locked body needs no further work. */ }
}

function withinBudget(operation, signal, onLate) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let aborted = false;
    const abort = () => { aborted = true; reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then((value) => {
      signal.removeEventListener("abort", abort);
      if (aborted) { void onLate?.(value); return; }
      resolve(value);
    }, (error) => {
      signal.removeEventListener("abort", abort);
      if (!aborted) reject(error);
    });
  });
}

async function readBody(response, signal, maxBytes) {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await cancelBody(response);
    throw new PaperSourceError("来源网页超过读取大小限制，请改用论文的 arXiv 或 DOI 页面。");
  }
  if (!response.body) throw new PaperSourceError("来源网页没有可读取的正文。");
  const reader = response.body.getReader();
  let complete = false;
  try {
    const chunks = [];
    let bytes = 0;
    while (true) {
      const result = await withinBudget(() => reader.read(), signal);
      if (result.done) { complete = true; break; }
      bytes += result.value.byteLength;
      if (bytes > maxBytes) throw new PaperSourceError("来源网页超过读取大小限制，请改用论文的 arXiv 或 DOI 页面。");
      chunks.push(Buffer.from(result.value));
    }
    const body = Buffer.concat(chunks, bytes);
    if (body.subarray(0, 1_024).includes(Buffer.from("%PDF-"))) {
      throw new PaperSourceError("这里需要论文介绍网页，请提供 arXiv 摘要页、DOI 或项目页面；不会直接读取 PDF 全文。");
    }
    return body.toString("utf8");
  } finally {
    if (!complete) { try { void reader.cancel().catch(() => {}); } catch { /* Ignore disposal errors. */ } }
    reader.releaseLock();
  }
}

async function fetchPage(start, options, signal) {
  let url = start;
  for (let redirect = 0; redirect <= 4; redirect += 1) {
    url = safeUrl(url.href);
    await withinBudget(() => assertPublicHostname(url.hostname, { lookupImpl: options.lookupImpl }), signal);
    signal.throwIfAborted();
    const response = await withinBudget(() => options.fetchImpl(url.href, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "text/html, application/xhtml+xml, text/plain;q=0.5", "User-Agent": "PersonalLiteratureLibrary/1.0" },
      signal,
    }), signal, cancelBody);
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      await cancelBody(response);
      if (!location || redirect === 4) throw new PaperSourceError("来源网页重定向异常，请提供可直接打开的公开论文页面。");
      url = safeUrl(location, url);
      continue;
    }
    if (!response.ok) {
      await cancelBody(response);
      throw new PaperSourceError("无法读取来源网页，请检查链接或网络，或改用论文的 arXiv、DOI 页面。");
    }
    const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (type && !["text/html", "application/xhtml+xml", "text/plain", "text/markdown"].includes(type)) {
      await cancelBody(response);
      throw new PaperSourceError("这里需要论文介绍网页，请提供 arXiv 摘要页、DOI 或项目页面；不会直接读取 PDF 全文。");
    }
    return { url, body: await readBody(response, signal, options.maxBytes), plain: ["text/plain", "text/markdown"].includes(type) };
  }
  throw new PaperSourceError("来源网页重定向过多。");
}

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", hellip: "…", copy: "©", reg: "®", laquo: "«", raquo: "»",
};
function decodeEntities(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (entity, name) => {
    if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? entity;
    const code = name[1].toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code) : "";
  });
}
function plainText(html) {
  return decodeEntities(html.replace(/<[^>]*>/gu, " ")).replace(/\s+/gu, " ").trim();
}
function attributes(tag) {
  const result = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gu)) {
    result[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4]);
  }
  return result;
}

function parsePage({ url, body, plain }) {
  if (plain) return { url: url.href, title: "", text: body.replace(/\s+/gu, " ").trim().slice(0, MAX_TEXT), links: [] };
  const cleaned = body.replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<(script|style|nav|footer|svg|iframe|form)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, "");
  const title = plainText(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/iu.exec(cleaned)?.[1] ?? "").slice(0, 500);
  if (/^(?:client challenge|robot check|just a moment(?:\.\.\.|…)?|access denied|attention required!?|verify (?:you are |you're |that you are )?human|captcha)(?:\s*[|—–-].*)?$/iu.test(title)) {
    throw new PaperSourceError("来源网站要求浏览器验证，未读取论文正文；请提供可访问的 arXiv 或项目页面。");
  }
  const metadata = [];
  const metadataLinks = [];
  for (const match of cleaned.matchAll(/<meta\b[^>]*>/giu)) {
    const attrs = attributes(match[0]);
    const name = (attrs.name || attrs.property || "").toLowerCase();
    if (/^(?:citation_|dc\.|dcterms\.|og:(?:title|description)|description)/u.test(name) && attrs.content) {
      metadata.push(`${name}: ${attrs.content}`);
      if (/^(?:citation_pdf_url|citation_fulltext_html_url|citation_doi)$/u.test(name)) {
        metadataLinks.push({ href: name === "citation_doi" ? `https://doi.org/${attrs.content}` : attrs.content, title: "Paper" });
      }
    }
  }
  const candidates = [...metadataLinks];
  for (const match of cleaned.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/giu)) {
    const attrs = attributes(match[1]);
    if (attrs.href) candidates.push({ href: attrs.href, title: plainText(match[2]) || attrs.title || "" });
  }
  const seen = new Set([url.href]);
  const links = [];
  for (const candidate of candidates) {
    try {
      const next = safeUrl(candidate.href, url);
      if (seen.has(next.href)) continue;
      seen.add(next.href);
      links.push({ url: next.href, title: candidate.title.slice(0, 500) });
    } catch { /* Unsafe or non-web links are excluded from evidence. */ }
  }
  const ordered = [...links.filter((link) => scholarlyLink(link.url)), ...links.filter((link) => !scholarlyLink(link.url))];
  const main = cleaned.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/giu, "");
  return { url: url.href, title, text: [metadata.join("\n"), plainText(main)].filter(Boolean).join("\n").slice(0, MAX_TEXT), links: ordered.slice(0, MAX_LINKS) };
}

function scholarlyLink(value) {
  const url = new URL(value);
  if (url.hostname === "arxiv.org" && /^\/abs\//u.test(url.pathname)) return "arxiv";
  if (["doi.org", "dx.doi.org"].includes(url.hostname) && /^\/10\./u.test(url.pathname)) return "doi";
  return "";
}

/** Read bounded public source evidence. It never executes page scripts, model tool calls, or API credentials. */
export async function readPaperSources(reference, {
  fetchImpl = createProxyAwareFetch(), lookupImpl = lookup, timeoutMs = 30_000, maxBytes = MAX_BYTES,
} = {}) {
  const root = rootUrl(reference);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new PaperSourceError("读取论文来源超时，请检查网络或改用可访问的 arXiv、DOI 页面。")), timeoutMs);
  const options = { fetchImpl, lookupImpl: typeof lookupImpl === "function" ? lookupImpl : lookup, maxBytes: Math.min(MAX_BYTES, Math.max(1, maxBytes)) };
  const pages = [];
  const warnings = [];
  try {
    const page = parsePage(await fetchPage(root, options, controller.signal));
    if (!page.text) throw new PaperSourceError("来源网页没有可读取的论文正文，请提供论文的 arXiv 或 DOI 页面。");
    pages.push(page);
    const seen = new Set([root.href, page.url]);
    for (const kind of ["arxiv", "doi"]) {
      const candidates = page.links.filter((link) => scholarlyLink(link.url) === kind &&
        /paper|arxiv|publication|article|preprint|论文/iu.test(link.title) && !seen.has(link.url));
      if (candidates.length > 1) { warnings.push("项目页面包含多个论文来源，未自动选择；请核对论文题目与来源。"); continue; }
      if (candidates.length !== 1 || pages.length >= 3) continue;
      const candidate = candidates[0];
      seen.add(candidate.url);
      try {
        const related = parsePage(await fetchPage(safeUrl(candidate.url), options, controller.signal));
        if (!related.text) throw new PaperSourceError("论文来源无可读取正文。");
        if (!seen.has(related.url) || related.url === candidate.url) {
          pages.push(related);
          seen.add(related.url);
        }
      } catch {
        warnings.push("部分关联论文页面读取失败；仅使用已读取的公开页面，请核对缺失资料。");
        if (controller.signal.aborted) break;
      }
    }
    return { pages, warnings };
  } catch (error) {
    if (error instanceof PaperSourceError) throw error;
    throw new PaperSourceError("无法读取公开论文来源，请检查链接和网络；不会根据模型记忆补写论文资料。");
  } finally {
    clearTimeout(timer);
  }
}
