"use client";

import {
  ChangeEvent,
  DragEvent as ReactDragEvent,
  Fragment,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  comparePaperSearchMatches,
  matchPaperSearch,
  normalizeSearchText,
} from "../lib/paper-search.mjs";
import {
  formatAuthorsForDisplay,
  formatInstitutionForDisplay,
  formatPublicationForDisplay,
} from "../lib/paper-display.mjs";
import { createPortal } from "react-dom";

type CardTextSize = "small" | "standard" | "large";
type PaperViewMode = "cards" | "titles";

type Category = {
  id: string;
  name: string;
  count: number;
  sidebarVisible: boolean;
  ancestorIds?: string[];
  children?: Category[];
};

type CategoryRecord = {
  id: string;
  name: string;
  parentId: string | null;
  ancestorIds: string[];
  directCount: number;
  totalCount: number;
  childCount: number;
  sidebarVisible: boolean;
  createdAt?: string;
  updatedAt?: string;
};

type DeletedCategoryRecord = CategoryRecord & {
  deletedAt?: string;
};

type PaperTag = {
  label: string;
  scope: string;
};

type PaperIdentifier = {
  kind: "doi" | "arxiv" | "url";
  value: string;
};

type PdfArchive = {
  status: "ready" | "failed" | "stale";
  downloadedAt?: string;
  sizeBytes?: number;
  errorCode?: string;
  errorMessage?: string;
};

type Paper = {
  id: string;
  zoteroKey?: string;
  title: string;
  zhTitle: string;
  authors: string;
  institution: string;
  source: string;
  date: string;
  dateAdded: string;
  tags: PaperTag[];
  aiSummary: string;
  note?: string;
  noteCount?: number;
  categoryIds?: string[];
  scopes: string[];
  favorite: boolean;
  watchLater: boolean;
  hasPdf: boolean;
  pdfAttachmentKey?: string;
  pdfUrl?: string;
  pdfArchive?: PdfArchive;
  originalUrl?: string;
  codeProvider?: string;
  codeUrl?: string;
  projectProvider?: string;
  projectUrl?: string;
  identifiers?: PaperIdentifier[];
  updatedAt?: string;
};

type PaperIntakeDraft = {
  title: string;
  zhTitle: string;
  authors: string;
  institution: string;
  source: string;
  date: string;
  aiSummary: string;
  categoryIds: string[];
  originalUrl: string;
  pdfUrl: string;
  hasPdf: boolean;
  codeUrl: string;
  codeProvider: string;
  projectUrl: string;
  projectProvider: string;
  identifiers: PaperIdentifier[];
};

type PaperDuplicateMatch = {
  paper: Pick<
    Paper,
    "id" | "title" | "zhTitle" | "authors" | "source" | "date"
  > & { deletedAt?: string };
  reasons: Array<
    | { type: "title" }
    | { type: "identifier"; kind: PaperIdentifier["kind"]; value: string }
  >;
};

type PaperIntakeResponse =
  | {
      status: "duplicate";
      reference: string;
      duplicates: PaperDuplicateMatch[];
    }
  | {
      status: "ready";
      reference: string;
      metadata: {
        title: string;
        authors: string;
        institution: string;
        source: string;
        date: string;
        originalUrl: string;
        pdfUrl: string;
        identifiers: PaperIdentifier[];
        metadataSource: string;
        publicationStatus: "published" | "preprint" | "unknown";
        publicationMatch: { method: string; confidence: string };
        preprint: null | { arxivId: string; url: string; date: string };
        codeUrl: string;
        codeProvider: string;
        codeEvidence: string;
        projectUrl: string;
        projectProvider: string;
        projectEvidence: string;
      };
      ai: null | {
        zhTitle: string;
        institution: string;
        source: string;
        aiSummary: string;
        categoryIds: string[];
        model: string;
      };
      aiError: null | { code: string; message: string; action?: string };
      draft: PaperIntakeDraft;
    };

type PaperEditDraft = {
  title: string;
  zhTitle: string;
  authors: string;
  institution: string;
  source: string;
  date: string;
  favorite: boolean;
  watchLater: boolean;
  selectedCategoryIds: string[];
  aiSummary: string;
  note: string;
  pdfUrl: string;
  originalUrl: string;
  hasCode: boolean;
  codeUrl: string;
  hasProject: boolean;
  projectUrl: string;
};

type BackupStatus = {
  ok: boolean;
  lastBackupAt?: string;
  message?: string;
};

type LibraryResponse = {
  papers: Paper[];
  categories: Category[];
  backup?: BackupStatus;
};

type PaperMutationResponse = {
  paper: Paper;
  backup?: BackupStatus;
};

type PdfArchiveMutationResponse = PaperMutationResponse & {
  alreadyArchived?: boolean;
  committed?: boolean;
};

type CategoryMutationResponse = {
  category: CategoryRecord;
  categories?: CategoryRecord[];
  deletedCategories?: DeletedCategoryRecord[];
  library?: LibraryResponse;
  backup?: BackupStatus;
};

type CategoriesResponse = {
  categories: CategoryRecord[];
  deletedCategories?: DeletedCategoryRecord[];
  library?: LibraryResponse;
  backup?: BackupStatus;
};

type LibraryConnection = "connecting" | "ready" | "unavailable";

type AiModelSettings = {
  id: string;
  model: string;
  resolvedModel: string;
  verifiedAt: string | null;
  active: boolean;
};

type AiConnectionSettings = {
  id: string;
  name: string;
  baseUrl: string;
  configured: boolean;
  status: "verified" | "credential-missing";
  models: AiModelSettings[];
};

type AiSettingsResponse = {
  connections: AiConnectionSettings[];
  activeModelId: string | null;
};

type AiSettingsMutationResponse = {
  settings: AiSettingsResponse;
  backup?: BackupStatus;
};

type AiVerificationResponse = AiSettingsMutationResponse & {
  verification: {
    ok: true;
    connectionId: string;
    modelId: string;
    requestedModel: string;
    resolvedModel: string;
    latencyMs: number;
    verifiedAt: string;
  };
};

type RadarItem = {
  id: string;
  title: string;
  zhTitle: string;
  authors: string;
  institution: string;
  source: string;
  date: string;
  aiSummary: string;
  recommendationReason: string;
  originalUrl?: string;
  pdfUrl?: string;
  identifiers: PaperIdentifier[];
  status: "pending" | "added" | "discarded";
  addedPaperId?: string;
  createdAt: string;
  updatedAt: string;
};

type RadarStateResponse = {
  settings: {
    prompt: string;
    requestedCount: number;
    updatedAt?: string;
  };
  pending: RadarItem[];
  discarded: RadarItem[];
  counts: {
    library: number;
    pending: number;
    discarded: number;
    added: number;
  };
  backup?: BackupStatus;
  context?: {
    providedToAi: number;
    totalExclusions: number;
    locallyChecked: number;
  };
  lastRun?: {
    requested: number;
    added: number;
    insufficient: boolean;
    rounds: number;
    examined: number;
    excludedLibrary: number;
    excludedHistory: number;
    excludedWithinRun: number;
    invalid: number;
    invalidResponses?: number;
  };
};

type RadarAddResponse = {
  paper: Paper;
  library: LibraryResponse;
  radar: RadarStateResponse;
};

type RadarAiExchange = {
  round: number;
  prompt: string;
  response: string;
  startedAt: string;
  completedAt: string;
  provider: string;
  model: string;
  latencyMs: number | null;
  errorMessage: string;
};

type RadarAiTrace = {
  status: "running" | "completed" | "failed";
  requestedCount: number;
  userPrompt: string;
  exchanges: RadarAiExchange[];
  errorMessage: string;
  startedAt: string;
  completedAt: string;
  updatedAt: string;
};

type RadarAiTraceResponse = {
  trace: RadarAiTrace | null;
};

type FlatCategory = Category & {
  depth: number;
  path: string[];
  numberPath: number[];
  outlineNumber: string;
};

type PaperSearchMatch = ReturnType<typeof matchPaperSearch>;

const paperSearchFieldLabels: Record<string, string> = {
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

const legacyWatchCategoryIds = new Set(["BGPSP4JY"]);
const initialPapers: Paper[] = [];
const initialCategories: Category[] = [];
const initialCategoryRecords: CategoryRecord[] = [];

function normalizePaper(paper: Paper): Paper {
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
      scopes.length || categoryIds.length
        ? scopes
        : ["uncategorized"],
    favorite: Boolean(paper.favorite),
    watchLater: paper.watchLater ?? inheritedLegacyWatch,
  };
}

function normalizePapers(papers: Paper[]) {
  return papers.map(normalizePaper);
}

