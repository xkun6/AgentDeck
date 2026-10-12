const GENERATED_TITLE_MAX = 48;
const DISPLAY_TITLE_MAX = 60;

function compactText(value: string | null | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

export function titleFromPrompt(prompt: string): string {
  return truncateText(compactText(prompt), GENERATED_TITLE_MAX);
}

export function titleWithSessionSuffix(title: string, sessionId: string): string {
  const clean = compactText(title);
  const suffix = compactText(sessionId).slice(-6);
  if (!clean || !suffix) return clean;

  const suffixText = ` ${suffix}`;
  const baseMax = Math.max(1, GENERATED_TITLE_MAX - suffixText.length);
  return `${truncateText(clean, baseMax)}${suffixText}`;
}

export function sessionDisplayTitle(session: {
  id: string;
  title?: string | null;
  preview?: string | null;
}): string {
  return truncateText(
    compactText(session.title) || compactText(session.preview) || session.id,
    DISPLAY_TITLE_MAX,
  );
}
