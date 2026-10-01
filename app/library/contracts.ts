export type CardTextSize = "small" | "standard" | "large";
export type PaperViewMode = "cards" | "titles";

export type Category = {
  id: string;
  name: string;
  count: number;
  sidebarVisible: boolean;
  ancestorIds?: string[];
  children?: Category[];
};

export type CategoryRecord = {
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

export type DeletedCategoryRecord = CategoryRecord & {
  deletedAt?: string;
};

export type PaperTag = {
  label: string;
  scope: string;
};

export type PaperIdentifier = {
  kind: "doi" | "arxiv" | "url";
  value: string;
};

export type PdfArchive = {
  status: "ready" | "failed" | "stale";
  downloadedAt?: string;
  sizeBytes?: number;
  errorCode?: string;
  errorMessage?: string;
};

export type Paper = {
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

export type PaperIntakeDraft = {
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

export type PaperDuplicateMatch = {
  paper: Pick<
    Paper,
    "id" | "title" | "zhTitle" | "authors" | "source" | "date"
  > & { deletedAt?: string };
  reasons: Array<
    | { type: "title" }
    | { type: "identifier"; kind: PaperIdentifier["kind"]; value: string }
  >;
};

export type PaperIntakeSource = {
  title: string;
  url: string;
};

export type PaperIntakeResponse =
  | {
      status: "duplicate";
      reference: string;
      duplicates: PaperDuplicateMatch[];
    }
  | {
      status: "needs_clarification" | "research_incomplete" | "not_found";
      reference: string;
      message: string;
      sources: PaperIntakeSource[];
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
        codeUrl: string;
        codeProvider: string;
        codeEvidence: string;
        projectUrl: string;
        projectProvider: string;
        projectEvidence: string;
        sources: PaperIntakeSource[];
        matchReason: string;
        warnings: string[];
      };
      ai: null | {
        zhTitle: string;
        institution: string;
        source: string;
        aiSummary: string;
        categoryIds: string[];
        model: string;
      };
      draft: PaperIntakeDraft;
    };

export type PaperEditDraft = {
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

export type BackupStatus = {
  ok: boolean;
  lastBackupAt?: string;
  message?: string;
};

export type LibraryResponse = {
  papers: Paper[];
  categories: Category[];
  backup?: BackupStatus;
};

export type PaperMutationResponse = {
  paper: Paper;
  backup?: BackupStatus;
};

export type PdfArchiveMutationResponse = PaperMutationResponse & {
  alreadyArchived?: boolean;
  committed?: boolean;
};

export type CategoryMutationResponse = {
  category: CategoryRecord;
  categories?: CategoryRecord[];
  deletedCategories?: DeletedCategoryRecord[];
  library?: LibraryResponse;
  backup?: BackupStatus;
};

export type CategoriesResponse = {
  categories: CategoryRecord[];
  deletedCategories?: DeletedCategoryRecord[];
  library?: LibraryResponse;
  backup?: BackupStatus;
};

export type LibraryConnection = "connecting" | "ready" | "unavailable";

export type AiReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type AiModelSettings = {
  id: string;
  model: string;
  resolvedModel: string;
  reasoningEffort: AiReasoningEffort | null;
  reasoningEffortOptions: AiReasoningEffort[];
  verifiedAt: string | null;
  active: boolean;
};

export type AiConnectionSettings = {
  id: string;
  name: string;
  baseUrl: string;
  configured: boolean;
  status: "verified" | "credential-missing";
  models: AiModelSettings[];
};

export type AiSettingsResponse = {
  connections: AiConnectionSettings[];
  activeModelId: string | null;
};

export type AiSettingsMutationResponse = {
  settings: AiSettingsResponse;
  backup?: BackupStatus;
};

export type AiVerificationResponse = AiSettingsMutationResponse & {
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

export type RadarItem = {
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

export type RadarStateResponse = {
  settings: {
    prompt: string;
    promptTemplate: string;
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

export type RadarAddResponse = {
  paper: Paper;
  library: LibraryResponse;
  radar: RadarStateResponse;
};

export type RadarAiExchange = {
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

export type RadarAiTrace = {
  status: "running" | "completed" | "failed";
  requestedCount: number;
  userPrompt: string;
  exchanges: RadarAiExchange[];
  errorMessage: string;
  startedAt: string;
  completedAt: string;
  updatedAt: string;
};

export type RadarAiTraceResponse = {
  trace: RadarAiTrace | null;
};

export type RadarPromptTemplateResponse = {
  promptTemplate: string;
};

export type FlatCategory = Category & {
  depth: number;
  path: string[];
  numberPath: number[];
  outlineNumber: string;
};
