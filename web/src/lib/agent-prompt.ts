// 把 composer 的提交内容转成 sidecar 的 AgentPromptInput：
// - 文本原样发送；
// - 图片附件读成 base64 作为 image part（浏览器 File 用 FileReader，本机路径走 read_file_data_url）；
// - 其它文件 / 目录以路径引用的形式附在文本末尾，由 Agent 自己读取。
import type { AgentPromptInput } from "@agentdeck/protocol";
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
