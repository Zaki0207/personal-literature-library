export type PaperSearchMatch = {
  matched: boolean;
  score: number;
  matchedFields: string[];
  intent: string;
};

export function normalizeSearchText(value: unknown): string;

export function buildPaperSearchDocument(
  paper: Record<string, unknown>,
  options?: { categoryNames?: string[] },
): {
  paperId: unknown;
  fields: Record<string, { text: string; compact: string }>;
};

export function matchPaperSearch(
  paper: Record<string, unknown>,
  query: string,
  options?: { categoryNames?: string[] },
): PaperSearchMatch;

export function comparePaperSearchMatches(
  left?: PaperSearchMatch,
  right?: PaperSearchMatch,
): number;

