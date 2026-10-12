const CLI_THINKING_VERBS = [
  "analyzing",
  "brainstorming",
  "cogitating",
  "computing",
  "contemplating",
  "deliberating",
  "decrypting",
  "forging",
  "formulating",
  "hammering plans",
  "jacking in",
  "mulling",
  "musing",
  "plotting",
  "pondering",
  "processing",
  "reasoning",
  "reflecting",
  "ruminating",
  "synthesizing",
  "uploading",
].sort((a, b) => b.length - a.length);

const ANSI_SGR_PATTERN = new RegExp("\\x1b\\[[0-9;]*m", "g");

function normalize(value: string): string {
  return value.replace(ANSI_SGR_PATTERN, "").replace(/\s+/g, " ").trim();
}

function isSpinnerSegment(segment: string): boolean {
  const normalized = normalize(segment).toLowerCase();
  if (!normalized) return true;

  for (const verb of CLI_THINKING_VERBS) {
    if (!normalized.endsWith(verb)) continue;
    const prefix = normalized.slice(0, -verb.length).trim();
    return prefix.length > 0 && /[^a-z0-9_\s]/i.test(prefix);
  }

  return false;
}

export function isCliThinkingPlaceholder(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = normalize(value);
  if (!normalized) return false;

  const segments = normalized
    .split(/(?:\.\.\.|…)/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.length > 0 && segments.every(isSpinnerSegment);
}

export function normalizeCliThinkingProgress(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = normalize(value);
  return isCliThinkingPlaceholder(text) ? text : "";
}

export function normalizeReasoningText(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text && !isCliThinkingPlaceholder(text) ? text : "";
}
