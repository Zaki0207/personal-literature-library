import type {
  AiReasoningEffort,
  CardTextSize,
  Category,
  CategoryRecord,
  FlatCategory,
  Paper,
  PaperEditDraft,
  RadarItem,
} from "./contracts";
import { matchPaperSearch } from "../../lib/paper-search.mjs";

type PaperSearchMatch = ReturnType<typeof matchPaperSearch>;

export const AI_REASONING_EFFORT_LABELS: Record<
  AiReasoningEffort,
  string
> = {
  none: "无思考",
  minimal: "最少",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
};

export const paperSearchFieldLabels: Record<string, string> = {
  identifier: "论文标识",
  source: "来源",
  year: "发表年份",
  title: "英文标题",
  zhTitle: "中文标题",
  authors: "作者",
  institution: "机构",
  categories: "分类",
  aiSummary: "AI 总结",
  note: "笔记",
  resources: "资源",
};

export const legacyWatchCategoryIds = new Set(["BGPSP4JY"]);
export const radarPromptTemplateVariables = [
  "{{research_scope}}",
  "{{round}}",
  "{{requested_count}}",
  "{{exclusions_json}}",
] as const;

export const cardTextSizeLabels: Record<CardTextSize, string> = {
  small: "小",
  standard: "标准",
  large: "大",
};

export function normalizePaper(paper: Paper): Paper {
  const originalCategoryIds = paper.categoryIds ?? [];
  const inheritedLegacyWatch =
    originalCategoryIds.some((id) => legacyWatchCategoryIds.has(id)) ||
    paper.tags.some((tag) => legacyWatchCategoryIds.has(tag.scope));
  const categoryIds = originalCategoryIds.filter(
    (id) => !legacyWatchCategoryIds.has(id),
  );
  const scopes = paper.scopes.filter(
    (scope) => !legacyWatchCategoryIds.has(scope),
  );

  return {
    ...paper,
    categoryIds,
    tags: paper.tags.filter(
      (tag) => !legacyWatchCategoryIds.has(tag.scope),
    ),
    scopes:
      scopes.length || categoryIds.length ? scopes : ["uncategorized"],
    favorite: Boolean(paper.favorite),
    watchLater: paper.watchLater ?? inheritedLegacyWatch,
  };
}

export function normalizePapers(papers: Paper[]) {
  return papers.map(normalizePaper);
}

export function paperMatchesNonScopeFilters(
  paper: Paper,
  options: {
    searchMatch: PaperSearchMatch;
    favoriteOnly: boolean;
    watchLaterOnly: boolean;
    codeOnly: boolean;
    projectOnly: boolean;
  },
) {
  if (options.favoriteOnly && !paper.favorite) return false;
  if (options.watchLaterOnly && !paper.watchLater) return false;
  if (options.codeOnly && !safeExternalUrl(paper.codeUrl)) return false;
  if (options.projectOnly && !safeExternalUrl(paper.projectUrl)) return false;
  return options.searchMatch.matched;
}

export function sanitizeCategoryTree(categories: Category[]): Category[] {
  return categories
    .filter((category) => !legacyWatchCategoryIds.has(category.id))
    .map((category) => ({
      ...category,
      sidebarVisible: category.sidebarVisible ?? true,
      children: sanitizeCategoryTree(category.children ?? []),
    }));
}

export function scopeIsInsideHiddenRoot(
  categories: Category[],
  scope: string,
) {
  if (scope === "all" || scope === "uncategorized") return false;
  const includesScope = (category: Category): boolean =>
    category.id === scope || Boolean(category.children?.some(includesScope));
  const root = categories.find(includesScope);
  return Boolean(root && !root.sidebarVisible);
}

export function flattenCategoryTree(
  categories: Category[],
  depth = 0,
  parentPath: string[] = [],
  parentIds: string[] = [],
  parentNumberPath: number[] = [],
): FlatCategory[] {
  return categories.flatMap((category, index) => {
    const path = [...parentPath, category.name];
    const numberPath = [...parentNumberPath, index + 1];
    const ancestorIds =
      category.ancestorIds?.length ? category.ancestorIds : parentIds;
    const outlineNumber =
      numberPath.length === 1 ? `${numberPath[0]}.` : numberPath.join(".");
    return [
      {
        ...category,
        ancestorIds,
        depth,
        path,
        numberPath,
        outlineNumber,
      },
      ...flattenCategoryTree(
        category.children ?? [],
        depth + 1,
        path,
        [...parentIds, category.id],
        numberPath,
      ),
    ];
  });
}

