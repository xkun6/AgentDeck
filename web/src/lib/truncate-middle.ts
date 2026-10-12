export function truncateMiddle(
  text: string | null | undefined,
  maxLength = 56,
  ellipsis = "…",
): string {
  if (!text) return "";
  if (text.length <= maxLength) return text;
  if (maxLength <= ellipsis.length + 2) return text.slice(0, maxLength);

  const remaining = maxLength - ellipsis.length;
  const front = Math.ceil(remaining / 2);
  const back = remaining - front;
  return `${text.slice(0, front)}${ellipsis}${text.slice(-back)}`;
}
