#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const [
  itemsPath = "/private/tmp/zotero-items.json",
  collectionsPath = "/private/tmp/zotero-collections.json",
  attachmentsPath = "/private/tmp/zotero-attachments.json",
  notesPath = "/private/tmp/zotero-notes.json",
  outputPath = "local-data/library-data.json",
] = process.argv.slice(2);

const [items, collectionRecords, attachments, notes] = await Promise.all([
  readFile(resolve(itemsPath), "utf8").then(JSON.parse),
  readFile(resolve(collectionsPath), "utf8").then(JSON.parse),
  readFile(resolve(attachmentsPath), "utf8").then(JSON.parse),
  readFile(resolve(notesPath), "utf8").then(JSON.parse),
]);

const collectionsByKey = new Map(
  collectionRecords.map((record) => [record.key, record.data]),
);
const watchLaterCollectionKeys = new Set(
  collectionRecords
    .filter(
      (record) =>
        record.data.parentCollection === false &&
        record.data.name?.trim() === "待看",
    )
    .map((record) => record.key),
);
const pdfAttachmentsByParent = new Map();
const notesByParent = new Map();

for (const attachment of attachments) {
  const data = attachment.data ?? {};
  if (data.contentType !== "application/pdf" || !data.parentItem) continue;

  const current = pdfAttachmentsByParent.get(data.parentItem);
  if (!current || (!current.url && data.url)) {
    pdfAttachmentsByParent.set(data.parentItem, {
      key: attachment.key,
      url: data.url?.trim() || undefined,
    });
  }
}

function noteToText(note = "") {
  const entities = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return note
    .replace(/\\url\{(https?:\/\/[^}]+)\}/g, "$1")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:div|h[1-6]|li|p)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (match, entity) => {
      if (entity.startsWith("#x")) {
        return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      }
      if (entity.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
      }
      return entities[entity.toLocaleLowerCase("en")] ?? match;
    })
    .replace(/\\n/g, "\n")
    .replace(/^Comment:\s*/i, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

for (const note of notes) {
  const parentItem = note.data?.parentItem;
  const text = noteToText(note.data?.note);
  if (!parentItem || !text) continue;
  const current = notesByParent.get(parentItem) ?? [];
  current.push(text);
  notesByParent.set(parentItem, current);
}

function collectionAncestors(collectionKey) {
  const ancestors = [];
  const visited = new Set();
  let current = collectionsByKey.get(collectionKey);

  while (current?.parentCollection && !visited.has(current.parentCollection)) {
    visited.add(current.parentCollection);
    ancestors.push(current.parentCollection);
    current = collectionsByKey.get(current.parentCollection);
  }

  return ancestors;
}

const visibleCollectionRecords = collectionRecords.filter(
  (record) => !watchLaterCollectionKeys.has(record.key),
);
const normalizedParentCollection = (record) => {
  const parentId = record.data.parentCollection || null;
  return parentId && !watchLaterCollectionKeys.has(parentId) ? parentId : null;
};
const visibleAncestors = (collectionKey) =>
  collectionAncestors(collectionKey).filter(
    (ancestorId) => !watchLaterCollectionKeys.has(ancestorId),
  );
const collectionsByParent = new Map();
for (const record of visibleCollectionRecords) {
  const parentId = normalizedParentCollection(record);
  const siblings = collectionsByParent.get(parentId) ?? [];
  siblings.push(record);
  collectionsByParent.set(parentId, siblings);
}
const projectCollections = (parentId = null) =>
  (collectionsByParent.get(parentId) ?? []).map((record) => {
    const children = projectCollections(record.key);
    const ancestorIds = visibleAncestors(record.key);
    return {
      id: record.key,
      name: record.data.name,
      count: 0,
      sidebarVisible: true,
      ...(ancestorIds.length ? { ancestorIds } : {}),
      ...(children.length ? { children } : {}),
    };
  });
const categories = projectCollections();

const categoryRecords = visibleCollectionRecords.map((record, sortOrder) => ({
  id: record.key,
  name: record.data.name,
  parentId: normalizedParentCollection(record),
  sourceKind: "zotero",
  sourceKey: record.key,
  sourceParentId: record.data.parentCollection || null,
  sortOrder,
  sidebarVisible: true,
}));

function creatorName(creator) {
  if (creator.name) return creator.name.trim();
  return [creator.firstName, creator.lastName].filter(Boolean).join(" ").trim();
}

function formatCreators(creators = []) {
  const names = creators
    .filter((creator) =>
      ["author", "editor", "bookAuthor"].includes(creator.creatorType),
    )
    .map(creatorName)
    .filter(Boolean);

  if (!names.length) return "作者未录入";
  if (names.length <= 4) return names.join("、");
  return `${names[0]} 等 ${names.length} 位`;
}

function cleanUrl(rawUrl) {
  return rawUrl
    .replace(/\\+$/, "")
    .replace(/[)\]}>.,;:]+$/, "")
    .trim();
}

function extractUrls(text = "") {
  return [...text.matchAll(/https?:\/\/[^\s<>"']+/g)].map((match) => ({
    url: cleanUrl(match[0]),
    index: match.index ?? 0,
  }));
}