function paperMatchesNonScopeFilters(
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

function sanitizeCategoryTree(categories: Category[]): Category[] {
  return categories
    .filter((category) => !legacyWatchCategoryIds.has(category.id))
    .map((category) => ({
      ...category,
      sidebarVisible: category.sidebarVisible ?? true,
      children: sanitizeCategoryTree(category.children ?? []),
    }));
}

function scopeIsInsideHiddenRoot(
  categories: Category[],
  scope: string,
) {
  if (scope === "all" || scope === "uncategorized") return false;
  const includesScope = (category: Category): boolean =>
    category.id === scope ||
    Boolean(category.children?.some(includesScope));
  const root = categories.find(includesScope);
  return Boolean(root && !root.sidebarVisible);
}

function flattenCategoryTree(
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
      numberPath.length === 1
        ? `${numberPath[0]}.`
        : numberPath.join(".");
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

const configuredLibraryApiUrl =
  (
    import.meta as ImportMeta & {
      env?: { VITE_LIBRARY_API_URL?: string };
    }
  ).env?.VITE_LIBRARY_API_URL ?? "http://127.0.0.1:4317";
const LIBRARY_API_BASE = `${configuredLibraryApiUrl.replace(/\/+$/, "")}/api`;

const cardTextSizeLabels: Record<CardTextSize, string> = {
  small: "小",
  standard: "标准",
  large: "大",
};

function safeExternalUrl(url?: string) {
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

function providerForUrl(url: string) {
  const safeUrl = safeExternalUrl(url);
  if (!safeUrl) return "代码";
  const host = new URL(safeUrl).hostname.replace(/^www\./, "");
  if (host === "github.com") return "GitHub";
  if (host === "gitlab.com") return "GitLab";
  if (host === "bitbucket.org") return "Bitbucket";
  return "项目站";
}

function draftFromPaper(paper: Paper): PaperEditDraft {
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
      paper.tags.map((tag) => tag.scope).filter((scope) => scope !== "uncategorized"),
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

function sameCategorySelection(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return left.every((id) => rightIds.has(id));
}

async function libraryRequest<T>(path: string, init?: RequestInit) {
  const response = await fetch(`${LIBRARY_API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const payload = (await response.json().catch(() => null)) as
    | (T & {
        error?:
          | string
          | { message?: string; details?: { action?: string } };
      })
    | null;
  if (!response.ok) {
    const errorValue = payload?.error;
    const message =
      typeof errorValue === "object"
        ? errorValue.message || "本机文献数据库暂时不可用"
        : errorValue || "本机文献数据库暂时不可用";
    const action =
      typeof errorValue === "object" ? errorValue.details?.action : "";
    throw new Error(
      action && action !== message ? `${message} ${action}` : message,
    );
  }
  return payload as T;
}

function pdfOpenUrl(paperId: string) {
  return `${LIBRARY_API_BASE}/papers/${encodeURIComponent(paperId)}/pdf/open`;
}

function formatPdfSize(sizeBytes?: number) {
  if (!sizeBytes || sizeBytes < 1_024) return sizeBytes ? `${sizeBytes} B` : "";
  if (sizeBytes < 1_024 * 1_024) {
    return `${(sizeBytes / 1_024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function formatPdfArchiveTime(value?: string) {
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

function formatBackupTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatAiVerifiedTime(value?: string | null) {
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

function formatRadarAiTraceTime(value?: string | null) {
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

function formatAiBaseUrlHost(value: string) {
  try {
    return new URL(value).host || "待确认地址";
  } catch {
    return "待确认地址";
  }
}

function normalizeAiBaseUrlForComparison(value: string) {
  try {
    const url = new URL(value.trim());
    url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.toString().replace(/\/$/u, "");
  } catch {
    return value.trim().replace(/\/+$/u, "");
  }
}

function normalizeCategoryRecords(
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

export default function Home() {
  const [papers, setPapers] = useState(initialPapers);
  const [categories, setCategories] = useState(initialCategories);
  const [activeSurface, setActiveSurface] = useState<"library" | "radar">(
    "library",
  );
  const [radarState, setRadarState] = useState<RadarStateResponse | null>(null);
  const [radarPrompt, setRadarPrompt] = useState("");
  const [radarCount, setRadarCount] = useState(5);
  const [radarView, setRadarView] = useState<"pending" | "discarded">(
    "pending",
  );
  const [radarBusy, setRadarBusy] = useState(false);
  const [radarItemBusy, setRadarItemBusy] = useState<string | null>(null);
  const [radarError, setRadarError] = useState("");
  const [radarContextOpen, setRadarContextOpen] = useState(false);
  const [radarAiTraceOpen, setRadarAiTraceOpen] = useState(false);
  const [radarAiTrace, setRadarAiTrace] = useState<RadarAiTrace | null>(null);
  const [radarAiTraceLoading, setRadarAiTraceLoading] = useState(false);
  const [radarAiTraceError, setRadarAiTraceError] = useState("");
  const [activeScope, setActiveScope] = useState("all");
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState("recent");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [textSizeOpen, setTextSizeOpen] = useState(false);
  const [cardTextSize, setCardTextSize] =
    useState<CardTextSize>("small");
  const [paperViewMode, setPaperViewMode] =
    useState<PaperViewMode>("cards");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [watchLaterOnly, setWatchLaterOnly] = useState(false);
  const [codeOnly, setCodeOnly] = useState(false);
  const [projectOnly, setProjectOnly] = useState(false);
  const [openCategories, setOpenCategories] = useState(
    new Set(
      flattenCategoryTree(initialCategories)
        .filter((category) => category.children?.length)
        .map((category) => category.id),
    ),
  );
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [addPaperOpen, setAddPaperOpen] = useState(false);
  const [addingPaper, setAddingPaper] = useState(false);
  const [paperReference, setPaperReference] = useState("");
  const [paperIntakeResult, setPaperIntakeResult] =
    useState<PaperIntakeResponse | null>(null);
  const [paperIntakeDraft, setPaperIntakeDraft] =
    useState<PaperIntakeDraft | null>(null);
  const [paperIntakeBusy, setPaperIntakeBusy] = useState(false);
  const [paperDuplicateBusyId, setPaperDuplicateBusyId] = useState<string | null>(
    null,
  );
  const [paperIntakeError, setPaperIntakeError] = useState("");
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [aiSettings, setAiSettings] = useState<AiSettingsResponse | null>(
    null,
  );
  const [aiSelectedConnectionId, setAiSelectedConnectionId] = useState<
    string | null
  >(null);
  const [aiCreatingConnection, setAiCreatingConnection] = useState(false);
  const [aiDraftName, setAiDraftName] = useState("");
  const [aiDraftBaseUrl, setAiDraftBaseUrl] = useState("");
  const [aiDraftModel, setAiDraftModel] = useState("");
  const [aiSettingsLoading, setAiSettingsLoading] = useState(false);
  const [aiBusyAction, setAiBusyAction] = useState<string | null>(null);
  const [aiKeyEntered, setAiKeyEntered] = useState(false);
  const [aiInlineError, setAiInlineError] = useState<{
    connectionId?: string;
    message: string;
  } | null>(null);
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);
  const [categoryRecords, setCategoryRecords] = useState(() =>
    normalizeCategoryRecords(initialCategoryRecords, initialPapers),
  );
  const [deletedCategoryRecords, setDeletedCategoryRecords] = useState<
    DeletedCategoryRecord[]
  >([]);
  const [categoryManagerLoading, setCategoryManagerLoading] = useState(false);
  const [categoryActionBusy, setCategoryActionBusy] = useState<string | null>(
    null,
  );
  const [sidebarDraggedCategoryId, setSidebarDraggedCategoryId] = useState<
    string | null
  >(null);
  const [sidebarDropTarget, setSidebarDropTarget] = useState<{
    id: string;
    placement: "before" | "after";
  } | null>(null);
  const [categoryActionMenu, setCategoryActionMenu] = useState<string | null>(
    null,
  );
  const [categoryCreateOpen, setCategoryCreateOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryParentId, setNewCategoryParentId] = useState("");
  const [renamingCategoryId, setRenamingCategoryId] = useState<string | null>(
    null,
  );
  const [renameCategoryName, setRenameCategoryName] = useState("");
  const [movingCategoryId, setMovingCategoryId] = useState<string | null>(null);
  const [moveCategoryParentId, setMoveCategoryParentId] = useState("");
  const [categoryInlineError, setCategoryInlineError] = useState("");
  const [categoryDeleteCandidate, setCategoryDeleteCandidate] =
    useState<CategoryRecord | null>(null);
  const [categoryDiscardConfirmOpen, setCategoryDiscardConfirmOpen] =
    useState(false);
  const [editingPaperId, setEditingPaperId] = useState<string | null>(null);
  const [titlePreviewPaperId, setTitlePreviewPaperId] = useState<string | null>(
    null,
  );
  const [editDraft, setEditDraft] = useState<PaperEditDraft | null>(null);
  const [editBaseline, setEditBaseline] = useState("");
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [savingPaper, setSavingPaper] = useState(false);
  const [pdfActionBusyId, setPdfActionBusyId] = useState<string | null>(
    null,
  );
  const [lastDeleted, setLastDeleted] = useState<{
    paper: Paper;
    index: number;
  } | null>(null);
  const [lastDeletedCategory, setLastDeletedCategory] =
    useState<DeletedCategoryRecord | null>(null);
  const [libraryConnection, setLibraryConnection] =
    useState<LibraryConnection>("connecting");
  const [backupStatus, setBackupStatus] = useState<BackupStatus>({
    ok: false,
  });
  const [isMobile, setIsMobile] = useState(false);
  const [toast, setToast] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const aiKeyInputRef = useRef<HTMLInputElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const mobileMenuRef = useRef<HTMLButtonElement>(null);
  const mobileNavWasOpenRef = useRef(false);
  const modalRef = useRef<HTMLElement>(null);
  const titlePreviewCloseRef = useRef<HTMLButtonElement>(null);
  const editFormRef = useRef<HTMLFormElement>(null);
  const pdfImportInputRef = useRef<HTMLInputElement>(null);
  const discardReturnFocusRef = useRef<HTMLElement | null>(null);
  const modalTriggerRef = useRef<HTMLElement | null>(null);
  const modalWasOpenRef = useRef(false);
  const addingPaperRef = useRef(false);
  const modalOpen =
    addPaperOpen ||
    aiSettingsOpen ||
    categoryManagerOpen ||
    radarAiTraceOpen ||
    editingPaperId !== null ||
    titlePreviewPaperId !== null;
  const sidebarExpanded = isMobile ? mobileNavOpen : !sidebarCollapsed;
  const editingPaper = editingPaperId
    ? papers.find((paper) => paper.id === editingPaperId) ?? null
    : null;
  const titlePreviewPaper = titlePreviewPaperId
    ? papers.find((paper) => paper.id === titlePreviewPaperId) ?? null
    : null;
  const editDirty = Boolean(
    editDraft && JSON.stringify(editDraft) !== editBaseline,
  );
  const editPdfSourceChanged = Boolean(
    editingPaper &&
      editDraft &&
      editDraft.pdfUrl.trim() !== (editingPaper.pdfUrl ?? ""),
  );
  const renamingCategory = renamingCategoryId
    ? categoryRecords.find((category) => category.id === renamingCategoryId) ??
      null
    : null;
  const movingCategory = movingCategoryId
    ? categoryRecords.find((category) => category.id === movingCategoryId) ??
      null
    : null;
  const categoryManagerDirty =
    Boolean(categoryCreateOpen && newCategoryName.trim()) ||
    Boolean(
      renamingCategory &&
        renameCategoryName.trim() !== renamingCategory.name.trim(),
    ) ||
    Boolean(
      movingCategory &&
        moveCategoryParentId !== (movingCategory.parentId ?? ""),
    );

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }

      if (event.key === "Escape") {
        setFiltersOpen(false);
        setTextSizeOpen(false);
        setOpenMenu(null);
        setTitlePreviewPaperId(null);
        setAddPaperOpen(false);
        if (!aiBusyAction) setAiSettingsOpen(false);
        setMobileNavOpen(false);
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [aiBusyAction]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | undefined;

    const loadLibrary = async (attempt = 0) => {
      try {
        const response = await libraryRequest<LibraryResponse>("/library");
        if (cancelled) return;
        const nextCategories = sanitizeCategoryTree(response.categories);
        setPapers(normalizePapers(response.papers));
        setCategories(nextCategories);
        setOpenCategories(
          new Set(
            flattenCategoryTree(nextCategories)
              .filter((category) => category.children?.length)
              .map((category) => category.id),
          ),
        );
        setActiveScope((current) =>
          scopeIsInsideHiddenRoot(nextCategories, current) ? "all" : current,
        );
        setBackupStatus(response.backup ?? { ok: false });
        setLibraryConnection("ready");
      } catch {
        if (cancelled) return;
        if (attempt < 5) {
          retryTimer = window.setTimeout(
            () => loadLibrary(attempt + 1),
            450 * (attempt + 1),
          );
          return;
        }
        setLibraryConnection("unavailable");
      }
    };

    loadLibrary();
    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadRadar = async () => {
      try {
        const response = await libraryRequest<RadarStateResponse>("/radar");
        if (cancelled) return;
        setRadarState(response);
        setRadarPrompt(response.settings.prompt);
        setRadarCount(response.settings.requestedCount);
        if (response.backup) setBackupStatus(response.backup);
      } catch (error) {
        if (cancelled) return;
        setRadarError(
          error instanceof Error ? error.message : "文献雷达暂时不可用。",
        );
      }
    };
    loadRadar();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let frame: number | undefined;
    try {
      const saved = window.localStorage.getItem("paper-card-text-size");
      if (saved === "small" || saved === "standard" || saved === "large") {
        frame = window.requestAnimationFrame(() => setCardTextSize(saved));
      }
    } catch {
      // The preference remains at the readable small default.
    }
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    let frame: number | undefined;
    try {
      const saved = window.localStorage.getItem("paper-view-mode");
      if (saved === "cards" || saved === "titles") {
        frame = window.requestAnimationFrame(() => setPaperViewMode(saved));
      }
    } catch {
      // The preference remains on the existing card view by default.
    }
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    let frame: number | undefined;
    try {
      const saved = window.localStorage.getItem(
        "literature-sidebar-collapsed",
      );
      if (saved === "true") {
        frame = window.requestAnimationFrame(() =>
          setSidebarCollapsed(true),
        );
      }
    } catch {
      // The sidebar remains visible when local preferences are unavailable.
    }
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => {
      setIsMobile(media.matches);
      if (!media.matches) setMobileNavOpen(false);
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!isMobile) {
      mobileNavWasOpenRef.current = false;
      if (
        sidebarCollapsed &&
        sidebarRef.current?.contains(document.activeElement)
      ) {
        mobileMenuRef.current?.focus();
      }
      return;
    }

    if (mobileNavOpen) {
      mobileNavWasOpenRef.current = true;
      window.requestAnimationFrame(() => {
        sidebarRef.current?.querySelector<HTMLElement>("button")?.focus();
      });
    } else if (mobileNavWasOpenRef.current) {
      mobileNavWasOpenRef.current = false;
      mobileMenuRef.current?.focus();
    }
  }, [isMobile, mobileNavOpen, sidebarCollapsed]);

  useEffect(() => {
    if (modalOpen) {
      modalWasOpenRef.current = true;
      return;
    }

    if (modalWasOpenRef.current) {
      modalWasOpenRef.current = false;
      if (modalTriggerRef.current?.isConnected) {
        modalTriggerRef.current.focus();
      } else {
        searchRef.current?.focus();
      }
    }
  }, [modalOpen]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(
      () => {
        setToast("");
        setLastDeleted(null);
        setLastDeletedCategory(null);
      },
      lastDeletedCategory ? 10_000 : lastDeleted ? 5200 : 2600,
    );
    return () => window.clearTimeout(timer);
  }, [lastDeleted, lastDeletedCategory, toast]);

  useEffect(() => {
    if (!modalOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [modalOpen]);

  useEffect(() => {
    if (!editDirty && !categoryManagerDirty) return;
    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [categoryManagerDirty, editDirty]);

  const flattenedCategories = useMemo(
    () => flattenCategoryTree(categories),
    [categories],
  );
  const ensureCategoryAncestors = (categoryIds: string[]) => {
    const selected = new Set(categoryIds);
    categoryIds.forEach((categoryId) => {
      const category = flattenedCategories.find(
        (candidate) => candidate.id === categoryId,
      );
      [...(category?.ancestorIds ?? [])].forEach((ancestorId) =>
        selected.add(ancestorId),
      );
    });
    return [...selected];
  };
  const toggleCategorySelection = (
    categoryId: string,
    categoryIds: string[],
  ) => {
    const selected = new Set(categoryIds);
    if (selected.has(categoryId)) {
      flattenedCategories.forEach((category) => {
        if (
          category.id === categoryId ||
          category.ancestorIds?.includes(categoryId)
        ) {
          selected.delete(category.id);
        }
      });
    } else {
      const category = flattenedCategories.find(
        (candidate) => candidate.id === categoryId,
      );
      [...(category?.ancestorIds ?? [])].forEach((ancestorId) =>
        selected.add(ancestorId),
      );
      selected.add(categoryId);
    }
    return [...selected];
  };
  const visibleSidebarCategories = useMemo(
    () => categories.filter((category) => category.sidebarVisible),
    [categories],
  );
  const activeCategory = useMemo(
    () =>
      flattenedCategories.find((category) => category.id === activeScope) ??
      null,
    [activeScope, flattenedCategories],
  );

  const managerCategoriesByParent = useMemo(() => {
    const map = new Map<string | null, CategoryRecord[]>();
    categoryRecords.forEach((category) => {
      const siblings = map.get(category.parentId) ?? [];
      siblings.push(category);
      map.set(category.parentId, siblings);
    });
    return map;
  }, [categoryRecords]);

  const managerRootCategories = useMemo(
    () =>
      categoryRecords.filter(
        (category) =>
          !category.parentId ||
          !categoryRecords.some(
            (candidate) => candidate.id === category.parentId,
          ),
      ),
    [categoryRecords],
  );

  const managerCategoryMeta = useMemo(() => {
    const byId = new Map(
      categoryRecords.map((category) => [category.id, category]),
    );
    const result = new Map<
      string,
      { depth: number; path: string[]; ancestorIds: string[] }
    >();

    const resolve = (
      category: CategoryRecord,
      trail = new Set<string>(),
    ): { depth: number; path: string[]; ancestorIds: string[] } => {
      const cached = result.get(category.id);
      if (cached) return cached;
      if (
        !category.parentId ||
        !byId.has(category.parentId) ||
        trail.has(category.id)
      ) {
        const rootMeta = {
          depth: 0,
          path: [category.name],
          ancestorIds: [],
        };
        result.set(category.id, rootMeta);
        return rootMeta;
      }

      const nextTrail = new Set(trail);
      nextTrail.add(category.id);
      const parent = byId.get(category.parentId);
      if (!parent) {
        return { depth: 0, path: [category.name], ancestorIds: [] };
      }
      const parentMeta = resolve(parent, nextTrail);
      const meta = {
        depth: parentMeta.depth + 1,
        path: [...parentMeta.path, category.name],
        ancestorIds: [...parentMeta.ancestorIds, parent.id],
      };
      result.set(category.id, meta);
      return meta;
    };

    categoryRecords.forEach((category) => resolve(category));
    return result;
  }, [categoryRecords]);

  const managerSubtreeHeight = useMemo(() => {
    const heights = new Map<string, number>();
    const visit = (categoryId: string, trail = new Set<string>()): number => {
      const cached = heights.get(categoryId);
      if (cached !== undefined) return cached;
      if (trail.has(categoryId)) return 0;
      const nextTrail = new Set(trail);
      nextTrail.add(categoryId);
      const children = managerCategoriesByParent.get(categoryId) ?? [];
      const height = children.length
        ? 1 +
          Math.max(...children.map((child) => visit(child.id, nextTrail)))
        : 0;
      heights.set(categoryId, height);
      return height;
    };
    categoryRecords.forEach((category) => visit(category.id));
    return heights;
  }, [categoryRecords, managerCategoriesByParent]);

  const managerParentChoices = useMemo(
    () =>
      categoryRecords.filter(
        (category) =>
          (managerCategoryMeta.get(category.id)?.depth ?? 0) < 2,
      ),
    [categoryRecords, managerCategoryMeta],
  );

  const normalizedQuery = normalizeSearchText(query);

  const paperSearchMatches = useMemo(() => {
    const matches = new Map<string, PaperSearchMatch>();
    for (const paper of papers) {
      const categoryNames = flattenedCategories
        .filter((category) => paper.scopes.includes(category.id))
        .flatMap((category) => [
          category.name,
          category.path.join(" "),
        ]);
      matches.set(
        paper.id,
        matchPaperSearch(paper, query, { categoryNames }),
      );
    }
    return matches;
  }, [flattenedCategories, papers, query]);

  const scopeCounts = useMemo(() => {
    const papersMatchingActiveFilters = papers.filter((paper) =>
      paperMatchesNonScopeFilters(paper, {
        searchMatch: paperSearchMatches.get(paper.id)!,
        favoriteOnly,
        watchLaterOnly,
        codeOnly,
        projectOnly,
      }),
    );
    const counts: Record<string, number> = {
      all: papersMatchingActiveFilters.length,
      favorites: papers.filter(
        (paper) =>
          paper.favorite &&
          paperMatchesNonScopeFilters(paper, {
            searchMatch: paperSearchMatches.get(paper.id)!,
            favoriteOnly: false,
            watchLaterOnly,
            codeOnly,
            projectOnly,
          }),
      ).length,
      watchLater: papers.filter(
        (paper) =>
          paper.watchLater &&
          paperMatchesNonScopeFilters(paper, {
            searchMatch: paperSearchMatches.get(paper.id)!,
            favoriteOnly,
            watchLaterOnly: false,
            codeOnly,
            projectOnly,
          }),
      ).length,
      uncategorized: papersMatchingActiveFilters.filter((paper) =>
        paper.scopes.includes("uncategorized"),
      ).length,
    };

    flattenedCategories.forEach((category) => {
      counts[category.id] = papersMatchingActiveFilters.filter((paper) =>
        paper.scopes.includes(category.id),
      ).length;
    });

    return counts;
  }, [
    codeOnly,
    favoriteOnly,
    flattenedCategories,
    papers,
    paperSearchMatches,
    projectOnly,
    watchLaterOnly,
  ]);

  const filteredPapers = useMemo(() => {
    return [...papers]
      .filter((paper) => {
        const matchesScope =
          activeScope === "all"
            ? true
            : paper.scopes.includes(activeScope);

        return (
          matchesScope &&
          paperMatchesNonScopeFilters(paper, {
            searchMatch: paperSearchMatches.get(paper.id)!,
            favoriteOnly,
            watchLaterOnly,
            codeOnly,
            projectOnly,
          })
        );
      })
      .sort((a, b) => {
        if (normalizedQuery) {
          const relevance = comparePaperSearchMatches(
            paperSearchMatches.get(a.id),
            paperSearchMatches.get(b.id),
          );
          if (relevance) return relevance;
        }
        if (sortBy === "title") {
          return a.title.localeCompare(b.title);
        }
        if (sortBy === "oldest") {
          return a.dateAdded.localeCompare(b.dateAdded);
        }
        return b.dateAdded.localeCompare(a.dateAdded);
      });
  }, [
    activeScope,
    codeOnly,
    favoriteOnly,
    normalizedQuery,
    papers,
    paperSearchMatches,
    projectOnly,
    sortBy,
    watchLaterOnly,
  ]);

  const currentView = useMemo(() => {
    if (activeCategory) {
      return {
        name: activeCategory.name,
        outlineNumber: activeCategory.outlineNumber,
      };
    }
    if (activeScope === "uncategorized") {
      return { name: "未分类", outlineNumber: "" };
    }
    const activeMarks = [
      favoriteOnly ? "收藏" : "",
      watchLaterOnly ? "近期想看" : "",
    ].filter(Boolean);
    return {
      name: activeMarks.length ? activeMarks.join(" · ") : "全部论文",
      outlineNumber: "",
    };
  }, [
    activeCategory,
    activeScope,
    favoriteOnly,
    watchLaterOnly,
  ]);

  const quickNavigationCategories = useMemo(() => {
    if (activeCategory) return activeCategory.children ?? [];
    if (
      activeScope === "all" &&
      !favoriteOnly &&
      !watchLaterOnly
    ) {
      return categories;
    }
    return [];
  }, [
    activeCategory,
    activeScope,
    categories,
    favoriteOnly,
    watchLaterOnly,
  ]);

  const quickNavigationItems = useMemo(
    () =>
      quickNavigationCategories.map((category) => ({
        category,
        count: papers.filter(
          (paper) =>
            paper.scopes.includes(category.id) &&
            paperMatchesNonScopeFilters(paper, {
              searchMatch: paperSearchMatches.get(paper.id)!,
              favoriteOnly,
              watchLaterOnly,
              codeOnly,
              projectOnly,
            }),
        ).length,
      })),
    [
      codeOnly,
      favoriteOnly,
      papers,
      paperSearchMatches,
      projectOnly,
      quickNavigationCategories,
      watchLaterOnly,
    ],
  );

  const resultCount = filteredPapers.length;
  const activeFilterCount = [codeOnly, projectOnly].filter(Boolean).length;

  const selectScope = (scope: string) => {
    setActiveSurface("library");
    setActiveScope(scope);
    const selectedCategory = flattenedCategories.find(
      (category) => category.id === scope,
    );
    if (selectedCategory?.ancestorIds?.length) {
      setOpenCategories((current) => {
        const next = new Set(current);
        selectedCategory.ancestorIds?.forEach((id) => next.add(id));
        return next;
      });
    }
    setMobileNavOpen(false);
    setOpenMenu(null);
  };

  const resetLibraryView = () => {
    setActiveSurface("library");
    setActiveScope("all");
    setFavoriteOnly(false);
    setWatchLaterOnly(false);
    setMobileNavOpen(false);
    setOpenMenu(null);
  };

  const toggleSidebarVisibility = () => {
    if (isMobile) {
      setMobileNavOpen(true);
      return;
    }

    const nextCollapsed = !sidebarCollapsed;
    setSidebarCollapsed(nextCollapsed);
    setOpenMenu(null);
    try {
      window.localStorage.setItem(
        "literature-sidebar-collapsed",
        String(nextCollapsed),
      );
    } catch {
      // The setting still applies for the current page session.
    }
  };

  const toggleCategory = (id: string) => {
    setOpenCategories((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const applyBackupStatus = (backup?: BackupStatus) => {
    if (backup) setBackupStatus(backup);
  };

  const savedMessage = (message: string, backup?: BackupStatus) => {
    if (!backup) return message;
    return backup.ok
      ? `${message}，iCloud 已备份`
      : `${message}；iCloud 备份待重试`;
  };

  const replacePaper = (updatedPaper: Paper) => {
    setPapers((current) =>
      current.map((paper) =>
        paper.id === updatedPaper.id ? updatedPaper : paper,
      ),
    );
  };

  const patchPaper = async (
    id: string,
    changes: Partial<Paper> & { categoryIds?: string[] },
    successMessage: string,
  ) => {
    if (libraryConnection !== "ready") {
      setToast("本机数据库未连接，修改尚未保存");
      return null;
    }

    try {
      const response = await libraryRequest<PaperMutationResponse>(
        `/papers/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          body: JSON.stringify(changes),
        },
      );
      replacePaper(response.paper);
      applyBackupStatus(response.backup);
      setToast(savedMessage(successMessage, response.backup));
      return response.paper;
    } catch (error) {
      setToast(error instanceof Error ? error.message : "保存失败");
      return null;
    }
  };

  const archivePaperPdf = async (
    paper: Paper,
    { force = false, silent = false } = {},
  ) => {
    if (pdfActionBusyId === paper.id) return null;
    if (!safeExternalUrl(paper.pdfUrl)) {
      if (!silent) setToast("请先填写可访问的 PDF 来源链接");
      return null;
    }
    if (libraryConnection !== "ready") {
      if (!silent) setToast("本机数据库未连接，暂时无法保存 PDF");
      return null;
    }

    setPdfActionBusyId(paper.id);
    try {
      const response = await libraryRequest<PdfArchiveMutationResponse>(
        `/papers/${encodeURIComponent(paper.id)}/pdf/archive`,
        {
          method: "POST",
          body: JSON.stringify({ force }),
        },
      );
      replacePaper(response.paper);
      applyBackupStatus(response.backup);
      if (!silent && !response.alreadyArchived) {
        setToast(savedMessage("PDF 已保存到本地", response.backup));
      }
      return response.paper;
    } catch (error) {
      setToast(
        error instanceof Error ? error.message : "PDF 保存失败，请稍后重试",
      );
      return null;
    } finally {
      setPdfActionBusyId(null);
    }
  };

  const deleteLocalPdf = async (paper: Paper) => {
    if (pdfActionBusyId === paper.id) return;
    if (!window.confirm(`删除《${paper.title}》的本地 PDF 副本吗？`)) return;
    if (libraryConnection !== "ready") {
      setToast("本机数据库未连接，未删除本地 PDF");
      return;
    }

    setPdfActionBusyId(paper.id);
    try {
      const response = await libraryRequest<PaperMutationResponse>(
        `/papers/${encodeURIComponent(paper.id)}/pdf/archive`,
        { method: "DELETE" },
      );
      replacePaper(response.paper);
      applyBackupStatus(response.backup);
      setToast(savedMessage("本地 PDF 副本已删除", response.backup));
    } catch (error) {
      setToast(error instanceof Error ? error.message : "删除本地 PDF 失败");
    } finally {
      setPdfActionBusyId(null);
    }
  };

  const importLocalPdf = async (paper: Paper, file: File) => {
    if (pdfActionBusyId === paper.id) return;
    if (file.size > 200 * 1_024 * 1_024) {
      setToast("PDF 文件不能超过 200 MiB");
      return;
    }
    if (libraryConnection !== "ready") {
      setToast("本机数据库未连接，暂时无法导入 PDF");
      return;
    }

    setPdfActionBusyId(paper.id);
    try {
      const response = await libraryRequest<PaperMutationResponse>(
        `/papers/${encodeURIComponent(paper.id)}/pdf/import`,
        {
          method: "POST",
          headers: {
            "Content-Type": file.type || "application/pdf",
          },
          body: file,
        },
      );
      replacePaper(response.paper);
      applyBackupStatus(response.backup);
      setToast(savedMessage("PDF 已导入到本地", response.backup));
    } catch (error) {
      setToast(error instanceof Error ? error.message : "导入 PDF 失败");
    } finally {
      setPdfActionBusyId(null);
    }
  };

  const handlePdfImport = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file && editingPaper) {
      void importLocalPdf(editingPaper, file);
    }
  };

  const queuePdfArchive = (paper: Paper) => {
    if (
      paper.pdfArchive?.status === "ready" ||
      !safeExternalUrl(paper.pdfUrl) ||
      libraryConnection !== "ready"
    ) {
      return;
    }
    void archivePaperPdf(paper, { silent: true });
  };

  const toggleFavorite = async (id: string) => {
    const paper = papers.find((item) => item.id === id);
    if (!paper) return;
    await patchPaper(
      id,
      { favorite: !paper.favorite },
      paper.favorite ? "已取消收藏" : "已收藏",
    );
  };

  const toggleWatchLater = async (id: string) => {
    const paper = papers.find((item) => item.id === id);
    if (!paper) return;
    await patchPaper(
      id,
      { watchLater: !paper.watchLater },
      paper.watchLater ? "已移出近期想看" : "已加入近期想看",
    );
  };

  const analyzePaperReference = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (paperIntakeBusy || !paperReference.trim()) return;
    if (libraryConnection !== "ready") {
      setPaperIntakeError("本机数据库未连接，暂时无法分析论文。");
      return;
    }

    setPaperIntakeBusy(true);
    setPaperIntakeError("");
    setPaperIntakeResult(null);
    setPaperIntakeDraft(null);
    try {
      const response = await libraryRequest<PaperIntakeResponse>(
        "/paper-intake/analyze",
        {
          method: "POST",
          body: JSON.stringify({ reference: paperReference.trim() }),
        },
      );
      setPaperIntakeResult(response);
      if (response.status === "ready") {
        setPaperIntakeDraft({
          ...response.draft,
          categoryIds: ensureCategoryAncestors(response.draft.categoryIds),
          codeUrl: response.draft.codeUrl ?? "",
          codeProvider: response.draft.codeProvider ?? "",
          projectUrl: response.draft.projectUrl ?? "",
          projectProvider: response.draft.projectProvider ?? "",
        });
      }
    } catch (error) {
      setPaperIntakeError(
        error instanceof Error ? error.message : "论文分析失败，请重试。",
      );
    } finally {
      setPaperIntakeBusy(false);
    }
  };

  const updatePaperIntakeDraft = <K extends keyof PaperIntakeDraft>(
    field: K,
    value: PaperIntakeDraft[K],
  ) => {
    setPaperIntakeDraft((current) =>
      current ? { ...current, [field]: value } : current,
    );
  };

  const showDuplicatePaper = async (
    duplicate: PaperDuplicateMatch["paper"],
  ) => {
    if (paperDuplicateBusyId) return;
    if (duplicate.deletedAt) {
      setPaperDuplicateBusyId(duplicate.id);
      setPaperIntakeError("");
      try {
        const response = await libraryRequest<PaperMutationResponse>(
          `/papers/${encodeURIComponent(duplicate.id)}/restore`,
          { method: "POST" },
        );
        setPapers((current) => [
          response.paper,
          ...current.filter((paper) => paper.id !== response.paper.id),
        ]);
        applyBackupStatus(response.backup);
        setToast(savedMessage("论文已从最近删除中恢复", response.backup));
      } catch (error) {
        setPaperIntakeError(
          error instanceof Error ? error.message : "恢复论文失败。",
        );
        return;
      } finally {
        setPaperDuplicateBusyId(null);
      }
    } else {
      setToast("已定位到知识库中的论文");
    }
    setActiveScope("all");
    setFavoriteOnly(false);
    setWatchLaterOnly(false);
    setCodeOnly(false);
    setProjectOnly(false);
    setQuery(duplicate.title);
    setAddPaperOpen(false);
  };

  const addPaper = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (addingPaperRef.current) return;
    if (libraryConnection !== "ready") {
      setToast("本机数据库未连接，暂时无法添加论文");
      return;
    }

    if (!paperIntakeDraft?.title.trim()) {
      setPaperIntakeError("英文标题不能为空。");
      return;
    }

    const paper = {
      title: paperIntakeDraft.title.trim(),
      zhTitle: paperIntakeDraft.zhTitle.trim(),
      authors: paperIntakeDraft.authors.trim(),
      institution: paperIntakeDraft.institution.trim(),
      source: paperIntakeDraft.source.trim(),
      date: paperIntakeDraft.date.trim(),
      dateAdded: new Date().toISOString(),
      aiSummary: paperIntakeDraft.aiSummary.trim(),
      categoryIds: paperIntakeDraft.categoryIds,
      favorite: false,
      watchLater: false,
      hasPdf: Boolean(paperIntakeDraft.hasPdf && paperIntakeDraft.pdfUrl),
      pdfUrl:
        paperIntakeDraft.hasPdf && paperIntakeDraft.pdfUrl.trim()
          ? paperIntakeDraft.pdfUrl.trim()
          : undefined,
      originalUrl: paperIntakeDraft.originalUrl.trim() || undefined,
      codeUrl: paperIntakeDraft.codeUrl.trim() || undefined,
      codeProvider: paperIntakeDraft.codeUrl.trim()
        ? paperIntakeDraft.codeProvider || providerForUrl(paperIntakeDraft.codeUrl)
        : undefined,
      projectUrl: paperIntakeDraft.projectUrl.trim() || undefined,
      projectProvider: paperIntakeDraft.projectUrl.trim()
        ? paperIntakeDraft.projectProvider || "项目主页"
        : undefined,
      identifiers: paperIntakeDraft.identifiers,
    };

    addingPaperRef.current = true;
    setAddingPaper(true);
    try {
      const response = await libraryRequest<PaperMutationResponse>("/papers", {
        method: "POST",
        body: JSON.stringify(paper),
      });
      setPapers((current) => [response.paper, ...current]);
      applyBackupStatus(response.backup);
      setAddPaperOpen(false);
      setPaperReference("");
      setPaperIntakeResult(null);
      setPaperIntakeDraft(null);
      setPaperIntakeError("");
      setActiveScope("all");
      setToast(savedMessage("论文已添加", response.backup));
    } catch (error) {
      setPaperIntakeError(
        error instanceof Error ? error.message : "添加失败，请重试。",
      );
    } finally {
      addingPaperRef.current = false;
      setAddingPaper(false);
    }
  };

  const applyLibrarySnapshot = (library?: LibraryResponse) => {
    if (!library) return;
    const nextCategories = sanitizeCategoryTree(library.categories);
    setPapers(normalizePapers(library.papers));
    setCategories(nextCategories);
    setActiveScope((current) =>
      scopeIsInsideHiddenRoot(nextCategories, current) ? "all" : current,
    );
    applyBackupStatus(library.backup);
  };

  const applyRadarSnapshot = (
    response: RadarStateResponse,
    { syncSettings = false } = {},
  ) => {
    setRadarState(response);
    if (syncSettings) {
      setRadarPrompt(response.settings.prompt);
      setRadarCount(response.settings.requestedCount);
    }
    applyBackupStatus(response.backup);
  };

  const openLiteratureRadar = () => {
    setActiveSurface("radar");
    setMobileNavOpen(false);
    setOpenMenu(null);
    setFiltersOpen(false);
    setTextSizeOpen(false);
  };

  const closeRadarAiTrace = () => {
    setRadarAiTraceOpen(false);
    setRadarAiTraceError("");
  };

  const openRadarAiTrace = async () => {
    modalTriggerRef.current = document.activeElement as HTMLElement;
    setRadarAiTraceOpen(true);
    setRadarAiTraceLoading(true);
    setRadarAiTraceError("");
    try {
      const response = await libraryRequest<RadarAiTraceResponse>(
        "/radar/ai-trace",
      );
      setRadarAiTrace(response.trace);
    } catch (error) {
      setRadarAiTrace(null);
      setRadarAiTraceError(
        error instanceof Error ? error.message : "AI 记录读取失败。",
      );
    } finally {
      setRadarAiTraceLoading(false);
    }
  };

  const copyRadarAiText = async (value: string, label: string) => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(value);
      setToast(`${label}已复制`);
    } catch {
      setToast("复制失败，请手动选择文本复制");
    }
  };

  const copyCompleteRadarAiTrace = () => {
    if (!radarAiTrace) return;
    const text = radarAiTrace.exchanges
      .map(
        (exchange) =>
          `===== 第 ${exchange.round} 轮：发送给 AI 的完整提示词 =====\n${exchange.prompt}\n\n===== 第 ${exchange.round} 轮：AI 的完整回复 =====\n${exchange.response || "（AI 未返回文本）"}`,
      )
      .join("\n\n");
    void copyRadarAiText(text, "全部 AI 记录");
  };

  const runLiteratureRadar = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!radarPrompt.trim() || radarBusy) return;
    setRadarBusy(true);
    setRadarError("");
    try {
      const response = await libraryRequest<RadarStateResponse>("/radar/run", {
        method: "POST",
        body: JSON.stringify({ prompt: radarPrompt, count: radarCount }),
      });
      applyRadarSnapshot(response, { syncSettings: true });
      setRadarView("pending");
      const added = response.lastRun?.added ?? 0;
      const requested = response.lastRun?.requested ?? radarCount;
      setToast(
        response.lastRun?.insufficient
          ? `已找到 ${added} 篇不重复论文；没有用重复结果补足 ${requested} 篇`
          : `已推送 ${added} 篇不重复论文，等待审核`,
      );
    } catch (error) {
      setRadarError(
        error instanceof Error ? error.message : "文献检索失败，请重试。",
      );
    } finally {
      setRadarBusy(false);
    }
  };

  const changeRadarItem = async (
    item: RadarItem,
    action: "discard" | "restore",
  ) => {
    if (radarItemBusy) return;
    setRadarItemBusy(item.id);
    setRadarError("");
    try {
      const response = await libraryRequest<RadarStateResponse>(
        `/radar/items/${encodeURIComponent(item.id)}/${action}`,
        { method: "POST", body: "{}" },
      );
      applyRadarSnapshot(response);
      setToast(
        action === "discard"
          ? "已丢弃，并加入永久排除记录"
          : "已恢复到待审核列表",
      );
    } catch (error) {
      setRadarError(
        error instanceof Error ? error.message : "操作失败，请重试。",
      );
    } finally {
      setRadarItemBusy(null);
    }
  };

  const addRadarItem = async (item: RadarItem) => {
    if (radarItemBusy) return;
    setRadarItemBusy(item.id);
    setRadarError("");
    try {
      const response = await libraryRequest<RadarAddResponse>(
        `/radar/items/${encodeURIComponent(item.id)}/add`,
        { method: "POST", body: "{}" },
      );
      applyLibrarySnapshot(response.library);
      applyRadarSnapshot(response.radar);
      setToast("论文已加入知识库，后续检索将自动排除");
    } catch (error) {
      setRadarError(
        error instanceof Error ? error.message : "添加失败，请重试。",
      );
    } finally {
      setRadarItemBusy(null);
    }
  };

  const applyCategoryListResponse = (
    response: CategoriesResponse,
    paperSnapshot = papers,
  ) => {
    setCategoryRecords(
      normalizeCategoryRecords(response.categories, paperSnapshot),
    );
    const deletedRecords = response.deletedCategories ?? [];
    const normalizedDeleted = normalizeCategoryRecords(
      deletedRecords,
      paperSnapshot,
    ).map((category, index) => ({
      ...category,
      deletedAt: deletedRecords[index]?.deletedAt,
    }));
    setDeletedCategoryRecords(normalizedDeleted);
    applyBackupStatus(response.backup);
    applyLibrarySnapshot(response.library);
  };

  const loadCategoryManagerData = async (
    showLoading = false,
    paperSnapshot = papers,
  ) => {
    if (showLoading) setCategoryManagerLoading(true);
    try {
      const response =
        await libraryRequest<CategoriesResponse>("/categories");
      applyCategoryListResponse(
        response,
        response.library?.papers ?? paperSnapshot,
      );
      return true;
    } catch (error) {
      if (showLoading) {
        setToast(
          error instanceof Error ? error.message : "分类信息加载失败",
        );
      }
      return false;
    } finally {
      if (showLoading) setCategoryManagerLoading(false);
    }
  };

  const syncAfterCategoryMutation = async (
    response: CategoryMutationResponse,
  ) => {
    let nextPapers = response.library?.papers ?? papers;
    applyLibrarySnapshot(response.library);
    applyBackupStatus(response.backup);

    if (!response.library) {
      try {
        const library = await libraryRequest<LibraryResponse>("/library");
        nextPapers = library.papers;
        applyLibrarySnapshot(library);
      } catch {
        // The category mutation already succeeded; the drawer can refresh later.
      }
    }

    if (response.categories) {
      applyCategoryListResponse(
        {
          categories: response.categories,
          deletedCategories: response.deletedCategories,
          backup: response.backup,
        },
        nextPapers,
      );
      return;
    }
    await loadCategoryManagerData(false, nextPapers);
  };

  const validateCategoryName = (
    rawName: string,
    parentId: string | null,
    excludeId?: string,
  ) => {
    const name = rawName.trim();
    if (!name) return "请输入分类名称";
    if (name.length > 100) return "分类名称不能超过 100 个字符";
    if (name.includes("/")) return "分类名称不能包含 /";
    const duplicate = categoryRecords.some(
      (category) =>
        category.id !== excludeId &&
        category.parentId === parentId &&
        category.name.trim().localeCompare(name, "zh-CN", {
          sensitivity: "accent",
        }) === 0,
    );
    return duplicate ? "同一层级已经存在同名分类" : "";
  };

  const canPlaceCategoryUnder = (
    category: CategoryRecord,
    parentId: string | null,
  ) => {
    const subtreeHeight = managerSubtreeHeight.get(category.id) ?? 0;
    if (!parentId) return subtreeHeight <= 2;
    if (parentId === category.id) return false;
    const parentMeta = managerCategoryMeta.get(parentId);
    if (!parentMeta || parentMeta.depth >= 2) return false;
    if (parentMeta.ancestorIds.includes(category.id)) return false;
    return parentMeta.depth + 1 + subtreeHeight <= 2;
  };

  const managerMoveParentChoices = (category: CategoryRecord) =>
    managerParentChoices.filter(
      (parent) =>
        parent.id !== category.id &&
        canPlaceCategoryUnder(category, parent.id),
    );

  const clearCategoryInlineActions = () => {
    setCategoryCreateOpen(false);
    setNewCategoryName("");
    setNewCategoryParentId("");
    setRenamingCategoryId(null);
    setRenameCategoryName("");
    setMovingCategoryId(null);
    setMoveCategoryParentId("");
    setCategoryActionMenu(null);
    setCategoryInlineError("");
  };

  const focusCategoryManagerControl = (categoryId?: string) => {
    window.requestAnimationFrame(() => {
      if (categoryId) {
        const rowButton = document.querySelector<HTMLButtonElement>(
          `[data-category-menu="${categoryId}"]`,
        );
        if (rowButton) {
          rowButton.focus();
          return;
        }
      }
      modalRef.current
        ?.querySelector<HTMLButtonElement>("[data-category-add]")
        ?.focus();
    });
  };

  const cancelCategoryInlineAction = () => {
    const categoryId = renamingCategoryId ?? movingCategoryId ?? undefined;
    clearCategoryInlineActions();
    focusCategoryManagerControl(categoryId);
  };

  const closeCategoryManager = () => {
    setCategoryManagerOpen(false);
    setCategoryDeleteCandidate(null);
    setCategoryDiscardConfirmOpen(false);
    clearCategoryInlineActions();
  };

  const requestCloseCategoryManager = () => {
    if (categoryActionBusy) return;
    if (categoryManagerDirty) {
      setCategoryDiscardConfirmOpen(true);
      return;
    }
    closeCategoryManager();
  };

  const closeCategoryDiscardConfirm = () => {
    setCategoryDiscardConfirmOpen(false);
    window.requestAnimationFrame(() => {
      const activeFormControl =
        modalRef.current?.querySelector<HTMLElement>(
          ".category-create-panel input, .category-inline-form input, .category-inline-form select",
        );
      if (activeFormControl) {
        activeFormControl.focus();
        return;
      }
      focusCategoryManagerControl();
    });
  };

  const openCategoryManager = () => {
    modalTriggerRef.current = document.activeElement as HTMLElement;
    setCategoryManagerOpen(true);
    setMobileNavOpen(false);
    setFiltersOpen(false);
    setTextSizeOpen(false);
    setOpenMenu(null);
    void loadCategoryManagerData(true);
    window.requestAnimationFrame(() => {
      modalRef.current
        ?.querySelector<HTMLButtonElement>("[data-category-add]")
        ?.focus();
    });
  };

  const beginCreateCategory = () => {
    if (categoryManagerDirty) {
      setToast("请先保存或取消当前分类操作");
      return;
    }
    clearCategoryInlineActions();
    setCategoryCreateOpen(true);
  };

  const createManagedCategory = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    if (libraryConnection !== "ready") {
      setToast("本机数据库未连接，暂时无法创建分类");
      return;
    }
    const parentId = newCategoryParentId || null;
    if (
      parentId &&
      (managerCategoryMeta.get(parentId)?.depth ?? 2) >= 2
    ) {
      setCategoryInlineError("最多支持三级分类，请选择一级或二级分类作为上级");
      return;
    }
    const validationError = validateCategoryName(
      newCategoryName,
      parentId,
    );
    if (validationError) {
      setCategoryInlineError(validationError);
      return;
    }

    setCategoryActionBusy("create");
    try {
      const response = await libraryRequest<CategoryMutationResponse>(
        "/categories",
        {
          method: "POST",
          body: JSON.stringify({
            name: newCategoryName.trim(),
            parentId,
          }),
        },
      );
      setCategoryRecords((current) => [
        ...current,
        ...normalizeCategoryRecords([response.category], papers),
      ]);
      clearCategoryInlineActions();
      await syncAfterCategoryMutation(response);
      setToast(savedMessage("新分类已创建", response.backup));
      focusCategoryManagerControl(response.category.id);
    } catch (error) {
      setCategoryInlineError(
        error instanceof Error ? error.message : "创建分类失败",
      );
    } finally {
      setCategoryActionBusy(null);
    }
  };

  const beginRenameCategory = (category: CategoryRecord) => {
    if (categoryManagerDirty) {
      setToast("请先保存或取消当前分类操作");
      return;
    }
    clearCategoryInlineActions();
    setRenamingCategoryId(category.id);
    setRenameCategoryName(category.name);
  };

  const renameManagedCategory = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    if (!renamingCategory || libraryConnection !== "ready") return;
    const validationError = validateCategoryName(
      renameCategoryName,
      renamingCategory.parentId,
      renamingCategory.id,
    );
    if (validationError) {
      setCategoryInlineError(validationError);
      return;
    }
    if (renameCategoryName.trim() === renamingCategory.name.trim()) {
      clearCategoryInlineActions();
      return;
    }

    setCategoryActionBusy(renamingCategory.id);
    try {
      const response = await libraryRequest<CategoryMutationResponse>(
        `/categories/${encodeURIComponent(renamingCategory.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ name: renameCategoryName.trim() }),
        },
      );
      setCategoryRecords((current) =>
        current.map((category) =>
          category.id === renamingCategory.id
            ? { ...category, name: renameCategoryName.trim() }
            : category,
        ),
      );
      clearCategoryInlineActions();
      await syncAfterCategoryMutation(response);
      setToast(savedMessage("分类名称已更新", response.backup));
      focusCategoryManagerControl(renamingCategory.id);
    } catch (error) {
      setCategoryInlineError(
        error instanceof Error ? error.message : "重命名失败",
      );
    } finally {
      setCategoryActionBusy(null);
    }
  };

  const beginMoveCategory = (category: CategoryRecord) => {
    if (categoryManagerDirty) {
      setToast("请先保存或取消当前分类操作");
      return;
    }
    clearCategoryInlineActions();
    setMovingCategoryId(category.id);
    setMoveCategoryParentId(category.parentId ?? "");
  };

  const moveManagedCategory = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    if (!movingCategory || libraryConnection !== "ready") return;
    const parentId = moveCategoryParentId || null;
    if (parentId === movingCategory.parentId) {
      clearCategoryInlineActions();
      return;
    }
    if (!canPlaceCategoryUnder(movingCategory, parentId)) {
      setCategoryInlineError(
        "移动后会超过三级，或所选位置位于当前分类内部",
      );
      return;
    }

    setCategoryActionBusy(movingCategory.id);
    try {
      const response = await libraryRequest<CategoryMutationResponse>(
        `/categories/${encodeURIComponent(movingCategory.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ parentId }),
        },
      );
      setCategoryRecords((current) =>
        current.map((category) =>
          category.id === movingCategory.id
            ? { ...category, parentId }
            : category,
        ),
      );
      clearCategoryInlineActions();
      await syncAfterCategoryMutation(response);
      setToast(savedMessage("分类位置已更新", response.backup));
      focusCategoryManagerControl(movingCategory.id);
    } catch (error) {
      setCategoryInlineError(
        error instanceof Error ? error.message : "移动失败",
      );
    } finally {
      setCategoryActionBusy(null);
    }
  };

  const setManagedCategorySidebarVisibility = async (
    category: CategoryRecord,
    sidebarVisible: boolean,
  ) => {
    if (category.parentId !== null) return;
    if (libraryConnection !== "ready") {
      setToast("本机数据库未连接，侧栏设置尚未保存");
      return;
    }

    const activeMeta = managerCategoryMeta.get(activeScope);
    const hidesCurrentScope =
      !sidebarVisible &&
      (activeScope === category.id ||
        Boolean(activeMeta?.ancestorIds.includes(category.id)));

    setCategoryActionBusy(category.id);
    try {
      const response = await libraryRequest<CategoryMutationResponse>(
        `/categories/${encodeURIComponent(category.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ sidebarVisible }),
        },
      );
      setCategoryRecords((current) =>
        current.map((candidate) =>
          candidate.id === category.id
            ? { ...candidate, sidebarVisible }
            : candidate,
        ),
      );
      await syncAfterCategoryMutation(response);
      if (hidesCurrentScope) setActiveScope("all");
      setToast(
        savedMessage(
          sidebarVisible ? "已在侧栏显示" : "已从侧栏隐藏",
          response.backup,
        ),
      );
    } catch (error) {
      setToast(
        error instanceof Error ? error.message : "侧栏设置保存失败",
      );
    } finally {
      setCategoryActionBusy(null);
    }
  };

  const reorderCategorySiblings = async (
    parentId: string | null,
    orderedIds: string[],
    successMessage: string,
  ) => {
    if (libraryConnection !== "ready") {
      setToast("本机数据库未连接，分类顺序尚未保存");
      return;
    }
    if (categoryActionBusy) return;

    setCategoryActionBusy("reorder");
    try {
      const response = await libraryRequest<CategoryMutationResponse>(
        "/categories/reorder",
        {
          method: "PUT",
          body: JSON.stringify({ parentId, orderedIds }),
        },
      );
      await syncAfterCategoryMutation(response);
      setToast(savedMessage(successMessage, response.backup));
    } catch (error) {
      setToast(error instanceof Error ? error.message : "分类排序保存失败");
    } finally {
      setCategoryActionBusy(null);
    }
  };

  const moveManagedCategoryInOrder = async (
    category: CategoryRecord,
    direction: "up" | "down",
  ) => {
    const siblings = managerCategoriesByParent.get(category.parentId) ?? [];
    const currentIndex = siblings.findIndex(
      (candidate) => candidate.id === category.id,
    );
    const nextIndex = currentIndex + (direction === "up" ? -1 : 1);
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= siblings.length) {
      return;
    }

    const orderedIds = siblings.map((candidate) => candidate.id);
    [orderedIds[currentIndex], orderedIds[nextIndex]] = [
      orderedIds[nextIndex],
      orderedIds[currentIndex],
    ];
    setCategoryActionMenu(null);
    await reorderCategorySiblings(
      category.parentId,
      orderedIds,
      `已${direction === "up" ? "上移" : "下移"}“${category.name}”`,
    );
  };

  const beginSidebarCategoryDrag = (
    event: ReactDragEvent<HTMLButtonElement>,
    categoryId: string,
  ) => {
    if (categoryActionBusy) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", categoryId);
    setSidebarDraggedCategoryId(categoryId);
    setSidebarDropTarget(null);
  };

  const clearSidebarCategoryDrag = () => {
    setSidebarDraggedCategoryId(null);
    setSidebarDropTarget(null);
  };

  const updateSidebarCategoryDropTarget = (
    event: ReactDragEvent<HTMLDivElement>,
    category: Category,
    siblings: Category[],
  ) => {
    const draggedCategoryId = sidebarDraggedCategoryId;
    if (
      !draggedCategoryId ||
      draggedCategoryId === category.id ||
      !siblings.some((candidate) => candidate.id === draggedCategoryId)
    ) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const bounds = event.currentTarget.getBoundingClientRect();
    setSidebarDropTarget({
      id: category.id,
      placement:
        event.clientY - bounds.top > bounds.height / 2 ? "after" : "before",
    });
  };

  const dropSidebarCategory = (
    event: ReactDragEvent<HTMLDivElement>,
    category: Category,
    siblings: Category[],
  ) => {
    event.preventDefault();
    const draggedCategoryId = sidebarDraggedCategoryId;
    const target = sidebarDropTarget;
    clearSidebarCategoryDrag();
    if (
      !draggedCategoryId ||
      !target ||
      target.id !== category.id ||
      draggedCategoryId === category.id
    ) {
      return;
    }

    const orderedIds = siblings
      .map((candidate) => candidate.id)
      .filter((id) => id !== draggedCategoryId);
    const targetIndex = orderedIds.indexOf(category.id);
    if (targetIndex < 0) return;
    orderedIds.splice(
      targetIndex + (target.placement === "after" ? 1 : 0),
      0,
      draggedCategoryId,
    );
    const originalOrder = siblings.map((candidate) => candidate.id);
    if (orderedIds.every((id, index) => id === originalOrder[index])) return;
    void reorderCategorySiblings(
      category.ancestorIds?.[0] ?? null,
      orderedIds,
      "分类顺序已更新",
    );
  };

  const categoryOrphanCount = (categoryId: string) =>
    papers.filter((paper) => {
      const directCategoryIds = paper.categoryIds ?? [];
      return (
        directCategoryIds.includes(categoryId) &&
        directCategoryIds.every((id) => id === categoryId)
      );
    }).length;

  const deleteManagedCategory = async () => {
    const category = categoryDeleteCandidate;
    if (!category || category.childCount > 0) return;
    if (libraryConnection !== "ready") {
      setToast("本机数据库未连接，删除未执行");
      return;
    }

    setCategoryActionBusy(category.id);
    try {
      const response = await libraryRequest<CategoryMutationResponse>(
        `/categories/${encodeURIComponent(category.id)}`,
        {
          method: "DELETE",
          body: JSON.stringify({ paperPolicy: "detach" }),
        },
      );
      const deletedRecord: DeletedCategoryRecord = {
        ...category,
        deletedAt: new Date().toISOString(),
      };
      setCategoryRecords((current) =>
        current.filter((candidate) => candidate.id !== category.id),
      );
      setDeletedCategoryRecords((current) => [
        deletedRecord,
        ...current.filter((candidate) => candidate.id !== category.id),
      ]);
      if (activeScope === category.id) {
        setActiveScope(category.parentId ?? "all");
      }
      setCategoryDeleteCandidate(null);
      setCategoryActionMenu(null);
      setLastDeleted(null);
      setLastDeletedCategory(deletedRecord);
      await syncAfterCategoryMutation(response);
      setToast(savedMessage("分类已删除，论文仍保留", response.backup));
      focusCategoryManagerControl();
    } catch (error) {
      setToast(error instanceof Error ? error.message : "删除失败");
    } finally {
      setCategoryActionBusy(null);
    }
  };

  const restoreManagedCategory = async (
    category: DeletedCategoryRecord,
    fromUndo = false,
  ) => {
    if (libraryConnection !== "ready") {
      setToast("本机数据库未连接，恢复未执行");
      return;
    }
    setCategoryActionBusy(category.id);
    try {
      const response = await libraryRequest<CategoryMutationResponse>(
        `/categories/${encodeURIComponent(category.id)}/restore`,
        { method: "POST" },
      );
      setDeletedCategoryRecords((current) =>
        current.filter((candidate) => candidate.id !== category.id),
      );
      setCategoryRecords((current) => [
        ...current.filter((candidate) => candidate.id !== category.id),
        ...normalizeCategoryRecords([response.category], papers),
      ]);
      if (
        fromUndo ||
        lastDeletedCategory?.id === category.id
      ) {
        setLastDeletedCategory(null);
      }
      await syncAfterCategoryMutation(response);
      setToast(savedMessage("分类已恢复", response.backup));
      focusCategoryManagerControl();
    } catch (error) {
      setToast(
        error instanceof Error
          ? error.message
          : "恢复失败，请检查原位置是否有同名分类",
      );
    } finally {
      setCategoryActionBusy(null);
    }
  };

  const openEditPaper = (paper: Paper) => {
    const draft = draftFromPaper(paper);
    draft.selectedCategoryIds = ensureCategoryAncestors(
      draft.selectedCategoryIds,
    );
    modalTriggerRef.current =
      document.querySelector<HTMLButtonElement>(
        `[data-title-paper="${paper.id}"]`,
      ) ??
      document.querySelector<HTMLButtonElement>(
        `[data-paper-menu="${paper.id}"]`,
      ) ?? (document.activeElement as HTMLElement);
    setTitlePreviewPaperId(null);
    setEditBaseline(JSON.stringify(draft));
    setEditDraft(draft);
    setEditingPaperId(paper.id);
    setDiscardConfirmOpen(false);
    setOpenMenu(null);
    setFiltersOpen(false);
    setTextSizeOpen(false);
    setMobileNavOpen(false);
  };

  const closeEditor = () => {
    setEditingPaperId(null);
    setEditDraft(null);
    setDiscardConfirmOpen(false);
    setEditBaseline("");
  };

  const requestCloseEditor = () => {
    if (savingPaper) return;
    if (editDirty) {
      discardReturnFocusRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setDiscardConfirmOpen(true);
      return;
    }
    closeEditor();
  };

  const closeDiscardConfirm = () => {
    setDiscardConfirmOpen(false);
    window.requestAnimationFrame(() => {
      if (discardReturnFocusRef.current?.isConnected) {
        discardReturnFocusRef.current.focus();
        return;
      }
      editFormRef.current
        ?.querySelector<HTMLElement>("input, textarea, select, button")
        ?.focus();
    });
  };

  const updateEditDraft = <Key extends keyof PaperEditDraft>(
    key: Key,
    value: PaperEditDraft[Key],
  ) => {
    setEditDraft((current) =>
      current ? { ...current, [key]: value } : current,
    );
  };

  const toggleDraftCategory = (categoryId: string) => {
    if (!editDraft) return;
    updateEditDraft(
      "selectedCategoryIds",
      toggleCategorySelection(categoryId, editDraft.selectedCategoryIds),
    );
  };

  const saveEditedPaper = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingPaper || !editDraft || libraryConnection !== "ready") {
      setToast("本机数据库未连接，修改尚未保存");
      return;
    }

    const urls = [
      ["PDF", editDraft.pdfUrl],
      ["原文", editDraft.originalUrl],
      ["代码", editDraft.codeUrl],
      ["项目主页", editDraft.projectUrl],
    ] as const;
    const invalidResource = urls.find(
      ([, value]) => value.trim() && !safeExternalUrl(value.trim()),
    );
    if (invalidResource) {
      setToast(`${invalidResource[0]}链接需要使用 http:// 或 https://`);
      return;
    }

    setSavingPaper(true);
    try {
      const codeUrl =
        editDraft.hasCode && editDraft.codeUrl.trim()
          ? safeExternalUrl(editDraft.codeUrl.trim())
          : undefined;
      const projectUrl =
        editDraft.hasProject && editDraft.projectUrl.trim()
          ? safeExternalUrl(editDraft.projectUrl.trim())
          : undefined;
      const paperPatch: Record<string, unknown> = {
        title: editDraft.title.trim(),
        zhTitle: editDraft.zhTitle.trim(),
        authors: editDraft.authors.trim() || "作者未录入",
        institution: editDraft.institution.trim(),
        source: editDraft.source.trim() || "来源未录入",
        date: editDraft.date.trim() || "日期未录入",
        favorite: editDraft.favorite,
        watchLater: editDraft.watchLater,
        aiSummary: editDraft.aiSummary.trim(),
        note: editDraft.note.trim(),
        noteCount: editDraft.note.trim() ? 1 : 0,
        pdfUrl:
          editDraft.pdfUrl.trim()
            ? safeExternalUrl(editDraft.pdfUrl.trim())
            : null,
        originalUrl: editDraft.originalUrl.trim()
          ? safeExternalUrl(editDraft.originalUrl.trim())
          : null,
        codeUrl: codeUrl ?? null,
        codeProvider: editDraft.hasCode
          ? codeUrl
            ? providerForUrl(codeUrl)
            : editingPaper.codeProvider || "代码"
          : null,
        projectUrl: projectUrl ?? null,
        projectProvider: editDraft.hasProject
          ? editingPaper.projectProvider || "项目主页"
          : null,
      };
      if (
        !sameCategorySelection(
          editingPaper.categoryIds ?? [],
          editDraft.selectedCategoryIds,
        )
      ) {
        paperPatch.categoryIds = editDraft.selectedCategoryIds;
      }

      const response = await libraryRequest<PaperMutationResponse>(
        `/papers/${encodeURIComponent(editingPaper.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify(paperPatch),
        },
      );

      replacePaper(response.paper);
      applyBackupStatus(response.backup);
      setEditBaseline(JSON.stringify(draftFromPaper(response.paper)));
      setToast(savedMessage("论文修改已保存", response.backup));
      closeEditor();
    } catch (error) {
      setToast(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSavingPaper(false);
    }
  };

  const deletePaper = async (paper: Paper) => {
    setOpenMenu(null);
    if (
      !window.confirm(
        `确定删除《${paper.title}》吗？删除后可以在提示出现期间撤销。`,
      )
    ) {
      return;
    }
    if (libraryConnection !== "ready") {
      setToast("本机数据库未连接，删除未执行");
      return;
    }

    try {
      const response = await libraryRequest<PaperMutationResponse>(
        `/papers/${encodeURIComponent(paper.id)}`,
        { method: "DELETE" },
      );
      const index = papers.findIndex((item) => item.id === paper.id);
      setPapers((current) =>
        current.filter((item) => item.id !== paper.id),
      );
      setTitlePreviewPaperId((current) =>
        current === paper.id ? null : current,
      );
      setLastDeletedCategory(null);
      setLastDeleted({ paper: response.paper, index: Math.max(index, 0) });
      applyBackupStatus(response.backup);
      setToast("论文已删除");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "删除失败");
    }
  };

  const undoDelete = async () => {
    if (!lastDeleted) return;
    try {
      const response = await libraryRequest<PaperMutationResponse>(
        `/papers/${encodeURIComponent(lastDeleted.paper.id)}/restore`,
        { method: "POST" },
      );
      setPapers((current) => {
        const next = [...current];
        next.splice(
          Math.min(lastDeleted.index, next.length),
          0,
          response.paper,
        );
        return next;
      });
      applyBackupStatus(response.backup);
      setLastDeleted(null);
      setToast(savedMessage("删除已撤销", response.backup));
    } catch (error) {
      setToast(error instanceof Error ? error.message : "撤销失败");
    }
  };

  const removeFilter = (filter: "code" | "project") => {
    if (filter === "code") setCodeOnly(false);
    if (filter === "project") setProjectOnly(false);
  };

  const changeCardTextSize = (size: CardTextSize) => {
    setCardTextSize(size);
    setTextSizeOpen(false);
    try {
      window.localStorage.setItem("paper-card-text-size", size);
    } catch {
      // The setting still applies for the current page session.
    }
  };

  const changePaperViewMode = (mode: PaperViewMode) => {
    setPaperViewMode(mode);
    setTextSizeOpen(false);
    setOpenMenu(null);
    setTitlePreviewPaperId(null);
    try {
      window.localStorage.setItem("paper-view-mode", mode);
    } catch {
      // The setting still applies for the current page session.
    }
  };

  const openTitlePreview = (
    paperId: string,
    trigger: HTMLButtonElement,
  ) => {
    modalTriggerRef.current = trigger;
    setTitlePreviewPaperId(paperId);
    setOpenMenu(null);
    window.requestAnimationFrame(() => titlePreviewCloseRef.current?.focus());
  };

  const closeTitlePreview = () => {
    setTitlePreviewPaperId(null);
    setOpenMenu(null);
  };

  const applyAiSettings = (
    nextSettings: AiSettingsResponse,
    preferredConnectionId?: string | null,
  ) => {
    setAiSettings(nextSettings);
    const activeConnection = nextSettings.connections.find((connection) =>
      connection.models.some(
        (model) => model.id === nextSettings.activeModelId,
      ),
    );
    const requestedConnection = nextSettings.connections.find(
      (connection) =>
        connection.id ===
        (preferredConnectionId ?? aiSelectedConnectionId),
    );
    const nextConnection =
      requestedConnection ?? activeConnection ?? nextSettings.connections[0];
    if (nextConnection) {
      setAiSelectedConnectionId(nextConnection.id);
      setAiCreatingConnection(false);
      setAiDraftName(nextConnection.name);
      setAiDraftBaseUrl(nextConnection.baseUrl);
    } else {
      setAiSelectedConnectionId(null);
      setAiCreatingConnection(true);
      setAiDraftName("");
      setAiDraftBaseUrl("");
    }
    setAiDraftModel("");
    setAiKeyEntered(false);
  };

  const hasUnsavedAiSettings = () => {
    if (aiCreatingConnection) {
      return Boolean(
        aiDraftName.trim() ||
          aiDraftBaseUrl.trim() ||
          aiDraftModel.trim() ||
          aiKeyEntered,
      );
    }
    const selectedConnection = aiSettings?.connections.find(
      (connection) => connection.id === aiSelectedConnectionId,
    );
    if (!selectedConnection) return Boolean(aiDraftModel.trim() || aiKeyEntered);
    return Boolean(
      aiDraftName.trim() !== selectedConnection.name ||
        normalizeAiBaseUrlForComparison(aiDraftBaseUrl) !==
          normalizeAiBaseUrlForComparison(selectedConnection.baseUrl) ||
        aiDraftModel.trim() ||
        aiKeyEntered,
    );
  };

  const loadAiSettings = async () => {
    setAiSettingsLoading(true);
    setAiInlineError(null);
    try {
      applyAiSettings(
        await libraryRequest<AiSettingsResponse>("/ai/settings"),
      );
    } catch (error) {
      setAiInlineError({
        message:
          error instanceof Error ? error.message : "AI 设置加载失败",
      });
    } finally {
      setAiSettingsLoading(false);
    }
  };

  const openAiSettings = () => {
    modalTriggerRef.current = document.activeElement as HTMLElement;
    setAiSettingsOpen(true);
    setFiltersOpen(false);
    setTextSizeOpen(false);
    setOpenMenu(null);
    setAiKeyEntered(false);
    void loadAiSettings();
    window.requestAnimationFrame(() => {
      modalRef.current
        ?.querySelector<HTMLInputElement>("[data-ai-model]")
        ?.focus();
    });
  };

  const closeAiSettings = () => {
    if (aiBusyAction) return;
    if (
      hasUnsavedAiSettings() &&
      !window.confirm("放弃尚未保存的 AI 服务修改？")
    ) {
      return;
    }
    setAiSettingsOpen(false);
    setAiInlineError(null);
    setAiKeyEntered(false);
  };

  const selectAiConnection = (connection: AiConnectionSettings) => {
    if (aiBusyAction) return;
    if (
      connection.id !== aiSelectedConnectionId &&
      hasUnsavedAiSettings() &&
      !window.confirm("切换服务并放弃尚未保存的修改？")
    ) {
      return;
    }
    setAiSelectedConnectionId(connection.id);
    setAiCreatingConnection(false);
    setAiDraftName(connection.name);
    setAiDraftBaseUrl(connection.baseUrl);
    setAiDraftModel("");
    setAiKeyEntered(false);
    setAiInlineError(null);
  };

  const beginCreatingAiConnection = () => {
    if (aiBusyAction) return;
    if (aiCreatingConnection) return;
    if (
      !aiCreatingConnection &&
      hasUnsavedAiSettings() &&
      !window.confirm("添加新服务并放弃尚未保存的修改？")
    ) {
      return;
    }
    setAiSelectedConnectionId(null);
    setAiCreatingConnection(true);
    setAiDraftName("");
    setAiDraftBaseUrl("");
    setAiDraftModel("");
    setAiKeyEntered(false);
    setAiInlineError(null);
    window.requestAnimationFrame(() => {
      modalRef.current
        ?.querySelector<HTMLInputElement>("[data-ai-service-name]")
        ?.focus();
    });
  };

  const verifyAiModel = async (
    modelValue: string,
    { reverify = false }: { reverify?: boolean } = {},
  ) => {
    if (aiBusyAction) return;
    const model = modelValue.trim();
    const apiKey = aiKeyInputRef.current?.value.trim() ?? "";
    const connectionId = aiCreatingConnection
      ? null
      : aiSelectedConnectionId;
    setAiBusyAction(`verify:${connectionId ?? "new"}`);
    setAiInlineError(null);
    try {
      const response = await libraryRequest<AiVerificationResponse>(
        connectionId
          ? `/ai/connections/${encodeURIComponent(connectionId)}/models/verify`
          : "/ai/connections",
        {
          method: "POST",
          body: JSON.stringify({
            name: aiDraftName,
            baseUrl: aiDraftBaseUrl,
            model,
            ...(apiKey ? { apiKey } : {}),
            ...(reverify ? { reverify: true } : {}),
          }),
        },
      );
      if (aiKeyInputRef.current) aiKeyInputRef.current.value = "";
      applyAiSettings(
        response.settings,
        response.verification.connectionId,
      );
      applyBackupStatus(response.backup);
      setToast(
        `模型 ${response.verification.requestedModel} 已验证并保存`,
      );
    } catch (error) {
      setAiInlineError({
        ...(connectionId ? { connectionId } : {}),
        message: error instanceof Error ? error.message : "AI 验证失败",
      });
    } finally {
      setAiBusyAction(null);
    }
  };

  const submitAiModel = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (aiDuplicateMessage) return;
    void verifyAiModel(aiDraftModel);
  };

  const activateAiModel = async (modelId: string) => {
    if (aiBusyAction || modelId === aiSettings?.activeModelId) return;
    setAiBusyAction(`activate:${modelId}`);
    setAiInlineError(null);
    try {
      const response = await libraryRequest<AiSettingsMutationResponse>(
        `/ai/models/${encodeURIComponent(modelId)}/active`,
        { method: "PUT" },
      );
      applyAiSettings(response.settings, aiSelectedConnectionId);
      applyBackupStatus(response.backup);
      const selected = response.settings.connections
        .flatMap((connection) =>
          connection.models.map((model) => ({ connection, model })),
        )
        .find((item) => item.model.id === modelId);
      setToast(
        selected
          ? `已切换到 ${selected.connection.name} / ${selected.model.model}`
          : "当前模型已切换",
      );
    } catch (error) {
      setAiInlineError({
        message: error instanceof Error ? error.message : "切换失败",
      });
    } finally {
      setAiBusyAction(null);
    }
  };

  const removeAiModel = async (model: AiModelSettings) => {
    if (aiBusyAction) return;
    if (!window.confirm(`删除模型配置 ${model.model}？`)) return;
    setAiBusyAction(`delete-model:${model.id}`);
    setAiInlineError(null);
    try {
      const response = await libraryRequest<AiSettingsMutationResponse>(
        `/ai/models/${encodeURIComponent(model.id)}`,
        { method: "DELETE" },
      );
      applyAiSettings(response.settings, aiSelectedConnectionId);
      applyBackupStatus(response.backup);
      setToast(`模型 ${model.model} 已删除`);
    } catch (error) {
      setAiInlineError({
        ...(aiSelectedConnectionId
          ? { connectionId: aiSelectedConnectionId }
          : {}),
        message: error instanceof Error ? error.message : "模型删除失败",
      });
    } finally {
      setAiBusyAction(null);
    }
  };

  const removeAiConnection = async (connection: AiConnectionSettings) => {
    if (aiBusyAction) return;
    if (
      !window.confirm(
        `删除 ${connection.name}、其全部模型配置和钥匙串密钥？`,
      )
    ) {
      return;
    }
    setAiBusyAction(`delete-connection:${connection.id}`);
    setAiInlineError(null);
    try {
      const response = await libraryRequest<AiSettingsMutationResponse>(
        `/ai/connections/${encodeURIComponent(connection.id)}`,
        { method: "DELETE" },
      );
      applyAiSettings(response.settings, null);
      applyBackupStatus(response.backup);
      setToast(`${connection.name} 已删除`);
    } catch (error) {
      setAiInlineError({
        connectionId: connection.id,
        message: error instanceof Error ? error.message : "服务删除失败",
      });
    } finally {
      setAiBusyAction(null);
    }
  };

  const openAddPaperModal = () => {
    modalTriggerRef.current = document.activeElement as HTMLElement;
    setPaperReference("");
    setPaperIntakeResult(null);
    setPaperIntakeDraft(null);
    setPaperDuplicateBusyId(null);
    setPaperIntakeError("");
    setAddPaperOpen(true);
  };

  const handleModalKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const modal = modalRef.current;
    if (!modal) return;

    const focusable = Array.from(
      modal.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]',
      ),
    ).filter(
      (element) =>
        !element.closest("[inert]") &&
        element.getAttribute("aria-hidden") !== "true" &&
        element.offsetParent !== null,
    );
    if (!focusable.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const closeCategoryDeleteConfirm = () => {
    const categoryId = categoryDeleteCandidate?.id;
    setCategoryDeleteCandidate(null);
    window.requestAnimationFrame(() => {
      if (!categoryId) return;
      document
        .querySelector<HTMLButtonElement>(
          `[data-category-menu="${categoryId}"]`,
        )
        ?.focus();
    });
  };

  const renderManagedCategory = (
    category: CategoryRecord,
  ): ReactNode => {
    const children = managerCategoriesByParent.get(category.id) ?? [];
    const siblings = managerCategoriesByParent.get(category.parentId) ?? [];
    const siblingIndex = siblings.findIndex(
      (candidate) => candidate.id === category.id,
    );
    const isRenaming = renamingCategoryId === category.id;
    const isMoving = movingCategoryId === category.id;
    const isBusy = categoryActionBusy === category.id;
    const categoryDepth =
      managerCategoryMeta.get(category.id)?.depth ?? 0;
    const moveParentChoices = managerMoveParentChoices(category);
    const canMoveToRoot =
      category.parentId !== null && canPlaceCategoryUnder(category, null);
    const hasAlternativeParent = moveParentChoices.some(
      (parent) => parent.id !== category.parentId,
    );
    const cannotMove = !canMoveToRoot && !hasAlternativeParent;

    return (
      <div
        className={`managed-category-node managed-category-depth-${Math.min(
          categoryDepth,
          2,
        )}`}
        key={category.id}
      >
        <div className="managed-category-row">
          <div className="managed-category-identity">
            <strong>{category.name}</strong>
            <span>
              直接 {category.directCount} · 合计 {category.totalCount}
              </span>
            </div>
          <div className="managed-category-controls">
            {category.parentId === null && (
              <label className="category-visibility-check">
                <input
                  type="checkbox"
                  checked={category.sidebarVisible}
                  aria-label={`在侧栏显示“${category.name}”`}
                  onChange={(event) =>
                    void setManagedCategorySidebarVisibility(
                      category,
                      event.target.checked,
                    )
                  }
                  disabled={Boolean(categoryActionBusy)}
                />
                <span>侧栏显示</span>
              </label>
            )}
            <div className="category-quick-order-controls" aria-label={`调整“${category.name}”顺序`}>
              <button
                type="button"
                onClick={() => void moveManagedCategoryInOrder(category, "up")}
                disabled={siblingIndex <= 0 || Boolean(categoryActionBusy)}
                aria-label={`上移“${category.name}”`}
                title="上移"
              >
                <span aria-hidden="true">↑</span>
              </button>
              <button
                type="button"
                onClick={() =>
                  void moveManagedCategoryInOrder(category, "down")
                }
                disabled={
                  siblingIndex < 0 ||
                  siblingIndex >= siblings.length - 1 ||
                  Boolean(categoryActionBusy)
                }
                aria-label={`下移“${category.name}”`}
                title="下移"
              >
                <span aria-hidden="true">↓</span>
              </button>
            </div>
            <div className="category-action-anchor">
            <button
              type="button"
              className="category-row-menu-button"
              data-category-menu={category.id}
              onClick={() =>
                setCategoryActionMenu((current) =>
                  current === category.id ? null : category.id,
                )
              }
              aria-label={`管理分类“${category.name}”`}
              aria-expanded={categoryActionMenu === category.id}
              disabled={Boolean(categoryActionBusy)}
            >
              ···
            </button>
            {categoryActionMenu === category.id && (
              <div className="category-action-menu">
                <button
                  type="button"
                  onClick={() => beginRenameCategory(category)}
                >
                  重命名
                </button>
                <button
                  type="button"
                  onClick={() => beginMoveCategory(category)}
                  disabled={cannotMove}
                  title={
                    cannotMove
                      ? "没有符合三级层级限制的可移动位置"
                      : undefined
                  }
                >
                  移动
                </button>
                <button
                  type="button"
                  className="danger-menu-item"
                  onClick={() => {
                    setCategoryActionMenu(null);
                    setCategoryDeleteCandidate(category);
                  }}
                  disabled={category.childCount > 0}
                  title={
                    category.childCount > 0
                      ? "请先移动或删除全部子分类"
                      : undefined
                  }
                >
                  删除
                </button>
                {category.childCount > 0 && (
                  <p>
                    含 {category.childCount} 个子分类，需先处理子分类。
                  </p>
                )}
              </div>
            )}
            </div>
          </div>
        </div>

        {isRenaming && (
          <form
            className="category-inline-form"
            onSubmit={renameManagedCategory}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                cancelCategoryInlineAction();
              }
            }}
          >
            <label>
              <span>新名称</span>
              <input
                value={renameCategoryName}
                onChange={(event) => {
                  setRenameCategoryName(event.target.value);
                  setCategoryInlineError("");
                }}
                maxLength={100}
                autoFocus
                aria-describedby={
                  categoryInlineError
                    ? `category-error-${category.id}`
                    : undefined
                }
              />
            </label>
            {categoryInlineError && (
              <p
                className="category-inline-error"
                id={`category-error-${category.id}`}
                role="alert"
              >
                {categoryInlineError}
              </p>
            )}
            <div className="category-inline-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={cancelCategoryInlineAction}
              >
                取消
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={isBusy || !renameCategoryName.trim()}
              >
                {isBusy ? "保存中…" : "保存"}
              </button>
            </div>
          </form>
        )}

        {isMoving && (
          <form
            className="category-inline-form"
            onSubmit={moveManagedCategory}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                cancelCategoryInlineAction();
              }
            }}
          >
            <label>
              <span>新的上级分类</span>
              <select
                value={moveCategoryParentId}
                onChange={(event) => {
                  setMoveCategoryParentId(event.target.value);
                  setCategoryInlineError("");
                }}
                autoFocus
              >
                <option
                  value=""
                  disabled={!canPlaceCategoryUnder(category, null)}
                >
                  无，提升为一级分类
                </option>
                {moveParentChoices.map((parent) => (
                    <option value={parent.id} key={parent.id}>
                      {managerCategoryMeta
                        .get(parent.id)
                        ?.path.join(" › ") ?? parent.name}
                    </option>
                  ))}
              </select>
            </label>
            <p className="category-inline-hint">
              可移动到一级或二级分类下；最多保留三级。
            </p>
            {categoryInlineError && (
              <p className="category-inline-error" role="alert">
                {categoryInlineError}
              </p>
            )}
            <div className="category-inline-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={cancelCategoryInlineAction}
              >
                取消
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={
                  isBusy ||
                  moveCategoryParentId === (category.parentId ?? "")
                }
              >
                {isBusy ? "移动中…" : "确认移动"}
              </button>
            </div>
          </form>
        )}

        {children.length > 0 && (
          <div className="managed-category-children">
            {children.map((child) => renderManagedCategory(child))}
          </div>
        )}
      </div>
    );
  };

  const renderSidebarCategory = (
    category: Category,
    depth = 0,
    siblings: Category[] = [],
  ): ReactNode => {
    const children = category.children ?? [];
    const hasChildren = children.length > 0;
    const isExpanded =
      openCategories.has(category.id) ||
      Boolean(activeCategory?.ancestorIds?.includes(category.id));

    return (
      <div
        className={`category-node category-depth-${Math.min(depth, 2)} ${
          sidebarDraggedCategoryId === category.id ? "is-dragging" : ""
        } ${
          sidebarDropTarget?.id === category.id
            ? `is-drop-${sidebarDropTarget.placement}`
            : ""
        }`}
        key={category.id}
        onDragOver={(event) =>
          updateSidebarCategoryDropTarget(event, category, siblings)
        }
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) {
            setSidebarDropTarget((current) =>
              current?.id === category.id ? null : current,
            );
          }
        }}
        onDrop={(event) => dropSidebarCategory(event, category, siblings)}
      >
        <div className="category-row">
          <button
            type="button"
            className="category-drag-handle"
            draggable={!categoryActionBusy}
            onDragStart={(event) => beginSidebarCategoryDrag(event, category.id)}
            onDragEnd={clearSidebarCategoryDrag}
            aria-label={`拖动调整“${category.name}”的顺序`}
            title="拖动调整同级分类顺序"
            disabled={Boolean(categoryActionBusy)}
          >
            <span aria-hidden="true">⠿</span>
          </button>
          {hasChildren ? (
            <button
              type="button"
              className="tree-toggle"
              onClick={() => toggleCategory(category.id)}
              aria-label={`${isExpanded ? "折叠" : "展开"}${category.name}`}
              aria-expanded={isExpanded}
            >
              <span aria-hidden="true">{isExpanded ? "⌄" : "›"}</span>
            </button>
          ) : (
            <span className="tree-spacer" aria-hidden="true" />
          )}
          <button
            type="button"
            className={`nav-item category-link ${
              activeSurface === "library" && activeScope === category.id
                ? "is-active"
                : ""
            }`}
            onClick={() => selectScope(category.id)}
            aria-pressed={
              activeSurface === "library" && activeScope === category.id
            }
            title={category.name}
          >
            <span className="category-link-name">{category.name}</span>
            <span className="nav-count">
              {scopeCounts[category.id] ?? 0}
            </span>
          </button>
        </div>

        {hasChildren && isExpanded && (
          <div className="category-children">
            {children.map((child) =>
              renderSidebarCategory(child, depth + 1, children),
            )}
          </div>
        )}
      </div>
    );
  };

  const renderCategoryEditorCategory = (
    category: Category,
    depth = 0,
  ): ReactNode => (
    <div
      className={`category-editor-node category-editor-depth-${Math.min(
        depth,
        2,
      )}`}
      key={category.id}
    >
      <label
        className={`category-check ${
          depth === 0 ? "root-category-check" : ""
        }`}
      >
        <input
          type="checkbox"
          checked={Boolean(
            editDraft?.selectedCategoryIds.includes(category.id),
          )}
          onChange={() => toggleDraftCategory(category.id)}
        />
        <span>{category.name}</span>
      </label>
      {category.children?.length ? (
        <div className="category-editor-children">
          {category.children.map((child) =>
            renderCategoryEditorCategory(child, depth + 1),
          )}
        </div>
      ) : null}
    </div>
  );

  const selectedAiConnection =
    aiSettings?.connections.find(
      (connection) => connection.id === aiSelectedConnectionId,
    ) ?? null;
  const activeAiSelection = aiSettings?.connections
    .flatMap((connection) =>
      connection.models.map((model) => ({ connection, model })),
    )
    .find((item) => item.model.id === aiSettings.activeModelId);
  const aiBaseUrlChanged = Boolean(
    selectedAiConnection &&
      normalizeAiBaseUrlForComparison(aiDraftBaseUrl) !==
        normalizeAiBaseUrlForComparison(selectedAiConnection.baseUrl),
  );
  const duplicateAiConnection = aiSettings?.connections.find(
    (connection) =>
      connection.id !== selectedAiConnection?.id &&
      normalizeAiBaseUrlForComparison(connection.baseUrl) ===
        normalizeAiBaseUrlForComparison(aiDraftBaseUrl),
  );
  const duplicateAiModel =
    !aiCreatingConnection && !aiBaseUrlChanged
      ? selectedAiConnection?.models.find(
          (model) => model.model === aiDraftModel.trim(),
        )
      : undefined;
  const aiDuplicateMessage = duplicateAiConnection
    ? `这个 Base URL 已配置为“${duplicateAiConnection.name}”，请直接选择该服务。`
    : duplicateAiModel
      ? `模型 ${duplicateAiModel.model} 已存在；如需确认可用性，请点击上方“重新测试”。`
      : "";
  const aiConnectionNeedsKey = Boolean(
    aiCreatingConnection ||
      !selectedAiConnection?.configured ||
      aiBaseUrlChanged,
  );
  const aiConnectionSettingsDirty = Boolean(
    !aiCreatingConnection &&
      selectedAiConnection &&
      (aiDraftName.trim() !== selectedAiConnection.name ||
        aiBaseUrlChanged ||
        aiKeyEntered),
  );

  const saveAiConnectionSettings = async () => {
    if (
      aiBusyAction ||
      aiCreatingConnection ||
      !selectedAiConnection ||
      !aiConnectionSettingsDirty ||
      duplicateAiConnection
    ) {
      return;
    }

    if (aiBaseUrlChanged || aiKeyEntered) {
      const model =
        aiDraftModel.trim() ||
        selectedAiConnection.models.find((entry) => entry.active)?.model ||
        selectedAiConnection.models[0]?.model;
      if (!model) {
        setAiInlineError({
          connectionId: selectedAiConnection.id,
          message: "请先输入一个模型 ID，用它验证新的连接设置。",
        });
        window.requestAnimationFrame(() => {
          modalRef.current
            ?.querySelector<HTMLInputElement>("[data-ai-model]")
            ?.focus();
        });
        return;
      }
      await verifyAiModel(model, { reverify: true });
      return;
    }

    setAiBusyAction(`save-connection:${selectedAiConnection.id}`);
    setAiInlineError(null);
    try {
      const response = await libraryRequest<AiSettingsMutationResponse>(
        `/ai/connections/${encodeURIComponent(selectedAiConnection.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            name: aiDraftName,
            baseUrl: aiDraftBaseUrl,
          }),
        },
      );
      applyAiSettings(response.settings, selectedAiConnection.id);
      applyBackupStatus(response.backup);
      setToast("连接设置已保存");
    } catch (error) {
      setAiInlineError({
        connectionId: selectedAiConnection.id,
        message: error instanceof Error ? error.message : "连接设置保存失败",
      });
    } finally {
      setAiBusyAction(null);
    }
  };

  const aiConnectionSettingsPanel = (
    <details
      key={aiCreatingConnection ? "new-service" : aiSelectedConnectionId}
      className="ai-connection-settings"
      open={
        aiCreatingConnection || !selectedAiConnection?.configured || undefined
      }
    >
      <summary>
        <span>{aiCreatingConnection ? "服务信息" : "连接设置"}</span>
        <small>
          {aiCreatingConnection
            ? "名称、地址与密钥"
            : "Base URL 与 API Key"}
        </small>
      </summary>
      <div className="ai-connection-settings-body">
        <div className="ai-service-fields">
          <label className="ai-field">
            <span>
              服务名称 <small>留空时使用域名</small>
            </span>
            <input
              data-ai-service-name
              type="text"
              value={aiDraftName}
              onChange={(event) => {
                setAiDraftName(event.target.value);
                setAiInlineError(null);
              }}
              placeholder="例如：ergouzi.life"
              autoComplete="off"
              disabled={Boolean(aiBusyAction)}
            />
          </label>

          <label className="ai-field">
            <span>Base URL</span>
            <input
              type="url"
              value={aiDraftBaseUrl}
              onChange={(event) => {
                setAiDraftBaseUrl(event.target.value);
                setAiInlineError(null);
              }}
              placeholder="https://example.com/v1"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              disabled={Boolean(aiBusyAction)}
            />
          </label>
        </div>

        <label className="ai-field ai-key-field">
          <span>
            API Key
            {!aiConnectionNeedsKey && (
              <small>已安全保存，留空可继续使用</small>
            )}
          </span>
          <input
            ref={aiKeyInputRef}
            type="password"
            name="apiKey"
            placeholder={
              aiConnectionNeedsKey
                ? "输入 API Key"
                : "输入新 Key 可替换现有密钥"
            }
            autoComplete="new-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => {
              setAiKeyEntered(Boolean(event.currentTarget.value));
              setAiInlineError(null);
            }}
            required={aiConnectionNeedsKey}
            disabled={Boolean(aiBusyAction)}
          />
        </label>

        <p className="ai-credential-note">
          <span aria-hidden="true">⌁</span>
          API Key 只保存在 macOS 钥匙串，并发送至
          <strong>{formatAiBaseUrlHost(aiDraftBaseUrl)}</strong>。
          {aiBaseUrlChanged &&
            " 地址已更改，需要重新输入 API Key；验证成功后将替换原模型。"}
        </p>

        {!aiCreatingConnection && selectedAiConnection && (
          <div className="ai-connection-danger-zone">
            <button
              type="button"
              className="secondary-button ai-save-connection-button"
              onClick={() => void saveAiConnectionSettings()}
              disabled={
                Boolean(aiBusyAction) ||
                !aiConnectionSettingsDirty ||
                Boolean(duplicateAiConnection)
              }
            >
              {aiBusyAction?.startsWith("save-connection:")
                ? "保存中…"
                : aiBaseUrlChanged || aiKeyEntered
                  ? "保存并验证"
                  : "保存连接设置"}
            </button>
            <button
              type="button"
              className="ai-delete-button"
              onClick={() => void removeAiConnection(selectedAiConnection)}
              disabled={Boolean(aiBusyAction)}
            >
              删除此服务及其模型
            </button>
          </div>
        )}
      </div>
    </details>
  );

  const renderPaperCard = (paper: Paper) => {
    const paperSearchMatch = paperSearchMatches.get(paper.id);
    const directCategoryIds = new Set(
      paper.categoryIds ??
        paper.tags
          .map((tag) => tag.scope)
          .filter((scope) => scope !== "uncategorized"),
    );
    const selectedCategories = flattenedCategories.filter((category) =>
      directCategoryIds.has(category.id),
    );
    const terminalCategories = selectedCategories.filter(
      (category) =>
        !selectedCategories.some(
          (candidate) =>
            candidate.id !== category.id &&
            candidate.ancestorIds?.includes(category.id),
        ),
    );
    const representedCategoryIds = new Set<string>();
    const visiblePaths = terminalCategories.map((category) => {
      representedCategoryIds.add(category.id);
      category.ancestorIds?.forEach((ancestorId) =>
        representedCategoryIds.add(ancestorId),
      );
      return { category, path: category.path };
    });
    paper.tags.forEach((tag) => {
      if (!representedCategoryIds.has(tag.scope)) {
        visiblePaths.push({
          category: undefined,
          path: [tag.label],
        });
      }
    });
    const pdfUrl = safeExternalUrl(paper.pdfUrl);
    const pdfIsLocal = paper.pdfArchive?.status === "ready";
    const pdfActionBusy = pdfActionBusyId === paper.id;
    const pdfHref =
      libraryConnection === "ready"
        ? pdfOpenUrl(paper.id)
        : pdfUrl;
    const canOpenPdf = Boolean(pdfHref && (pdfIsLocal || pdfUrl));
    const pdfState = pdfIsLocal
      ? "✓"
      : pdfActionBusy
        ? "…"
        : paper.pdfArchive?.status === "failed"
          ? "!"
          : "↓";
    const pdfStatusLabel = pdfIsLocal
      ? "本地"
      : pdfActionBusy
        ? "保存中"
        : paper.pdfArchive?.status === "stale"
          ? "待更新"
          : paper.pdfArchive?.status === "failed"
            ? "重试"
            : "归档";
    const codeUrl = safeExternalUrl(paper.codeUrl);
    const projectUrl = safeExternalUrl(paper.projectUrl);
    const originalUrl = safeExternalUrl(paper.originalUrl);
    const displayAuthors = formatAuthorsForDisplay(paper.authors);
    const displayInstitution = formatInstitutionForDisplay(paper.institution);
    const fullAttribution = [
      paper.authors.trim() ? `完整作者：${paper.authors.trim()}` : "",
      paper.institution.trim() ? `完整机构：${paper.institution.trim()}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    return (
      <article className="paper-card" key={paper.id}>
        <div className="paper-card-top">
          <div className="paper-badges">
            {visiblePaths.map(({ category, path }, pathIndex) => (
              <span
                className={`category-path ${
                  category ? "category-path-root" : ""
                }`}
                key={`${category?.id ?? "tag"}:${path.join("/")}:${pathIndex}`}
                title={path.join(" > ")}
              >
                {path.map((segment, index) => (
                  <Fragment key={`${segment}:${index}`}>
                    {index > 0 && (
                      <span className="category-path-separator" aria-hidden="true">
                        →
                      </span>
                    )}
                    <span className="category-path-segment">{segment}</span>
                  </Fragment>
                ))}
              </span>
            ))}
          </div>

          <div className="paper-top-actions">
            <span className="paper-source">
              {formatPublicationForDisplay(paper.source, paper.date)}
            </span>
            <button
              type="button"
              className={`watch-later-button ${
                paper.watchLater ? "is-watching" : ""
              }`}
              onClick={() => toggleWatchLater(paper.id)}
              aria-label={
                paper.watchLater
                  ? "从近期想看中移除"
                  : "加入近期想看"
              }
              aria-pressed={paper.watchLater}
            >
              <svg
                className="watch-later-icon"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
              >
                <rect x="2.5" y="3.5" width="11" height="10" rx="2" />
                <path d="M5 2.5v2M11 2.5v2M2.5 6.5h11" />
                {paper.watchLater ? (
                  <path d="m5.2 10 1.7 1.6 3.9-3.8" />
                ) : (
                  <path d="M8 8v4M6 10h4" />
                )}
              </svg>
              <span>
                {paper.watchLater ? "近期想看" : "加入近期想看"}
              </span>
            </button>
            <button
              type="button"
              className={`star-button ${paper.favorite ? "is-favorite" : ""}`}
              onClick={() => toggleFavorite(paper.id)}
              aria-label={paper.favorite ? "取消收藏" : "收藏论文"}
              aria-pressed={paper.favorite}
            >
              {paper.favorite ? "★" : "☆"}
            </button>
            <div className="card-menu-anchor">
              <button
                className="more-button"
                data-paper-menu={paper.id}
                onClick={() =>
                  setOpenMenu((current) =>
                    current === paper.id ? null : paper.id,
                  )
                }
                aria-label="更多操作"
                aria-expanded={openMenu === paper.id}
              >
                ···
              </button>
              {openMenu === paper.id && (
                <div className="card-menu">
                  <button onClick={() => openEditPaper(paper)}>
                    编辑论文
                  </button>
                  <button
                    onClick={() => {
                      navigator.clipboard?.writeText(paper.title);
                      setToast("英文标题已复制");
                      setOpenMenu(null);
                    }}
                  >
                    复制英文标题
                  </button>
                  <button
                    className="danger-menu-item"
                    onClick={() => deletePaper(paper)}
                  >
                    删除论文
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="paper-title-block">
          <h2>{paper.title}</h2>
          {paper.zhTitle.trim() &&
            paper.zhTitle.trim() !== paper.title.trim() && (
              <p className="chinese-title">{paper.zhTitle.trim()}</p>
            )}
        </div>

        {(displayAuthors || displayInstitution) && (
          <p
            className="paper-authors"
            title={fullAttribution || undefined}
          >
            {displayAuthors}
            {displayAuthors && displayInstitution && (
              <span aria-hidden="true"> · </span>
            )}
            {displayInstitution}
          </p>
        )}

        {normalizedQuery && paperSearchMatch?.matchedFields.length ? (
          <p className="paper-search-match">
            匹配：
            {paperSearchMatch.matchedFields
              .slice(0, 3)
              .map((field) => paperSearchFieldLabels[field] ?? field)
              .join("、")}
          </p>
        ) : null}

        {paper.aiSummary.trim() && (
          <div className="summary-row">
            <span className="content-label">AI 总结</span>
            <p>{paper.aiSummary.trim()}</p>
          </div>
        )}

        {paper.note && (
          <div className="note-row">
            <span className="content-label note-label">
              我的笔记{paper.noteCount ? ` · ${paper.noteCount}` : ""}
            </span>
            <p>{paper.note}</p>
          </div>
        )}

        <footer className="paper-card-footer">
          <div className="resource-grid" aria-label="论文资源">
            {canOpenPdf ? (
              <a
                className="resource-slot is-available"
                href={pdfHref}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => queuePdfArchive(paper)}
                onAuxClick={(event) => {
                  if (event.button === 1) queuePdfArchive(paper);
                }}
                aria-label={
                  pdfIsLocal
                    ? `打开《${paper.title}》的本地 PDF`
                    : `打开《${paper.title}》的 PDF，并在后台保存到本地`
                }
              >
                <span className="resource-state" aria-hidden="true">
                  {pdfState}
                </span>
                <span>PDF</span>
                <small>{pdfStatusLabel}</small>
              </a>
            ) : paper.hasPdf ? (
              <button
                className="resource-slot is-available"
                onClick={() =>
                  setToast("已检测到 PDF，请在编辑页导入本地文件或补充来源链接")
                }
                aria-label={`《${paper.title}》有 PDF，尚无可访问的来源链接`}
              >
                <span className="resource-state" aria-hidden="true">✓</span>
                <span>PDF</span>
              </button>
            ) : (
              <div className="resource-slot is-missing" aria-label="暂无 PDF">
                <span className="resource-state" aria-hidden="true">—</span>
                <span>PDF</span>
              </div>
            )}

            {paper.codeProvider && codeUrl ? (
              <a
                className="resource-slot is-available"
                href={codeUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`打开《${paper.title}》的代码资源`}
              >
                <span className="resource-state" aria-hidden="true">✓</span>
                <span>代码</span>
                <small>{paper.codeProvider}</small>
              </a>
            ) : paper.codeProvider ? (
              <button
                className="resource-slot is-available"
                onClick={() => setToast("已标记有代码，尚未填写可访问链接")}
              >
                <span className="resource-state" aria-hidden="true">✓</span>
                <span>代码</span>
                <small>{paper.codeProvider}</small>
              </button>
            ) : (
              <div className="resource-slot is-missing" aria-label="暂无代码">
                <span className="resource-state" aria-hidden="true">—</span>
                <span>代码</span>
              </div>
            )}

            {paper.projectProvider && projectUrl ? (
              <a
                className="resource-slot is-available"
                href={projectUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`打开《${paper.title}》的项目主页`}
              >
                <span className="resource-state" aria-hidden="true">✓</span>
                <span>项目主页</span>
              </a>
            ) : paper.projectProvider ? (
              <button
                className="resource-slot is-available"
                onClick={() =>
                  setToast("已标记有项目主页，尚未填写可访问链接")
                }
              >
                <span className="resource-state" aria-hidden="true">✓</span>
                <span>项目主页</span>
              </button>
            ) : (
              <div
                className="resource-slot is-missing"
                aria-label="暂无项目主页"
              >
                <span className="resource-state" aria-hidden="true">—</span>
                <span>项目主页</span>
              </div>
            )}
          </div>

          {originalUrl ? (
            <a
              className="citation-button"
              href={originalUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`打开《${paper.title}》的原文页面`}
            >
              原文
            </a>
          ) : (
            <button
              className="citation-button"
              onClick={() => setToast(`查看《${paper.title}》的引用信息`)}
            >
              引用
            </button>
          )}
        </footer>
      </article>
    );
  };

  const visibleRadarItems =
    radarView === "pending"
      ? radarState?.pending ?? []
      : radarState?.discarded ?? [];
  const radarTotalExclusions = radarState
    ? radarState.counts.library +
      radarState.counts.pending +
      radarState.counts.discarded +
      radarState.counts.added
    : papers.length;

  const renderRadarItem = (item: RadarItem) => {
    const originalUrl = safeExternalUrl(item.originalUrl);
    const busy = radarItemBusy === item.id;
    const metadata = [
      item.authors,
      item.institution,
      item.source,
      item.date,
    ].filter(Boolean);
    return (
      <article className="radar-paper-card" key={item.id}>
        <header className="radar-paper-header">
          <div>
            <span className="radar-unique-badge">
              <span aria-hidden="true">✓</span>
              已通过知识库与历史记录排重
            </span>
            <h2>{item.title}</h2>
            {item.zhTitle && <p className="radar-paper-zh-title">{item.zhTitle}</p>}
          </div>
          {originalUrl && (
            <a
              className="radar-source-link"
              href={originalUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              查看原文 ↗
            </a>
          )}
        </header>

        {metadata.length > 0 && (
          <p className="radar-paper-meta">{metadata.join(" · ")}</p>
        )}

        {item.recommendationReason && (
          <div className="radar-reason">
            <span>推荐理由</span>
            <p>{item.recommendationReason}</p>
          </div>
        )}
        {item.aiSummary && (
          <div className="radar-summary">
            <span>AI 摘要</span>
            <p>{item.aiSummary}</p>
          </div>
        )}

        <footer className="radar-paper-footer">
          <div className="radar-identifiers" aria-label="排重标识">
            {item.identifiers
              .filter((identifier) => identifier.kind !== "url")
              .slice(0, 3)
              .map((identifier) => (
                <span key={`${identifier.kind}:${identifier.value}`}>
                  {identifier.kind.toUpperCase()} · {identifier.value}
                </span>
              ))}
          </div>
          <div className="radar-review-actions">
            {item.status === "discarded" ? (
              <button
                type="button"
                className="secondary-button"
                onClick={() => changeRadarItem(item, "restore")}
                disabled={Boolean(radarItemBusy)}
              >
                {busy ? "正在恢复…" : "恢复到待审核"}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="radar-discard-button"
                  onClick={() => changeRadarItem(item, "discard")}
                  disabled={Boolean(radarItemBusy)}
                >
                  {busy ? "处理中…" : "丢弃并不再推荐"}
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => addRadarItem(item)}
                  disabled={Boolean(radarItemBusy)}
                >
                  {busy ? "正在加入…" : "一键加入文献库"}
                </button>
              </>
            )}
          </div>
        </footer>
      </article>
    );
  };

  const renderRadarSurface = () => (
    <div className="radar-page">
      <section className="radar-hero" aria-labelledby="radar-title">
        <div>
          <span className="radar-eyebrow">AI 文献发现</span>
          <h1 id="radar-title">文献雷达</h1>
          <p>按你的研究范围联网检索；每篇论文先排重，再交给你决定加入或永久丢弃。</p>
        </div>
        <div className="radar-hero-stats" aria-label="排重范围">
          <span><strong>{radarState?.counts.library ?? papers.length}</strong> 知识库论文</span>
          <span><strong>{radarState?.counts.discarded ?? 0}</strong> 永久排除</span>
        </div>
      </section>

      <form className="radar-composer" onSubmit={runLiteratureRadar}>
        <div className="radar-composer-heading">
          <div>
            <h2>本次检索要求</h2>
            <p>提示词每次都可编辑；保存后将作为下一次默认值。</p>
          </div>
          <label className="radar-count-field">
            <span>推送数量</span>
            <input
              type="number"
              min={1}
              max={30}
              value={radarCount}
              onChange={(event) =>
                setRadarCount(Math.max(1, Math.min(30, Number(event.target.value) || 1)))
              }
              disabled={radarBusy}
            />
            <small>篇</small>
          </label>
        </div>
        <label className="radar-prompt-field">
          <span className="sr-only">文献检索提示词</span>
          <textarea
            value={radarPrompt}
            onChange={(event) => setRadarPrompt(event.target.value)}
            rows={5}
            maxLength={10_000}
            placeholder="例如：检索与多模态情感识别、微表情分析和生理信号融合相关的近期论文……"
            disabled={radarBusy}
          />
        </label>

        <div className="radar-system-context">
          <button
            type="button"
            onClick={() => setRadarContextOpen((current) => !current)}
            aria-expanded={radarContextOpen}
          >
            <span aria-hidden="true">⌁</span>
            系统排重上下文（只读）
            <strong>{radarTotalExclusions} 条</strong>
            <span aria-hidden="true">{radarContextOpen ? "⌃" : "⌄"}</span>
          </button>
          {radarContextOpen && (
            <div className="radar-context-detail">
              <p>
                AI 检索前会收到知识库与历史审核记录的标题、DOI、arXiv 和 URL 摘要；
                返回后，本机数据库还会对全部 {radarTotalExclusions} 条记录再次严格排重。
              </p>
              <dl>
                <div><dt>当前知识库</dt><dd>{radarState?.counts.library ?? papers.length}</dd></div>
                <div><dt>待审核</dt><dd>{radarState?.counts.pending ?? 0}</dd></div>
                <div><dt>已加入历史</dt><dd>{radarState?.counts.added ?? 0}</dd></div>
                <div><dt>已丢弃历史</dt><dd>{radarState?.counts.discarded ?? 0}</dd></div>
              </dl>
              {radarState?.context && (
                <small>
                  上次检索：AI 收到 {radarState.context.providedToAi} 条摘要，本机核查 {radarState.context.locallyChecked} 条。
                </small>
              )}
            </div>
          )}
        </div>

        {radarError && <p className="radar-error" role="alert">{radarError}</p>}
        <div className="radar-composer-actions">
          <p><span aria-hidden="true">✓</span> 数量不足时不会用重复论文补齐</p>
          <div className="radar-composer-buttons">
            <button
              type="button"
              className="secondary-button radar-trace-button"
              onClick={openRadarAiTrace}
            >
              <span aria-hidden="true">⌘</span>
              查看本次 AI 记录
            </button>
            <button
              type="submit"
              className="primary-button radar-run-button"
              disabled={radarBusy || !radarPrompt.trim()}
            >
              <span aria-hidden="true">✦</span>
              {radarBusy
                ? "正在联网检索并排重，最长约 20 分钟…"
                : "开始本次检索"}
            </button>
          </div>
        </div>
      </form>

      <section className="radar-review-section" aria-labelledby="radar-review-title">
        <div className="radar-review-heading">
          <div>
            <h2 id="radar-review-title">个人审核</h2>
            <p>加入或丢弃之前，不会改动你的知识库。</p>
          </div>
          <div className="radar-tabs" role="tablist" aria-label="文献雷达审核状态">
            <button
              type="button"
              role="tab"
              aria-selected={radarView === "pending"}
              className={radarView === "pending" ? "is-active" : ""}
              onClick={() => setRadarView("pending")}
            >
              待审核 <span>{radarState?.counts.pending ?? 0}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={radarView === "discarded"}
              className={radarView === "discarded" ? "is-active" : ""}
              onClick={() => setRadarView("discarded")}
            >
              已丢弃 <span>{radarState?.counts.discarded ?? 0}</span>
            </button>
          </div>
        </div>

        {visibleRadarItems.length ? (
          <div className="radar-paper-list">{visibleRadarItems.map(renderRadarItem)}</div>
        ) : (
          <div className="radar-empty-state">
            <span aria-hidden="true">✦</span>
            <h3>{radarView === "pending" ? "暂无待审核论文" : "暂无已丢弃论文"}</h3>
            <p>
              {radarView === "pending"
                ? "编辑上方提示词并开始检索，新的不重复论文会出现在这里。"
                : "你丢弃的论文会永久保留在排除记录中，并可随时恢复。"}
            </p>
          </div>
        )}
      </section>
    </div>
  );

  return (
    <div className="library-app">
      {isMobile && mobileNavOpen && (
        <button
          className="mobile-scrim is-visible"
          aria-label="关闭分类导航"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      <aside
        id="library-sidebar"
        ref={sidebarRef}
        className={`sidebar ${mobileNavOpen ? "is-open" : ""} ${
          !isMobile && sidebarCollapsed ? "is-collapsed" : ""
        }`}
        aria-label="文献库导航"
        aria-hidden={modalOpen || !sidebarExpanded || undefined}
        inert={modalOpen || !sidebarExpanded || undefined}
      >
        <div className="brand">
          <span className="brand-mark">文</span>
          <div>
            <p className="brand-name">我的文献库</p>
          </div>
        </div>

        <nav className="sidebar-nav">
          <div className="library-shortcuts" aria-label="文献范围与标记">
            <button
              className={`nav-item ${
                activeSurface === "library" &&
                activeScope === "all" &&
                !favoriteOnly &&
                !watchLaterOnly
                  ? "is-active"
                  : ""
              }`}
              onClick={resetLibraryView}
              aria-pressed={
                activeSurface === "library" &&
                activeScope === "all" &&
                !favoriteOnly &&
                !watchLaterOnly
              }
            >
              <span>全部论文</span>
              <span className="nav-count">{scopeCounts.all}</span>
            </button>
            <button
              className={`nav-item ${activeSurface === "library" && favoriteOnly ? "is-active" : ""}`}
              onClick={() => {
                setActiveSurface("library");
                setFavoriteOnly((current) => !current);
                setOpenMenu(null);
              }}
              aria-pressed={favoriteOnly}
              title="可与当前分类组合筛选"
            >
              <span>收藏</span>
              <span className="nav-count">{scopeCounts.favorites}</span>
            </button>
            <button
              className={`nav-item ${activeSurface === "library" && watchLaterOnly ? "is-active" : ""}`}
              onClick={() => {
                setActiveSurface("library");
                setWatchLaterOnly((current) => !current);
                setOpenMenu(null);
              }}
              aria-pressed={watchLaterOnly}
              title="可与当前分类组合筛选"
            >
              <span>近期想看</span>
              <span className="nav-count">{scopeCounts.watchLater}</span>
            </button>
            <button
              className={`nav-item radar-nav-item ${
                activeSurface === "radar" ? "is-active" : ""
              }`}
              onClick={openLiteratureRadar}
              aria-pressed={activeSurface === "radar"}
            >
              <span>
                <span className="radar-nav-symbol" aria-hidden="true">✦</span>
                文献雷达
              </span>
              <span className="nav-count">{radarState?.counts.pending ?? 0}</span>
            </button>
            <button
              className={`nav-item ${
                activeSurface === "library" && activeScope === "uncategorized"
                  ? "is-active"
                  : ""
              }`}
              onClick={() =>
                selectScope(
                  activeScope === "uncategorized" ? "all" : "uncategorized",
                )
              }
              aria-pressed={
                activeSurface === "library" && activeScope === "uncategorized"
              }
            >
              <span>未分类</span>
              <span className="nav-count">
                {scopeCounts.uncategorized}
              </span>
            </button>
          </div>

          <div className="nav-section-heading">
            <p className="nav-caption">分类</p>
            <button
              type="button"
              className="manage-categories-button"
              onClick={openCategoryManager}
            >
              管理
            </button>
          </div>
          <p className="category-order-hint">拖动分类左侧手柄可调整同级顺序</p>

          <div className="category-tree">
            {visibleSidebarCategories.length ? (
              visibleSidebarCategories.map((category) =>
                renderSidebarCategory(category, 0, visibleSidebarCategories),
              )
            ) : (
              <p className="category-tree-empty">
                暂无显示分类，可在“管理”中开启。
              </p>
            )}
          </div>

        </nav>
      </aside>

      <main
        className={`main-content ${
          !isMobile && sidebarCollapsed ? "is-sidebar-collapsed" : ""
        }`}
        aria-hidden={
          modalOpen || (isMobile && mobileNavOpen) || undefined
        }
        inert={modalOpen || (isMobile && mobileNavOpen) || undefined}
      >
        <header className="topbar">
          <button
            ref={mobileMenuRef}
            className="mobile-menu-button"
            onClick={toggleSidebarVisibility}
            aria-label={sidebarExpanded ? "隐藏侧边栏" : "显示侧边栏"}
            aria-controls="library-sidebar"
            aria-expanded={sidebarExpanded}
            title={sidebarExpanded ? "隐藏侧边栏" : "显示侧边栏"}
          >
            <span aria-hidden="true">
              {!isMobile && sidebarExpanded ? "‹" : "☰"}
            </span>
          </button>

          <label className="search-box">
            <span className="search-symbol" aria-hidden="true">
              ⌕
            </span>
            <span className="sr-only">搜索论文</span>
            <input
              ref={searchRef}
              type="search"
              placeholder="搜索题目、作者、机构、年份、来源或主题"
              value={query}
              onFocus={() => setActiveSurface("library")}
              onChange={(event) => {
                setActiveSurface("library");
                setQuery(event.target.value);
              }}
            />
            <kbd>⌘ K</kbd>
          </label>

          <div className="filter-anchor">
            <button
              className={`toolbar-button ${filtersOpen || activeFilterCount ? "is-engaged" : ""}`}
              onClick={() => {
                setActiveSurface("library");
                setFiltersOpen((current) => !current);
              }}
              aria-expanded={filtersOpen}
              aria-controls="filter-popover"
            >
              筛选
              {activeFilterCount > 0 && (
                <span className="filter-count">{activeFilterCount}</span>
              )}
            </button>

            {filtersOpen && (
              <div className="filter-popover" id="filter-popover">
                <div className="popover-heading">
                  <span>筛选论文</span>
                  <button
                    onClick={() => {
                      setCodeOnly(false);
                      setProjectOnly(false);
                    }}
                  >
                    清除
                  </button>
                </div>
                <label className="filter-option">
                  <input
                    type="checkbox"
                    checked={codeOnly}
                    onChange={(event) => setCodeOnly(event.target.checked)}
                  />
                  <span>有代码</span>
                </label>
                <label className="filter-option">
                  <input
                    type="checkbox"
                    checked={projectOnly}
                    onChange={(event) => setProjectOnly(event.target.checked)}
                  />
                  <span>有项目主页</span>
                </label>
              </div>
            )}
          </div>

          <label className="sort-control">
            <span className="sr-only">论文排序</span>
            <select
              value={normalizedQuery ? "relevance" : sortBy}
              onChange={(event) => {
                setActiveSurface("library");
                setSortBy(event.target.value);
              }}
              disabled={Boolean(normalizedQuery)}
            >
              {normalizedQuery && (
                <option value="relevance">相关度排序</option>
              )}
              <option value="recent">最近添加</option>
              <option value="oldest">最早添加</option>
              <option value="title">标题排序</option>
            </select>
          </label>

          <button
            type="button"
            className="toolbar-button ai-settings-button"
            onClick={openAiSettings}
            aria-haspopup="dialog"
          >
            <span className="ai-settings-symbol" aria-hidden="true">
              AI
            </span>
            AI 设置
          </button>

          <button
            className="primary-button"
            onClick={openAddPaperModal}
          >
            <span aria-hidden="true">＋</span>
            添加论文
          </button>
        </header>

        {activeSurface === "radar" ? (
          renderRadarSurface()
        ) : (
          <>
        <section
          className="view-overview"
          aria-labelledby="view-overview-title"
        >
          <h1 id="view-overview-title">
            {currentView.outlineNumber && (
              <span className="view-outline-number">
                {currentView.outlineNumber}
              </span>
            )}
            <span className="view-overview-name">{currentView.name}</span>
            <span className="view-overview-count" aria-live="polite">
              {resultCount} 篇
            </span>
          </h1>
        </section>

        {quickNavigationItems.length > 0 && (
          <nav className="quick-navigation" aria-label="分类快速导航">
            <h2>快速导航</h2>
            <div className="quick-navigation-list">
              {quickNavigationItems.map(({ category, count }) => (
                <button
                  type="button"
                  key={category.id}
                  onClick={() => selectScope(category.id)}
                  aria-label={`查看${category.name}，${count}篇论文`}
                >
                  <span>{category.name}</span>
                  <strong>{count}</strong>
                </button>
              ))}
            </div>
          </nav>
        )}

        <div className="results-toolbar">
          <div className="results-summary">
            <span
              className="storage-status"
              data-state={libraryConnection}
              title={backupStatus.message}
            >
              <span className="storage-status-dot" aria-hidden="true" />
              {libraryConnection === "connecting"
                ? "正在连接本机数据库"
                : libraryConnection === "unavailable"
                  ? "静态只读 · 数据库未连接"
                  : backupStatus.ok
                    ? `本机数据库 · iCloud ${formatBackupTime(backupStatus.lastBackupAt) || "已备份"}`
                    : "本机数据库 · iCloud 备份待重试"}
            </span>
          </div>

          <div className="results-actions">
            <div className="active-filters" aria-label="已启用筛选">
              {activeScope === "uncategorized" && (
                <button onClick={() => setActiveScope("all")}>
                  未分类 ×
                </button>
              )}
              {activeCategory && (
                <button onClick={() => setActiveScope("all")}>
                  分类：{activeCategory.path.join(" › ")} ×
                </button>
              )}
              {favoriteOnly && (
                <button onClick={() => setFavoriteOnly(false)}>
                  收藏 ×
                </button>
              )}
              {watchLaterOnly && (
                <button onClick={() => setWatchLaterOnly(false)}>
                  近期想看 ×
                </button>
              )}
              {codeOnly && (
                <button onClick={() => removeFilter("code")}>有代码 ×</button>
              )}
              {projectOnly && (
                <button onClick={() => removeFilter("project")}>
                  有项目主页 ×
                </button>
              )}
              {query && (
                <button onClick={() => setQuery("")}>“{query}” ×</button>
              )}
            </div>

            <div className="paper-view-switch" role="group" aria-label="论文展示方式">
              <button
                type="button"
                className={paperViewMode === "cards" ? "is-selected" : ""}
                onClick={() => changePaperViewMode("cards")}
                aria-pressed={paperViewMode === "cards"}
              >
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
                  <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
                  <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
                  <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
                </svg>
                <span>卡片</span>
              </button>
              <button
                type="button"
                className={paperViewMode === "titles" ? "is-selected" : ""}
                onClick={() => changePaperViewMode("titles")}
                aria-pressed={paperViewMode === "titles"}
              >
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M3 4h10M3 8h10M3 12h10" />
                </svg>
                <span>题目列表</span>
              </button>
            </div>

            {paperViewMode === "cards" && (
              <div className="text-size-anchor">
                <button
                  className="text-size-button"
                  onClick={() => setTextSizeOpen((current) => !current)}
                  aria-expanded={textSizeOpen}
                  aria-controls="text-size-popover"
                  aria-label={`调整论文卡片字号，当前为${cardTextSizeLabels[cardTextSize]}`}
                >
                  <span className="aa-mark" aria-hidden="true">
                    Aa
                  </span>
                  <span>{cardTextSizeLabels[cardTextSize]}</span>
                </button>

                {textSizeOpen && (
                  <div
                    className="text-size-popover"
                    id="text-size-popover"
                    role="group"
                    aria-label="卡片字号"
                  >
                    <div className="text-size-heading">
                      <span>卡片字号</span>
                      <small>仅影响论文卡片</small>
                    </div>
                    <div className="text-size-options">
                      {(
                        [
                          ["small", "小"],
                          ["standard", "标准"],
                          ["large", "大"],
                        ] as [CardTextSize, string][]
                      ).map(([size, label]) => (
                        <button
                          key={size}
                          className={cardTextSize === size ? "is-selected" : ""}
                          onClick={() => changeCardTextSize(size)}
                          aria-pressed={cardTextSize === size}
                        >
                          <span className={`size-sample size-sample-${size}`}>
                            A
                          </span>
                          <span>{label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {paperViewMode === "titles" && (
          <section className="paper-title-list" aria-label="论文题目列表">
            {filteredPapers.length > 0 && (
              <ul>
                {filteredPapers.map((paper) => (
                  <li key={paper.id}>
                    <button
                      type="button"
                      data-title-paper={paper.id}
                      onClick={(event) =>
                        openTitlePreview(paper.id, event.currentTarget)
                      }
                      aria-haspopup="dialog"
                    >
                      {paper.title}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {filteredPapers.length === 0 && (
              <div className="empty-state">
                <span className="empty-symbol">⌕</span>
                <h2>没有符合当前条件的论文</h2>
                <p>可以调整左侧分类、搜索词或顶部筛选条件。</p>
                <button
                  onClick={() => {
                    setActiveScope("all");
                    setFavoriteOnly(false);
                    setWatchLaterOnly(false);
                    setQuery("");
                    setCodeOnly(false);
                    setProjectOnly(false);
                  }}
                >
                  清除条件
                </button>
              </div>
            )}
          </section>
        )}

        {paperViewMode === "cards" && (
          <section
            className={`paper-list card-size-${cardTextSize}`}
            aria-label="论文列表"
          >
          {filteredPapers.map((paper) => renderPaperCard(paper))}

          {filteredPapers.length === 0 && (
            <div className="empty-state">
              <span className="empty-symbol">⌕</span>
              <h2>没有符合当前条件的论文</h2>
              <p>可以调整左侧分类、搜索词或顶部筛选条件。</p>
              <button
                onClick={() => {
                  setActiveScope("all");
                  setFavoriteOnly(false);
                  setWatchLaterOnly(false);
                  setQuery("");
                  setCodeOnly(false);
                  setProjectOnly(false);
                }}
              >
                清除条件
              </button>
            </div>
          )}
          </section>
        )}
          </>
        )}
      </main>

      {titlePreviewPaper &&
        createPortal(
          <div
            className="paper-preview-layer"
            role="dialog"
            aria-modal="true"
            aria-label={`论文详情：${titlePreviewPaper.title}`}
            onMouseDown={(event) => {
              if (event.currentTarget === event.target) closeTitlePreview();
            }}
          >
            <button
              ref={titlePreviewCloseRef}
              type="button"
              className="paper-preview-close"
              onClick={closeTitlePreview}
              aria-label="关闭论文卡片"
            >
              ×
            </button>
            <section
              className={`paper-list paper-preview-dialog card-size-${cardTextSize}`}
              aria-label="论文完整卡片"
            >
              {renderPaperCard(titlePreviewPaper)}
            </section>
          </div>,
          document.body,
        )}

      {categoryManagerOpen && (
        <div
          className="drawer-layer"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target)
              requestCloseCategoryManager();
          }}
        >
          <section
            ref={modalRef}
            className="edit-drawer category-manager-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="category-manager-title"
            aria-describedby="category-manager-description"
            aria-busy={Boolean(categoryActionBusy)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                if (categoryDiscardConfirmOpen) {
                  closeCategoryDiscardConfirm();
                } else if (categoryDeleteCandidate) {
                  closeCategoryDeleteConfirm();
                } else {
                  requestCloseCategoryManager();
                }
                return;
              }
              handleModalKeyDown(event);
            }}
          >
            <div
              className="category-manager-shell"
              inert={
                categoryDiscardConfirmOpen ||
                Boolean(categoryDeleteCandidate) ||
                undefined
              }
            >
              <header className="edit-drawer-header category-manager-header">
                <div>
                  <h2 id="category-manager-title">分类管理</h2>
                  <p id="category-manager-description">
                    修改分类本身；论文所属分类仍在论文编辑中调整。
                  </p>
                </div>
                <div className="category-manager-header-actions">
                  <button
                    type="button"
                    className="secondary-button category-add-button"
                    data-category-add
                    onClick={beginCreateCategory}
                    disabled={
                      Boolean(categoryActionBusy) || categoryCreateOpen
                    }
                  >
                    <span aria-hidden="true">＋</span>
                    新建分类
                  </button>
                  <button
                    type="button"
                    className="drawer-close"
                    onClick={requestCloseCategoryManager}
                    aria-label="关闭分类管理"
                  >
                    ×
                  </button>
                </div>
              </header>

              <div className="category-manager-body">
                {categoryCreateOpen && (
                  <form
                    className="category-create-panel"
                    onSubmit={createManagedCategory}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        cancelCategoryInlineAction();
                      }
                    }}
                  >
                    <div className="category-create-heading">
                      <div>
                        <strong>新建分类</strong>
                        <span>可创建一级、二级或三级分类</span>
                      </div>
                      <button
                        type="button"
                        onClick={cancelCategoryInlineAction}
                        aria-label="取消新建分类"
                      >
                        ×
                      </button>
                    </div>
                    <label>
                      <span>分类名称</span>
                      <input
                        value={newCategoryName}
                        onChange={(event) => {
                          setNewCategoryName(event.target.value);
                          setCategoryInlineError("");
                        }}
                        placeholder="例如：神经渲染"
                        maxLength={100}
                        required
                        autoFocus
                        aria-describedby={
                          categoryInlineError
                            ? "new-category-error"
                            : "new-category-hint"
                        }
                      />
                    </label>
                    <label>
                      <span>上级分类</span>
                      <select
                        value={newCategoryParentId}
                        onChange={(event) => {
                          setNewCategoryParentId(event.target.value);
                          setCategoryInlineError("");
                        }}
                      >
                        <option value="">无，作为一级分类</option>
                        {managerParentChoices.map((category) => (
                          <option value={category.id} key={category.id}>
                            {managerCategoryMeta
                              .get(category.id)
                              ?.path.join(" › ") ?? category.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p className="category-inline-hint" id="new-category-hint">
                      最多支持三级分类；名称不能包含 /。
                    </p>
                    {categoryInlineError && (
                      <p
                        className="category-inline-error"
                        id="new-category-error"
                        role="alert"
                      >
                        {categoryInlineError}
                      </p>
                    )}
                    <div className="category-inline-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={cancelCategoryInlineAction}
                      >
                        取消
                      </button>
                      <button
                        type="submit"
                        className="primary-button"
                        disabled={
                          categoryActionBusy === "create" ||
                          !newCategoryName.trim()
                        }
                      >
                        {categoryActionBusy === "create"
                          ? "创建中…"
                          : "创建分类"}
                      </button>
                    </div>
                  </form>
                )}

                <div className="category-manager-summary">
                  <span>{categoryRecords.length} 个分类</span>
                  <small>直接：直属论文 · 合计：包含子分类</small>
                </div>

                {categoryManagerLoading ? (
                  <div className="category-manager-loading" role="status">
                    正在读取分类…
                  </div>
                ) : managerRootCategories.length ? (
                  <div
                    className="managed-category-list"
                    aria-label="现有分类"
                  >
                    {managerRootCategories.map((category) =>
                      renderManagedCategory(category),
                    )}
                  </div>
                ) : (
                  <div className="category-manager-empty">
                    <strong>还没有分类</strong>
                    <span>点击“新建分类”开始整理文献。</span>
                  </div>
                )}

                <details className="deleted-categories">
                  <summary>
                    <span>最近删除</span>
                    <span>{deletedCategoryRecords.length}</span>
                  </summary>
                  {deletedCategoryRecords.length ? (
                    <div className="deleted-category-list">
                      {deletedCategoryRecords.map((category) => {
                        const parent = [
                          ...categoryRecords,
                          ...deletedCategoryRecords,
                        ].find(
                          (candidate) =>
                            candidate.id === category.parentId,
                        );
                        return (
                          <div
                            className="deleted-category-row"
                            key={category.id}
                          >
                            <div>
                              <strong>{category.name}</strong>
                              <span>
                                {parent
                                  ? `原位置：${
                                      managerCategoryMeta
                                        .get(parent.id)
                                        ?.path.join(" › ") ?? parent.name
                                    } · `
                                  : ""}
                                {category.directCount} 篇直属论文
                              </span>
                            </div>
                            <button
                              type="button"
                              className="secondary-button"
                              onClick={() =>
                                restoreManagedCategory(category)
                              }
                              disabled={categoryActionBusy === category.id}
                            >
                              {categoryActionBusy === category.id
                                ? "恢复中…"
                                : "恢复"}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="deleted-category-empty">
                      暂无可恢复的分类。
                    </p>
                  )}
                </details>
              </div>

              <footer className="category-manager-footer">
                <span>所有操作立即保存，并自动创建 iCloud 备份。</span>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={requestCloseCategoryManager}
                  disabled={Boolean(categoryActionBusy)}
                >
                  完成
                </button>
              </footer>
            </div>

            {categoryDeleteCandidate && (
              <div className="discard-confirm-layer">
                <section
                  className="discard-confirm category-delete-confirm"
                  role="alertdialog"
                  aria-modal="true"
                  aria-labelledby="category-delete-title"
                  aria-describedby="category-delete-description"
                >
                  <h3 id="category-delete-title">删除这个分类？</h3>
                  <p id="category-delete-description">
                    “{categoryDeleteCandidate.name}”直接关联{" "}
                    {categoryDeleteCandidate.directCount} 篇论文。删除不会删除论文；
                    {categoryOrphanCount(categoryDeleteCandidate.id)} 篇没有其他分类的论文将进入“未分类”。
                  </p>
                  <p className="category-delete-note">
                    分类会进入“最近删除”，之后仍可恢复。
                  </p>
                  <div className="discard-confirm-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={closeCategoryDeleteConfirm}
                      autoFocus
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="danger-button"
                      onClick={deleteManagedCategory}
                      disabled={Boolean(categoryActionBusy)}
                    >
                      {categoryActionBusy
                        ? "删除中…"
                        : "仅删除分类"}
                    </button>
                  </div>
                </section>
              </div>
            )}

            {categoryDiscardConfirmOpen && (
              <div className="discard-confirm-layer">
                <section
                  className="discard-confirm"
                  role="alertdialog"
                  aria-modal="true"
                  aria-labelledby="category-discard-title"
                  aria-describedby="category-discard-description"
                >
                  <h3 id="category-discard-title">
                    放弃未保存的分类修改？
                  </h3>
                  <p id="category-discard-description">
                    当前正在填写的名称或移动位置尚未保存。
                  </p>
                  <div className="discard-confirm-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={closeCategoryDiscardConfirm}
                      autoFocus
                    >
                      继续编辑
                    </button>
                    <button
                      type="button"
                      className="danger-button"
                      onClick={closeCategoryManager}
                    >
                      放弃并关闭
                    </button>
                  </div>
                </section>
              </div>
            )}
          </section>
        </div>
      )}

      {editingPaper && editDraft && (
        <div
          className="drawer-layer"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) requestCloseEditor();
          }}
        >
          <section
            ref={modalRef}
            className="edit-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-paper-title"
            aria-describedby="edit-paper-description"
            aria-busy={savingPaper}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                if (discardConfirmOpen) closeDiscardConfirm();
                else requestCloseEditor();
                return;
              }
              handleModalKeyDown(event);
            }}
          >
            <form
              ref={editFormRef}
              className="edit-drawer-form"
              onSubmit={saveEditedPaper}
              onKeyDown={(event) => {
                if (
                  (event.metaKey || event.ctrlKey) &&
                  (event.key.toLowerCase() === "s" || event.key === "Enter")
                ) {
                  event.preventDefault();
                  event.currentTarget.requestSubmit();
                }
              }}
              inert={discardConfirmOpen || undefined}
            >
              <header className="edit-drawer-header">
                <div>
                  <h2 id="edit-paper-title">编辑论文</h2>
                  <p id="edit-paper-description">
                    修改会保存到本机数据库，并生成 iCloud 备份。
                  </p>
                </div>
                <button
                  type="button"
                  className="drawer-close"
                  onClick={requestCloseEditor}
                  aria-label="关闭论文编辑"
                >
                  ×
                </button>
              </header>

              <div className="edit-drawer-body">
                <fieldset className="edit-section">
                  <legend>基本信息</legend>
                  <label className="edit-field edit-field-wide">
                    <span>英文标题</span>
                    <textarea
                      value={editDraft.title}
                      onChange={(event) =>
                        updateEditDraft("title", event.target.value)
                      }
                      rows={2}
                      required
                      autoFocus
                    />
                  </label>
                  <label className="edit-field edit-field-wide">
                    <span>中文标题</span>
                    <textarea
                      value={editDraft.zhTitle}
                      onChange={(event) =>
                        updateEditDraft("zhTitle", event.target.value)
                      }
                      rows={2}
                      placeholder="可留空"
                    />
                  </label>
                  <label className="edit-field edit-field-wide">
                    <span>作者</span>
                    <input
                      value={editDraft.authors}
                      onChange={(event) =>
                        updateEditDraft("authors", event.target.value)
                      }
                    />
                  </label>
                  <label className="edit-field edit-field-wide">
                    <span>机构</span>
                    <input
                      value={editDraft.institution}
                      onChange={(event) =>
                        updateEditDraft("institution", event.target.value)
                      }
                      placeholder="可留空"
                    />
                  </label>
                  <div className="edit-field-grid">
                    <label className="edit-field">
                      <span>来源</span>
                      <input
                        value={editDraft.source}
                        onChange={(event) =>
                          updateEditDraft("source", event.target.value)
                        }
                      />
                    </label>
                    <label className="edit-field">
                      <span>发表日期</span>
                      <input
                        value={editDraft.date}
                        onChange={(event) =>
                          updateEditDraft("date", event.target.value)
                        }
                        placeholder="YYYY-MM-DD"
                      />
                    </label>
                  </div>
                </fieldset>

                <fieldset className="edit-section">
                  <legend>标记与分类</legend>
                  <div className="paper-flags-editor">
                    <label
                      className={
                        editDraft.favorite ? "is-selected" : ""
                      }
                    >
                      <input
                        type="checkbox"
                        checked={editDraft.favorite}
                        onChange={(event) =>
                          updateEditDraft("favorite", event.target.checked)
                        }
                      />
                      <span>
                        <strong>收藏</strong>
                        <small>保留为重要论文</small>
                      </span>
                    </label>
                    <label
                      className={
                        editDraft.watchLater ? "is-selected" : ""
                      }
                    >
                      <input
                        type="checkbox"
                        checked={editDraft.watchLater}
                        onChange={(event) =>
                          updateEditDraft(
                            "watchLater",
                            event.target.checked,
                          )
                        }
                      />
                      <span>
                        <strong>近期想看</strong>
                        <small>加入近期计划阅读的论文清单</small>
                      </span>
                    </label>
                  </div>

                  <div className="category-editor">
                    {categories.map((category) =>
                      renderCategoryEditorCategory(category),
                    )}
                  </div>
                  <p className="edit-hint">
                    可以选择多个分类；全部取消时归入“未分类”。
                  </p>
                </fieldset>

                <fieldset className="edit-section">
                  <legend>内容沉淀</legend>
                  <label className="edit-field edit-field-wide">
                    <span>AI 总结</span>
                    <textarea
                      value={editDraft.aiSummary}
                      onChange={(event) =>
                        updateEditDraft("aiSummary", event.target.value)
                      }
                      rows={5}
                      placeholder="暂未生成，可手动填写"
                    />
                  </label>
                  <label className="edit-field edit-field-wide">
                    <span>我的笔记</span>
                    <textarea
                      value={editDraft.note}
                      onChange={(event) =>
                        updateEditDraft("note", event.target.value)
                      }
                      rows={6}
                      placeholder="记录判断、实验想法或后续事项"
                    />
                  </label>
                </fieldset>

                <fieldset className="edit-section">
                  <legend>资源链接</legend>
                  <label className="edit-field edit-field-wide">
                    <span>原文页面</span>
                    <input
                      type="url"
                      value={editDraft.originalUrl}
                      onChange={(event) =>
                        updateEditDraft("originalUrl", event.target.value)
                      }
                      placeholder="https://"
                    />
                  </label>

                  <div className="resource-editor-row pdf-source-editor">
                    <div className="resource-editor-heading">
                      <span className="resource-editor-label">PDF 来源链接</span>
                      {safeExternalUrl(editDraft.pdfUrl) && (
                        <a
                          href={safeExternalUrl(editDraft.pdfUrl)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          打开来源 ↗
                        </a>
                      )}
                    </div>
                    <input
                      type="url"
                      value={editDraft.pdfUrl}
                      onChange={(event) =>
                        updateEditDraft("pdfUrl", event.target.value)
                      }
                      placeholder="PDF 直达链接，可留空"
                    />
                    <small>
                      卡片首次打开此来源时会在后台保存 PDF；留空可仅保留本地副本。
                    </small>
                  </div>

                  <div
                    className={`pdf-archive-panel ${
                      editingPaper.pdfArchive?.status
                        ? `is-${editingPaper.pdfArchive.status}`
                        : "is-missing"
                    }`}
                    aria-live="polite"
                  >
                    <div className="pdf-archive-heading">
                      <span>本地副本</span>
                      <strong>
                        {pdfActionBusyId === editingPaper.id
                          ? "保存中…"
                          : editPdfSourceChanged
                            ? "来源待保存"
                            : editingPaper.pdfArchive?.status === "ready"
                              ? "已保存"
                              : editingPaper.pdfArchive?.status === "stale"
                                ? "待更新"
                                : editingPaper.pdfArchive?.status === "failed"
                                  ? "保存失败"
                                  : "尚未保存"}
                      </strong>
                    </div>

                    {pdfActionBusyId === editingPaper.id ? (
                      <p>正在验证并保存 PDF；可以继续编辑其他信息。</p>
                    ) : editPdfSourceChanged ? (
                      <p>保存来源链接后，本地副本会标记为待更新。</p>
                    ) : editingPaper.pdfArchive?.status === "ready" ? (
                      <p>
                        已保存到本机
                        {formatPdfSize(editingPaper.pdfArchive.sizeBytes)
                          ? ` · ${formatPdfSize(editingPaper.pdfArchive.sizeBytes)}`
                          : ""}
                        {formatPdfArchiveTime(editingPaper.pdfArchive.downloadedAt)
                          ? ` · ${formatPdfArchiveTime(editingPaper.pdfArchive.downloadedAt)}`
                          : ""}
                      </p>
                    ) : editingPaper.pdfArchive?.status === "stale" ? (
                      <p>
                        当前来源链接已更新；下载新版本前不会将旧副本作为默认 PDF 打开。
                      </p>
                    ) : editingPaper.pdfArchive?.status === "failed" ? (
                      <p>
                        {editingPaper.pdfArchive.errorMessage ||
                          "自动保存失败，可重试或选择本地 PDF。"}
                      </p>
                    ) : (
                      <p>尚未保存到本地；打开卡片中的 PDF 时会自动归档。</p>
                    )}

                    <div className="pdf-archive-actions">
                      {editingPaper.pdfArchive?.status === "ready" && (
                        <a
                          href={pdfOpenUrl(editingPaper.id)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          打开本地 ↗
                        </a>
                      )}
                      {safeExternalUrl(editDraft.pdfUrl) && (
                        <button
                          type="button"
                          onClick={() =>
                            void archivePaperPdf(editingPaper, {
                              force:
                                editingPaper.pdfArchive?.status === "ready",
                            })
                          }
                          disabled={
                            pdfActionBusyId === editingPaper.id ||
                            editPdfSourceChanged
                          }
                        >
                          {editingPaper.pdfArchive?.status === "ready"
                            ? "重新下载"
                            : editingPaper.pdfArchive?.status === "stale"
                              ? "下载新版本"
                              : "下载到本地"}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => pdfImportInputRef.current?.click()}
                        disabled={pdfActionBusyId === editingPaper.id}
                      >
                        选择本地 PDF
                      </button>
                      {editingPaper.pdfArchive?.status === "ready" && (
                        <button
                          type="button"
                          className="pdf-archive-danger"
                          onClick={() => void deleteLocalPdf(editingPaper)}
                          disabled={pdfActionBusyId === editingPaper.id}
                        >
                          删除副本
                        </button>
                      )}
                    </div>
                    <input
                      ref={pdfImportInputRef}
                      className="pdf-import-input"
                      type="file"
                      accept="application/pdf,.pdf"
                      onChange={handlePdfImport}
                    />
                  </div>

                  <div className="resource-editor-row">
                    <div className="resource-editor-heading">
                      <label className="resource-toggle">
                        <input
                          type="checkbox"
                          checked={editDraft.hasCode}
                          onChange={(event) =>
                            updateEditDraft("hasCode", event.target.checked)
                          }
                        />
                        <span>有代码</span>
                      </label>
                      {safeExternalUrl(editDraft.codeUrl) && (
                        <a
                          href={safeExternalUrl(editDraft.codeUrl)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          测试链接 ↗
                        </a>
                      )}
                    </div>
                    <input
                      type="url"
                      value={editDraft.codeUrl}
                      onChange={(event) => {
                        updateEditDraft("codeUrl", event.target.value);
                        if (event.target.value.trim() && !editDraft.hasCode) {
                          updateEditDraft("hasCode", true);
                        }
                      }}
                      placeholder="https://github.com/..."
                    />
                    {editDraft.codeUrl.trim() && (
                      <small>
                        自动识别：{providerForUrl(editDraft.codeUrl.trim())}
                      </small>
                    )}
                  </div>

                  <div className="resource-editor-row">
                    <div className="resource-editor-heading">
                      <label className="resource-toggle">
                        <input
                          type="checkbox"
                          checked={editDraft.hasProject}
                          onChange={(event) =>
                            updateEditDraft("hasProject", event.target.checked)
                          }
                        />
                        <span>有项目主页</span>
                      </label>
                      {safeExternalUrl(editDraft.projectUrl) && (
                        <a
                          href={safeExternalUrl(editDraft.projectUrl)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          测试链接 ↗
                        </a>
                      )}
                    </div>
                    <input
                      type="url"
                      value={editDraft.projectUrl}
                      onChange={(event) => {
                        updateEditDraft("projectUrl", event.target.value);
                        if (
                          event.target.value.trim() &&
                          !editDraft.hasProject
                        ) {
                          updateEditDraft("hasProject", true);
                        }
                      }}
                      placeholder="https://"
                    />
                  </div>
                </fieldset>

                {editingPaper.zoteroKey && (
                  <div className="paper-origin-meta">
                    <span>一次性导入自 Zotero</span>
                    <code>{editingPaper.zoteroKey}</code>
                  </div>
                )}
              </div>

              <footer className="edit-drawer-footer">
                <p>
                  {editDirty ? "有未保存的修改" : "当前内容已同步"}
                </p>
                <div>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={requestCloseEditor}
                    disabled={savingPaper}
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    className="primary-button"
                    disabled={savingPaper || !editDraft.title.trim()}
                    aria-keyshortcuts="Control+S Meta+S Control+Enter Meta+Enter"
                  >
                    {savingPaper ? "保存中…" : "保存修改"}
                    {!savingPaper && <kbd>⌘ S</kbd>}
                  </button>
                </div>
              </footer>
            </form>

            {discardConfirmOpen && (
              <div className="discard-confirm-layer">
                <section
                  className="discard-confirm"
                  role="alertdialog"
                  aria-modal="true"
                  aria-labelledby="discard-confirm-title"
                  aria-describedby="discard-confirm-description"
                >
                  <h3 id="discard-confirm-title">放弃未保存的修改？</h3>
                  <p id="discard-confirm-description">
                    本次在编辑抽屉中的修改将不会写入数据库。
                  </p>
                  <div className="discard-confirm-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={closeDiscardConfirm}
                      autoFocus
                    >
                      继续编辑
                    </button>
                    <button
                      type="button"
                      className="danger-button"
                      onClick={closeEditor}
                    >
                      放弃修改
                    </button>
                  </div>
                </section>
              </div>
            )}
          </section>
        </div>
      )}

      {radarAiTraceOpen && (
        <div
          className="modal-layer"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) closeRadarAiTrace();
          }}
        >
          <section
            ref={modalRef}
            className="modal radar-ai-trace-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="radar-ai-trace-title"
            aria-describedby="radar-ai-trace-description"
            aria-busy={radarAiTraceLoading}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeRadarAiTrace();
                return;
              }
              handleModalKeyDown(event);
            }}
          >
            <div className="modal-heading radar-ai-trace-heading">
              <div>
                <h2 id="radar-ai-trace-title">本次 AI 完整记录</h2>
                <p id="radar-ai-trace-description">
                  按实际调用轮次展示；只保存在本机，不包含 API Key。
                </p>
              </div>
              <button
                type="button"
                className="modal-close"
                onClick={closeRadarAiTrace}
                aria-label="关闭 AI 完整记录"
                autoFocus
              >
                ×
              </button>
            </div>

            <div className="radar-ai-trace-content">
              {radarAiTraceLoading ? (
                <div className="radar-ai-trace-empty">正在读取本机记录…</div>
              ) : radarAiTraceError ? (
                <p className="radar-error" role="alert">
                  {radarAiTraceError}
                </p>
              ) : !radarAiTrace ? (
                <div className="radar-ai-trace-empty">
                  <span aria-hidden="true">⌘</span>
                  <strong>尚无 AI 调用记录</strong>
                  <p>完成下一次文献雷达检索后，可在这里查看完整内容。</p>
                </div>
              ) : (
                <>
                  <div className="radar-ai-trace-summary">
                    <span className={`is-${radarAiTrace.status}`}>
                      {radarAiTrace.status === "completed"
                        ? "已完成"
                        : radarAiTrace.status === "failed"
                          ? "运行失败"
                          : "运行中"}
                    </span>
                    <p>
                      {formatRadarAiTraceTime(radarAiTrace.startedAt)} · 请求推送{" "}
                      {radarAiTrace.requestedCount} 篇 · 实际调用{" "}
                      {radarAiTrace.exchanges.length} 轮
                    </p>
                  </div>

                  {radarAiTrace.errorMessage && (
                    <p className="radar-error" role="status">
                      {radarAiTrace.errorMessage}
                    </p>
                  )}

                  <div className="radar-ai-trace-exchanges">
                    {radarAiTrace.exchanges.map((exchange, index) => (
                      <section
                        className="radar-ai-trace-exchange"
                        key={`${exchange.round}-${index}`}
                      >
                        <header>
                          <div>
                            <strong>第 {exchange.round} 轮调用</strong>
                            <span>
                              {[exchange.provider, exchange.model]
                                .filter(Boolean)
                                .join(" / ") || "等待 AI 返回"}
                              {exchange.latencyMs !== null
                                ? ` · ${(exchange.latencyMs / 1_000).toFixed(2)} 秒`
                                : ""}
                            </span>
                          </div>
                          {exchange.errorMessage && (
                            <small>{exchange.errorMessage}</small>
                          )}
                        </header>

                        <div className="radar-ai-trace-block">
                          <div>
                            <strong>发送给 AI 的完整提示词</strong>
                            <button
                              type="button"
                              onClick={() =>
                                void copyRadarAiText(
                                  exchange.prompt,
                                  `第 ${exchange.round} 轮提示词`,
                                )
                              }
                            >
                              复制提示词
                            </button>
                          </div>
                          <pre>{exchange.prompt}</pre>
                        </div>

                        <div className="radar-ai-trace-block">
                          <div>
                            <strong>AI 的完整回复</strong>
                            <button
                              type="button"
                              disabled={!exchange.response}
                              onClick={() =>
                                void copyRadarAiText(
                                  exchange.response,
                                  `第 ${exchange.round} 轮回复`,
                                )
                              }
                            >
                              复制回复
                            </button>
                          </div>
                          <pre>
                            {exchange.response || "（AI 尚未返回文本）"}
                          </pre>
                        </div>
                      </section>
                    ))}
                  </div>
                </>
              )}
            </div>

            <footer className="radar-ai-trace-footer">
              <p>记录包含排重清单中的论文标题与标识，仅在点击时读取。</p>
              <div>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={copyCompleteRadarAiTrace}
                  disabled={!radarAiTrace?.exchanges.length}
                >
                  复制全部
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={closeRadarAiTrace}
                >
                  完成
                </button>
              </div>
            </footer>
          </section>
        </div>
      )}

      {aiSettingsOpen && (
        <div
          className="modal-layer"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) closeAiSettings();
          }}
        >
          <section
            ref={modalRef}
            className="modal ai-settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ai-settings-title"
            aria-describedby="ai-settings-description"
            aria-busy={aiSettingsLoading || Boolean(aiBusyAction)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeAiSettings();
                return;
              }
              handleModalKeyDown(event);
            }}
          >
            <div className="modal-heading ai-settings-heading">
              <div>
                <h2 id="ai-settings-title">AI 服务</h2>
                <p id="ai-settings-description">
                  一个服务地址保存一份密钥，并可添加和切换多个模型。
                </p>
              </div>
              <button
                type="button"
                className="modal-close"
                onClick={closeAiSettings}
                aria-label="关闭 AI 设置"
                disabled={Boolean(aiBusyAction)}
              >
                ×
              </button>
            </div>

            {aiSettingsLoading && !aiSettings ? (
              <p className="ai-settings-loading">正在读取本机 AI 配置…</p>
            ) : (
              <>
                <div className="ai-current-model-bar">
                  <div className="ai-current-model-overview">
                    <span className="ai-current-model-icon" aria-hidden="true">
                      AI
                    </span>
                    <div className="ai-current-model-copy">
                      <div>
                        <strong>默认 AI 模型</strong>
                        <span
                          className={`ai-current-model-status ${
                            activeAiSelection ? "is-ready" : "is-empty"
                          }`}
                        >
                          <i aria-hidden="true" />
                          {activeAiSelection ? "已选择" : "未选择"}
                        </span>
                      </div>
                      <p>用于论文识别、元数据补全与内容总结</p>
                    </div>
                  </div>
                  <label
                    className={`ai-model-picker ${
                      activeAiSelection ? "" : "is-empty"
                    }`}
                  >
                    <span className="sr-only">切换当前模型</span>
                    <span className="ai-model-picker-mark" aria-hidden="true">
                      {activeAiSelection
                        ? activeAiSelection.connection.name
                            .trim()
                            .slice(0, 1)
                            .toUpperCase()
                        : "＋"}
                    </span>
                    <span className="ai-model-picker-copy" aria-hidden="true">
                      <small>
                        {activeAiSelection
                          ? activeAiSelection.connection.name
                          : "AI 服务"}
                      </small>
                      <strong>
                        {activeAiSelection?.model.model ?? "选择一个模型"}
                      </strong>
                    </span>
                    <span className="ai-model-picker-chevron" aria-hidden="true" />
                    <select
                      value={aiSettings?.activeModelId ?? ""}
                      onChange={(event) =>
                        void activateAiModel(event.target.value)
                      }
                      disabled={Boolean(aiBusyAction)}
                    >
                      {!aiSettings?.activeModelId && (
                        <option value="" disabled>
                          暂无可用模型
                        </option>
                      )}
                      {aiSettings?.connections.map((connection) => (
                        <optgroup
                          key={connection.id}
                          label={connection.name}
                          disabled={!connection.configured}
                        >
                          {connection.models.map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.model}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="ai-settings-workspace">
                  <aside className="ai-connection-sidebar">
                    <div className="ai-connection-sidebar-title">
                      <span>服务连接</span>
                      <small>{aiSettings?.connections.length ?? 0}</small>
                    </div>
                    <nav aria-label="AI 服务连接">
                      {aiSettings?.connections.map((connection) => (
                        <button
                          type="button"
                          key={connection.id}
                          className={
                            !aiCreatingConnection &&
                            aiSelectedConnectionId === connection.id
                              ? "is-selected"
                              : ""
                          }
                          onClick={() => selectAiConnection(connection)}
                          disabled={Boolean(aiBusyAction)}
                        >
                          <span className="ai-connection-dot" />
                          <span>
                            <strong>{connection.name}</strong>
                            <small>
                              {connection.configured ? "已配置" : "密钥缺失"}
                              {` · ${connection.models.length} 个模型`}
                            </small>
                          </span>
                        </button>
                      ))}
                    </nav>
                    <button
                      type="button"
                      className={`ai-add-connection ${
                        aiCreatingConnection ? "is-selected" : ""
                      }`}
                      onClick={beginCreatingAiConnection}
                      disabled={Boolean(aiBusyAction)}
                    >
                      <span aria-hidden="true">＋</span>
                      添加服务
                    </button>
                  </aside>

                  <form className="ai-connection-editor" onSubmit={submitAiModel}>
                    <header className="ai-connection-editor-header">
                      <div>
                        <h3>
                          {aiCreatingConnection
                            ? "添加服务"
                            : selectedAiConnection?.name ?? "服务连接"}
                        </h3>
                        <p>
                          {aiCreatingConnection
                            ? "填写服务地址、密钥和第一个模型。"
                            : "选择、测试或添加这个服务的模型。"}
                        </p>
                      </div>
                      {!aiCreatingConnection && selectedAiConnection && (
                        <span className="ai-editor-model-count">
                          {selectedAiConnection.configured
                            ? `${selectedAiConnection.models.length} 个模型`
                            : "密钥缺失"}
                        </span>
                      )}
                    </header>

                    {aiCreatingConnection && aiConnectionSettingsPanel}

                    {!aiCreatingConnection &&
                      selectedAiConnection &&
                      selectedAiConnection.models.length > 0 && (
                        <section className="ai-model-section">
                          <div className="ai-model-section-heading">
                            <h4>已添加模型</h4>
                            <span>{selectedAiConnection.models.length}</span>
                          </div>
                          <div className="ai-model-list">
                            {selectedAiConnection.models.map((model) => (
                              <article
                                className={`ai-model-row ${
                                  model.active ? "is-active" : ""
                                }`}
                                key={model.id}
                              >
                                <div className="ai-model-info">
                                  <div className="ai-model-title">
                                    <strong>{model.model}</strong>
                                    {model.active && (
                                      <span className="ai-active-badge">
                                        当前
                                      </span>
                                    )}
                                  </div>
                                  <small>
                                    已验证
                                    {formatAiVerifiedTime(model.verifiedAt)
                                      ? ` · ${formatAiVerifiedTime(model.verifiedAt)}`
                                      : ""}
                                  </small>
                                </div>
                                <div className="ai-model-actions">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void verifyAiModel(model.model, {
                                        reverify: true,
                                      })
                                    }
                                    disabled={Boolean(aiBusyAction)}
                                  >
                                    重新测试
                                  </button>
                                  {!model.active && (
                                    <button
                                      type="button"
                                      onClick={() => void activateAiModel(model.id)}
                                      disabled={Boolean(aiBusyAction)}
                                    >
                                      设为当前
                                    </button>
                                  )}
                                  <details className="ai-model-more">
                                    <summary
                                      aria-label={`更多模型操作：${model.model}`}
                                    >
                                      ···
                                    </summary>
                                    <div>
                                      <button
                                        type="button"
                                        className="is-danger"
                                        onClick={() => void removeAiModel(model)}
                                        disabled={Boolean(aiBusyAction)}
                                      >
                                        删除模型
                                      </button>
                                    </div>
                                  </details>
                                </div>
                              </article>
                            ))}
                          </div>
                        </section>
                      )}

                    <section className="ai-add-model-section">
                      <div>
                        <h4>
                          {aiCreatingConnection ? "第一个模型" : "添加模型"}
                        </h4>
                        <p>模型 ID 由当前 Base URL 提供。</p>
                      </div>
                      <div className="ai-add-model-control">
                        <label className="ai-field">
                          <span className="sr-only">模型 ID</span>
                          <input
                            data-ai-model
                            type="text"
                            value={aiDraftModel}
                            onChange={(event) => {
                              setAiDraftModel(event.target.value);
                              setAiInlineError(null);
                            }}
                            placeholder="输入模型 ID，例如 gpt-5.5"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            required
                            aria-invalid={Boolean(duplicateAiModel)}
                            disabled={Boolean(aiBusyAction)}
                          />
                        </label>
                        <button
                          type="submit"
                          className="primary-button"
                          disabled={
                            Boolean(aiBusyAction) ||
                            !aiDraftBaseUrl.trim() ||
                            !aiDraftModel.trim() ||
                            Boolean(aiDuplicateMessage)
                          }
                        >
                          {aiBusyAction?.startsWith("verify:")
                            ? "正在验证…"
                            : aiCreatingConnection
                              ? "验证并添加"
                              : "测试并添加"}
                        </button>
                      </div>
                    </section>

                    {aiDuplicateMessage && (
                      <p className="ai-inline-error" role="alert">
                        {aiDuplicateMessage}
                      </p>
                    )}

                    {aiInlineError &&
                      !aiDuplicateMessage &&
                      (!aiInlineError.connectionId ||
                        aiInlineError.connectionId ===
                          aiSelectedConnectionId) && (
                        <p className="ai-inline-error" role="alert">
                          {aiInlineError.message}
                        </p>
                      )}

                    {!aiCreatingConnection && aiConnectionSettingsPanel}
                  </form>
                </div>
              </>
            )}

            {aiInlineError && !aiSettings && (
              <p className="ai-inline-error ai-global-error" role="alert">
                {aiInlineError.message}
              </p>
            )}

            <footer className="ai-settings-footer">
              <p>验证只发送一条不包含论文数据的最小请求。</p>
              <button
                type="button"
                className="secondary-button"
                onClick={closeAiSettings}
                disabled={Boolean(aiBusyAction)}
              >
                完成
              </button>
            </footer>
          </section>
        </div>
      )}

      {addPaperOpen && (
        <div
          className="modal-layer"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setAddPaperOpen(false);
          }}
        >
          <section
            ref={modalRef}
            className="modal paper-intake-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-paper-title"
            onKeyDown={handleModalKeyDown}
          >
            <div className="modal-heading">
              <div>
                <h2 id="add-paper-title">添加论文</h2>
                <p>粘贴论文地址，核对 AI 整理后的信息再保存。</p>
              </div>
              <button
                className="modal-close"
                onClick={() => setAddPaperOpen(false)}
                aria-label="关闭"
                disabled={paperIntakeBusy || addingPaper}
              >
                ×
              </button>
            </div>

            <ol className="paper-intake-steps" aria-label="添加进度">
              <li className={!paperIntakeDraft ? "is-active" : "is-complete"}>
                <span>1</span>
                识别与查重
              </li>
              <li
                className={
                  paperIntakeBusy
                    ? "is-active"
                    : paperIntakeDraft
                      ? "is-complete"
                      : ""
                }
              >
                <span>2</span>
                元数据与 AI
              </li>
              <li className={paperIntakeDraft ? "is-active" : ""}>
                <span>3</span>
                人工确认
              </li>
            </ol>

            {!paperIntakeDraft ? (
              <form className="paper-intake-start" onSubmit={analyzePaperReference}>
                <label className="paper-intake-reference">
                  <span>论文链接或标识</span>
                  <textarea
                    value={paperReference}
                    onChange={(event) => setPaperReference(event.target.value)}
                    placeholder="粘贴 DOI、arXiv 编号或论文网页 URL"
                    rows={3}
                    autoFocus
                    disabled={paperIntakeBusy}
                  />
                </label>
                <p className="paper-intake-hint">
                  系统会先检查本地知识库；确认无重复后，再核对正式发表版本、查找项目与代码，并调用当前模型生成中文标题、摘要和分类建议。
                </p>

                {paperIntakeBusy && (
                  <div className="paper-intake-progress" role="status">
                    <span className="paper-intake-spinner" aria-hidden="true" />
                    <div>
                      <strong>正在整理这篇论文</strong>
                      <small>查重、读取元数据并生成补全内容，通常需要几秒。</small>
                    </div>
                  </div>
                )}

                {paperIntakeResult?.status === "duplicate" && (
                  <div className="paper-duplicate-panel" role="alert">
                    <div className="paper-duplicate-heading">
                      <span aria-hidden="true">!</span>
                      <div>
                        <strong>知识库中可能已经有这篇论文</strong>
                        <small>为避免重复，当前不会继续调用 AI 或写入数据库。</small>
                      </div>
                    </div>
                    <div className="paper-duplicate-list">
                      {paperIntakeResult.duplicates.map(({ paper, reasons }) => (
                        <article key={paper.id}>
                          <div>
                            <strong>{paper.title}</strong>
                            <small>
                              {formatPublicationForDisplay(
                                paper.source,
                                paper.date,
                              ) || "来源未录入"}
                            </small>
                          </div>
                          <div className="paper-duplicate-actions">
                            <span>
                              {paper.deletedAt
                                ? "最近删除"
                                : reasons.some(
                                      (reason) => reason.type === "identifier",
                                    )
                                  ? "标识一致"
                                  : "标题一致"}
                            </span>
                            <button
                              type="button"
                              onClick={() => void showDuplicatePaper(paper)}
                              disabled={Boolean(paperDuplicateBusyId)}
                            >
                              {paperDuplicateBusyId === paper.id
                                ? "恢复中…"
                                : paper.deletedAt
                                  ? "恢复论文"
                                  : "查看已有论文"}
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                  </div>
                )}

                {paperIntakeError && (
                  <p className="paper-intake-error" role="alert">
                    {paperIntakeError}
                  </p>
                )}

                <div className="modal-actions paper-intake-start-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setAddPaperOpen(false)}
                    disabled={paperIntakeBusy}
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    className="primary-button"
                    disabled={paperIntakeBusy || !paperReference.trim()}
                  >
                    {paperIntakeBusy ? "正在识别…" : "识别并生成"}
                  </button>
                </div>
              </form>
            ) : (
              <form className="paper-intake-review" onSubmit={addPaper}>
                <div className="paper-intake-review-meta">
                  <div>
                    <span>元数据来源</span>
                    <strong>
                      {paperIntakeResult?.status === "ready"
                        ? paperIntakeResult.metadata.metadataSource
                        : "论文页面"}
                    </strong>
                  </div>
                  {paperIntakeResult?.status === "ready" && (
                    <div>
                      <span>版本状态</span>
                      <strong
                        className={
                          paperIntakeResult.metadata.publicationStatus ===
                          "published"
                            ? "is-safe"
                            : ""
                        }
                      >
                        {paperIntakeResult.metadata.publicationStatus ===
                        "published"
                          ? "已匹配正式发表"
                          : paperIntakeResult.metadata.publicationStatus ===
                              "preprint"
                            ? "arXiv 预印本"
                            : "尚未确认正式版本"}
                      </strong>
                    </div>
                  )}
                  {paperIntakeResult?.status === "ready" && paperIntakeResult.ai && (
                    <div>
                      <span>AI 模型</span>
                      <strong>{paperIntakeResult.ai.model}</strong>
                    </div>
                  )}
                  <div>
                    <span>重复检测</span>
                    <strong className="is-safe">未发现重复</strong>
                  </div>
                </div>

                {paperIntakeResult?.status === "ready" && paperIntakeResult.aiError && (
                  <div className="paper-intake-ai-warning" role="alert">
                    <strong>元数据已获取，但 AI 补全没有完成</strong>
                    <p>
                      {paperIntakeResult.aiError.message}
                      {paperIntakeResult.aiError.action
                        ? ` ${paperIntakeResult.aiError.action}`
                        : " 你可以手动填写后继续添加。"}
                    </p>
                  </div>
                )}

                <fieldset className="paper-intake-section">
                  <legend>发表信息</legend>
                  <label className="paper-intake-field paper-intake-field-wide">
                    <span>英文标题</span>
                    <textarea
                      value={paperIntakeDraft.title}
                      onChange={(event) =>
                        updatePaperIntakeDraft("title", event.target.value)
                      }
                      rows={2}
                      required
                    />
                  </label>
                  <div className="paper-intake-field-grid">
                    <label className="paper-intake-field paper-intake-field-wide">
                      <span>作者</span>
                      <input
                        value={paperIntakeDraft.authors}
                        onChange={(event) =>
                          updatePaperIntakeDraft("authors", event.target.value)
                        }
                      />
                    </label>
                    <label className="paper-intake-field">
                      <span>发表日期</span>
                      <input
                        value={paperIntakeDraft.date}
                        onChange={(event) =>
                          updatePaperIntakeDraft("date", event.target.value)
                        }
                        placeholder="YYYY-MM-DD"
                      />
                    </label>
                    <label className="paper-intake-field">
                      <span>会议 / 期刊</span>
                      <input
                        value={paperIntakeDraft.source}
                        onChange={(event) =>
                          updatePaperIntakeDraft("source", event.target.value)
                        }
                      />
                    </label>
                    <label className="paper-intake-field">
                      <span>机构</span>
                      <input
                        value={paperIntakeDraft.institution}
                        onChange={(event) =>
                          updatePaperIntakeDraft("institution", event.target.value)
                        }
                        placeholder="元数据未提供时可留空"
                      />
                    </label>
                  </div>
                </fieldset>

                <fieldset className="paper-intake-section is-ai-section">
                  <legend>
                    AI 补全
                    <small>可修改</small>
                  </legend>
                  <label className="paper-intake-field">
                    <span>中文标题</span>
                    <input
                      value={paperIntakeDraft.zhTitle}
                      onChange={(event) =>
                        updatePaperIntakeDraft("zhTitle", event.target.value)
                      }
                    />
                  </label>
                  <label className="paper-intake-field">
                    <span>AI 摘要</span>
                    <textarea
                      value={paperIntakeDraft.aiSummary}
                      onChange={(event) =>
                        updatePaperIntakeDraft("aiSummary", event.target.value)
                      }
                      rows={5}
                    />
                  </label>
                </fieldset>

                <fieldset className="paper-intake-section">
                  <legend>
                    分类
                    <small>AI 只会从现有分类中推荐</small>
                  </legend>
                  <div className="paper-intake-categories">
                    {flattenedCategories.map((category) => {
                      const selected = paperIntakeDraft.categoryIds.includes(category.id);
                      return (
                        <label className={selected ? "is-selected" : ""} key={category.id}>
                          <input
                            type="checkbox"
                            checked={selected}
                              onChange={() =>
                                updatePaperIntakeDraft(
                                  "categoryIds",
                                  toggleCategorySelection(
                                    category.id,
                                    paperIntakeDraft.categoryIds,
                                  ),
                                )
                              }
                          />
                          <span>{category.path.join(" › ")}</span>
                        </label>
                      );
                    })}
                    {!flattenedCategories.length && <p>暂无分类，将保存为未分类。</p>}
                  </div>
                </fieldset>

                <fieldset className="paper-intake-section">
                  <legend>论文资源</legend>
                  <label className="paper-intake-field">
                    <span>原文页面</span>
                    <input
                      value={paperIntakeDraft.originalUrl}
                      onChange={(event) =>
                        updatePaperIntakeDraft("originalUrl", event.target.value)
                      }
                    />
                  </label>
                  <label className="paper-intake-resource-toggle">
                    <input
                      type="checkbox"
                      checked={paperIntakeDraft.hasPdf}
                      onChange={(event) =>
                        updatePaperIntakeDraft("hasPdf", event.target.checked)
                      }
                    />
                    <span>保存 PDF 链接</span>
                  </label>
                  {paperIntakeDraft.hasPdf && (
                    <label className="paper-intake-field">
                      <span>PDF 链接</span>
                      <input
                        value={paperIntakeDraft.pdfUrl}
                        onChange={(event) =>
                          updatePaperIntakeDraft("pdfUrl", event.target.value)
                        }
                      />
                    </label>
                  )}
                  <label className="paper-intake-field">
                    <span>代码仓库</span>
                    <input
                      value={paperIntakeDraft.codeUrl}
                      onChange={(event) =>
                        updatePaperIntakeDraft("codeUrl", event.target.value)
                      }
                      placeholder="未可靠找到时留空"
                    />
                    {paperIntakeResult?.status === "ready" &&
                      paperIntakeResult.metadata.codeEvidence && (
                        <small className="paper-intake-evidence">
                          已验证：{paperIntakeResult.metadata.codeEvidence}
                        </small>
                      )}
                  </label>
                  <label className="paper-intake-field">
                    <span>项目主页</span>
                    <input
                      value={paperIntakeDraft.projectUrl}
                      onChange={(event) =>
                        updatePaperIntakeDraft("projectUrl", event.target.value)
                      }
                      placeholder="未可靠找到时留空"
                    />
                    {paperIntakeResult?.status === "ready" &&
                      paperIntakeResult.metadata.projectEvidence && (
                        <small className="paper-intake-evidence">
                          已验证：{paperIntakeResult.metadata.projectEvidence}
                        </small>
                      )}
                  </label>
                  <div className="paper-identifier-list" aria-label="用于查重的论文标识">
                    {paperIntakeDraft.identifiers
                      .filter((identifier) => identifier.kind !== "url")
                      .map((identifier) => (
                        <span key={`${identifier.kind}:${identifier.value}`}>
                          {identifier.kind.toUpperCase()} · {identifier.value}
                        </span>
                      ))}
                  </div>
                </fieldset>

                {paperIntakeError && (
                  <p className="paper-intake-error" role="alert">
                    {paperIntakeError}
                  </p>
                )}

                <div className="modal-actions paper-intake-review-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setPaperIntakeDraft(null);
                      setPaperIntakeResult(null);
                      setPaperIntakeError("");
                    }}
                    disabled={addingPaper}
                  >
                    重新识别
                  </button>
                  <button
                    type="submit"
                    className="primary-button"
                    disabled={addingPaper || !paperIntakeDraft.title.trim()}
                  >
                    {addingPaper ? "正在添加…" : "确认添加到知识库"}
                  </button>
                </div>
              </form>
            )}
          </section>
        </div>
      )}

      {toast && (
        <div className="toast" role="status">
          <span aria-hidden="true">✓</span>
          <span>{toast}</span>
          {lastDeletedCategory ? (
            <button
              className="toast-action"
              onClick={() =>
                restoreManagedCategory(lastDeletedCategory, true)
              }
            >
              撤销
            </button>
          ) : lastDeleted ? (
            <button className="toast-action" onClick={undoDelete}>
              撤销
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
