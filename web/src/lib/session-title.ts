const GENERATED_TITLE_MAX = 48;

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
