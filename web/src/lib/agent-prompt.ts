// 把 composer 的提交内容转成 sidecar 的 AgentPromptInput：
// - 文本原样发送；
// - 图片附件读成 base64 作为 image part（浏览器 File 用 FileReader，本机路径走 read_file_data_url）；
// - 其它文件 / 目录以路径引用的形式附在文本末尾，由 Agent 自己读取。
import type { AgentPromptInput, AgentUIMessage } from "@agentdeck/protocol";
import type { ComposerAttachment, ComposerSubmitPayload } from "@/components/chat/composer-types";
import type { ImageEntry } from "@/stores/chat";
import { buildComposerDisplayText } from "./composer-prompt";
import { readFileDataUrl } from "./transport";

export interface PreparedAgentPrompt {
  prompt: AgentPromptInput;
  displayText: string;
  displayImages: ImageEntry[];
}

type AgentPromptPart = Exclude<AgentPromptInput, string>[number];

function readBlobAsDataUrl(file: Blob): Promise<string | undefined> {
  if (typeof FileReader === "undefined") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve(typeof reader.result === "string" ? reader.result : undefined);
    }, { once: true });
    reader.addEventListener("error", () => resolve(undefined), { once: true });
    reader.readAsDataURL(file);
  });
}

export function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1]!, data: match[2]! };
}

async function attachmentDataUrl(attachment: ComposerAttachment): Promise<string | undefined> {
  if (attachment.file) return readBlobAsDataUrl(attachment.file);
  if (attachment.previewUrl?.startsWith("data:")) return attachment.previewUrl;
  if (attachment.path) return (await readFileDataUrl(attachment.path)) ?? undefined;
  return undefined;
}

function referenceLine(attachment: ComposerAttachment): string | null {
  const path = attachment.path ?? attachment.uploadedPath;
  if (!path) return null;
  return attachment.kind === "directory" ? `目录：${path}` : `文件：${path}`;
}

export async function prepareAgentPrompt(payload: ComposerSubmitPayload): Promise<PreparedAgentPrompt> {
  const text = payload.text.trim();
  const images: AgentPromptPart[] = [];
  const displayImages: ImageEntry[] = [];
  const references: string[] = [];

  for (const attachment of payload.attachments) {
    if (attachment.kind === "image") {
      const dataUrl = await attachmentDataUrl(attachment);
      const parsed = dataUrl ? parseDataUrl(dataUrl) : null;
      if (parsed) {
        images.push({ type: "image", data: parsed.data, mimeType: attachment.mimeType || parsed.mimeType });
        displayImages.push({
          url: dataUrl,
          alt: attachment.name,
          title: attachment.name,
          name: attachment.name,
          mimeType: attachment.mimeType || parsed.mimeType,
        });
        continue;
      }
    }
    const line = referenceLine(attachment);
    if (line) references.push(line);
  }

  const fullText = references.length
    ? `${text}${text ? "\n\n" : ""}${references.join("\n")}`
    : text;
  const prompt: AgentPromptInput = images.length
    ? [...(fullText ? [{ type: "text" as const, text: fullText }] : []), ...images]
    : fullText;

  return {
    prompt,
    displayText: buildComposerDisplayText(payload),
    displayImages,
  };
}

/**
 * 重试 / 再次发送（design.md 4.21）：从前端运行时里的用户消息取 parts 还原 prompt。
 * 文本 part 拼接，data URL 形式的图片 part 还原成 base64 图片；由时间线重建的消息（restored）
 * 没有图片，只剩文本。没有可发送内容时返回 null。
 */
export function promptFromUserMessage(message: AgentUIMessage): PreparedAgentPrompt | null {
  const texts: string[] = [];
  const images: AgentPromptPart[] = [];
  const displayImages: ImageEntry[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      if (part.text) texts.push(part.text);
      continue;
    }
    if (part.type !== "image") continue;
    const url = typeof part.url === "string" ? part.url : undefined;
    const parsed = url ? parseDataUrl(url) : null;
    if (!url || !parsed) continue;
    const mimeType = typeof part.mimeType === "string" && part.mimeType ? part.mimeType : parsed.mimeType;
    images.push({ type: "image", data: parsed.data, mimeType });
    displayImages.push({
      url,
      mimeType,
      ...(typeof part.name === "string" ? { name: part.name } : {}),
      ...(typeof part.alt === "string" ? { alt: part.alt } : {}),
      ...(typeof part.title === "string" ? { title: part.title } : {}),
    });
  }
  const text = texts.join("\n");
  if (!text && images.length === 0) return null;
  return {
    prompt: images.length ? [...(text ? [{ type: "text" as const, text }] : []), ...images] : text,
    displayText: text,
    displayImages,
  };
}
