import { readFileSync } from "node:fs";

export const DEFAULT_PAPER_INTAKE_PROMPT_TEMPLATE = readFileSync(
  new URL("./prompts/paper-intake.txt", import.meta.url),
  "utf8",
).trim();

export const MAX_PAPER_INTAKE_PROMPT_LENGTH = 40_000;