function providerFor(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host === "github.com") return "GitHub";
    if (host === "gitlab.com") return "GitLab";
    if (host === "bitbucket.org") return "Bitbucket";
  } catch {
    // The URL is discarded by the client if it is not a valid http(s) URL.
  }
  return "项目站";
}

function resourceLinks(data, note = "") {
  const text = [data.abstractNote, data.extra, note]
    .filter(Boolean)
    .join("\n");
  const candidates = extractUrls(text);
  const withContext = candidates.map((candidate) => ({
    ...candidate,
    context: text
      .slice(Math.max(0, candidate.index - 150), candidate.index)
      .toLocaleLowerCase("en"),
  }));

  const repository = withContext.find(({ url }) =>
    /(?:github\.com|gitlab\.com|bitbucket\.org)/i.test(url),
  );
  const codeMention = withContext.find(({ context }) =>
    /\b(?:code|source|implementation)\b/.test(context),
  );
  const projectMention = withContext.find(({ context }) =>
    /\b(?:project\s*(?:page|website|site)?|website|demos?|further info)\b/.test(
      context,
    ),
  );

  const codeUrl = repository?.url ?? codeMention?.url;
  const projectUrl = projectMention?.url;

  return {
    ...(codeUrl
      ? { codeUrl, codeProvider: providerFor(codeUrl) }
      : {}),
    ...(projectUrl
      ? { projectUrl, projectProvider: "项目主页" }
      : {}),
  };
}

function sourceLabel(data) {
  if (data.publicationTitle) return data.publicationTitle;
  if (data.conferenceName) return data.conferenceName;

  const arxivId = (data.extra ?? "").match(/arXiv:\s*([^\s[]+)/i)?.[1];
  if (arxivId) return `arXiv ${arxivId}`;
  if (data.repository) return data.repository;
  if (data.publisher) return data.publisher;
  if (data.DOI) return `DOI ${data.DOI}`;

  const labels = {
    book: "书籍",
    conferencePaper: "会议论文",
    journalArticle: "期刊论文",
    preprint: "预印本",
  };
  return labels[data.itemType] ?? "Zotero";
}

function displayDate(item) {
  return (
    item.meta?.parsedDate ||
    item.data.date ||
    "日期未录入"
  );
}

function arxivPdfUrl(url = "") {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)arxiv\.org$/i.test(parsed.hostname)) return undefined;
    const match = parsed.pathname.match(/^\/abs\/(.+)$/);
    return match ? `https://arxiv.org/pdf/${match[1]}` : undefined;
  } catch {
    return undefined;
  }
}

const papers = items.map((item) => {
  const originalDirectCollections = item.data.collections ?? [];
  const directCollections = originalDirectCollections.filter(
    (collectionKey) => !watchLaterCollectionKeys.has(collectionKey),
  );
  const scopes = new Set();

  for (const collectionKey of directCollections) {
    scopes.add(collectionKey);
    visibleAncestors(collectionKey).forEach((ancestor) =>
      scopes.add(ancestor),
    );
  }
  if (!scopes.size) scopes.add("uncategorized");

  const tags = directCollections
    .map((collectionKey) => collectionsByKey.get(collectionKey))
    .filter(Boolean)
    .map((collection) => ({
      label: collection.name,
      scope: collection.key,
    }));

  const pdfAttachment = pdfAttachmentsByParent.get(item.key);
  const hasPdf =
    Boolean(pdfAttachment) ||
    item.links?.attachment?.attachmentType === "application/pdf";
  const originalUrl =
    item.data.url?.trim() ||
    (item.data.DOI ? `https://doi.org/${item.data.DOI}` : undefined);
  const pdfUrl = hasPdf
    ? pdfAttachment?.url || arxivPdfUrl(originalUrl)
    : undefined;
  const importedNotes = notesByParent.get(item.key) ?? [];
  const note = importedNotes.join("\n\n");

  return {
    id: item.key,
    zoteroKey: item.key,
    title: item.data.title?.trim() || "未命名文献",
    zhTitle: "",
    authors: formatCreators(item.data.creators),
    institution: "",
    source: sourceLabel(item.data),
    date: displayDate(item),
    dateAdded: item.data.dateAdded ?? "",
    tags,
    aiSummary: "",
    note,
    ...(importedNotes.length ? { noteCount: importedNotes.length } : {}),
    categoryIds: directCollections,
    scopes: [...scopes],
    favorite: false,
    watchLater: originalDirectCollections.some((collectionKey) =>
      watchLaterCollectionKeys.has(collectionKey),
    ),
    hasPdf,
    ...(pdfAttachment?.key
      ? { pdfAttachmentKey: pdfAttachment.key }
      : {}),
    ...(pdfUrl ? { pdfUrl } : {}),
    ...(originalUrl ? { originalUrl } : {}),
    ...resourceLinks(item.data, note),
  };
});

const library = {
  importedAt: new Date().toISOString(),
  source: "Zotero one-time export",
  categories,
  categoryRecords,
  papers,
};

const resolvedOutputPath = resolve(outputPath);
await mkdir(dirname(resolvedOutputPath), { recursive: true });
await writeFile(
  resolvedOutputPath,
  `${JSON.stringify(library, null, 2)}\n`,
  "utf8",
);

console.log(
  `Imported ${papers.length} papers and ${categoryRecords.length} categories into ${outputPath}`,
);
