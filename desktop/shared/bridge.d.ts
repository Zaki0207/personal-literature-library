export type DesktopPdfGrant = { id: string; name: string; size: number };

export type DesktopCommand =
  | { type: "add-paper" | "search" | "radar" | "command-search" }
  | { type: "save-before-quit"; requestId: string }
  | { type: "settings"; section?: "general" | "ai" | "data" }
  | { type: "view-mode"; mode: "cards" | "titles" }
  | { type: "import-pdf"; files: DesktopPdfGrant[] };

export type DesktopRequest = {
  path: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  requestId?: string;
};

export interface LiteratureDesktopBridge {
  platform: "darwin";
  request(input: DesktopRequest): Promise<{ status: number; body: unknown }>;
  cancelRequest(requestId: string): Promise<void>;
  pdfUrl(paperId: string): string;
  openExternal(url: string): Promise<void>;
  selectPdf(): Promise<DesktopPdfGrant[]>;
  grantDroppedPdf(file: File): Promise<DesktopPdfGrant>;
  importPdf(paperId: string, grantId: string): Promise<unknown>;
  showPdfInFinder(paperId: string): Promise<void>;
  showDataInFinder(kind: "database" | "pdf" | "backups"): Promise<void>;
  openSettings(section?: "general" | "ai" | "data"): Promise<void>;
  onCommand(callback: (command: DesktopCommand) => void): () => void;
  ready(): void;
  acknowledgeQuit(allow?: boolean, requestId?: string): void;
}

declare global {
  interface Window {
    literatureDesktop?: LiteratureDesktopBridge;
  }
}
