import type { ComposerAttachment, ComposerSubmitPayload } from "@/components/chat/composer-types";

const IMAGE_EXTENSIONS = new Set([
  ".apng",
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
]);

export function isImagePath(path: string): boolean {
  const clean = path.split("?")[0]?.split("#")[0] ?? path;
  const index = clean.lastIndexOf(".");
  if (index === -1) return false;
  return IMAGE_EXTENSIONS.has(clean.slice(index).toLowerCase());
}

export function fileNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").pop() || path;
}

function attachmentDisplayName(attachment: ComposerAttachment): string {
  return attachment.uploadedName || attachment.name || fileNameFromPath(attachment.path ?? "");
}

/** 会话里展示的用户消息文本：正文 + 「附件：a、b」。 */
export function buildComposerDisplayText(payload: ComposerSubmitPayload): string {
  const text = payload.text.trim();
  const attachments = payload.attachments.map(attachmentDisplayName);
  if (attachments.length === 0) return text;
  const suffix = `附件：${attachments.join("、")}`;
  return text ? `${text}\n\n${suffix}` : suffix;
}