export function safeExternalUrl(url?: string) {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function providerForUrl(url: string) {
  const safeUrl = safeExternalUrl(url);
  if (!safeUrl) return "代码";
  const host = new URL(safeUrl).hostname.replace(/^www\./, "");
  if (host === "github.com") return "GitHub";
  if (host === "gitlab.com") return "GitLab";
  if (host === "bitbucket.org") return "Bitbucket";
  return "项目站";
}

export function referenceForRadarItem(item: RadarItem) {
  const originalUrl = safeExternalUrl(item.originalUrl);
  if (originalUrl) return originalUrl;

  const doi = item.identifiers.find((identifier) => identifier.kind === "doi");
  if (doi) return `https://doi.org/${doi.value}`;

  const arxiv = item.identifiers.find(
    (identifier) => identifier.kind === "arxiv",
  );
  if (arxiv) return `https://arxiv.org/abs/${arxiv.value}`;

  const url = item.identifiers.find((identifier) => identifier.kind === "url");
  return safeExternalUrl(url?.value) ?? "";
}

export function draftFromPaper(paper: Paper): PaperEditDraft {
  return {
    title: paper.title,
    zhTitle: paper.zhTitle,
    authors: paper.authors,
    institution: paper.institution,
    source: paper.source,
    date: paper.date === "日期未录入" ? "" : paper.date,
    favorite: paper.favorite,
    watchLater: paper.watchLater,
    selectedCategoryIds:
      paper.categoryIds ??
      paper.tags
        .map((tag) => tag.scope)
        .filter((scope) => scope !== "uncategorized"),
    aiSummary: paper.aiSummary,
    note: paper.note ?? "",
    pdfUrl: paper.pdfUrl ?? "",
    originalUrl: paper.originalUrl ?? "",
    hasCode: Boolean(paper.codeProvider || paper.codeUrl),
    codeUrl: paper.codeUrl ?? "",
    hasProject: Boolean(paper.projectProvider || paper.projectUrl),
    projectUrl: paper.projectUrl ?? "",
  };
}

export function sameCategorySelection(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return left.every((id) => rightIds.has(id));
}

export function formatPdfSize(sizeBytes?: number) {
  if (!sizeBytes || sizeBytes < 1_024) return sizeBytes ? `${sizeBytes} B` : "";
  if (sizeBytes < 1_024 * 1_024) {
    return `${(sizeBytes / 1_024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

export function formatPdfArchiveTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatBackupTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatAiVerifiedTime(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatRadarAiTraceTime(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

export function formatAiBaseUrlHost(value: string) {
  try {
    return new URL(value).host || "待确认地址";
  } catch {
    return "待确认地址";
  }
}

export function normalizeAiBaseUrlForComparison(value: string) {
  try {
    const url = new URL(value.trim());
    url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.toString().replace(/\/$/u, "");
  } catch {
    return value.trim().replace(/\/+$/u, "");
  }
}

export function normalizeCategoryRecords(
  records: Array<
    Partial<CategoryRecord> & Pick<CategoryRecord, "id" | "name">
  >,
  papers: Paper[],
) {
  const visibleRecords = records.filter(
    (record) => !legacyWatchCategoryIds.has(record.id),
  );
  return visibleRecords.map((record) => {
    const parentId = record.parentId ?? null;
    const directCount =
      record.directCount ??
      papers.filter((paper) => paper.categoryIds?.includes(record.id)).length;
    const totalCount =
      record.totalCount ??
      papers.filter((paper) => paper.scopes.includes(record.id)).length;
    const childCount =
      record.childCount ??
      visibleRecords.filter((candidate) => candidate.parentId === record.id)
        .length;

    return {
      id: record.id,
      name: record.name,
      parentId,
      ancestorIds: record.ancestorIds ?? [],
      directCount,
      totalCount,
      childCount,
      sidebarVisible: record.sidebarVisible ?? true,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  });
}
