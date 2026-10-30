import type {
  AgentMessagePart,
  AgentUIMessage,
} from "@agentdeck/protocol";
import {
  normalizeCliThinkingProgress,
  normalizeReasoningText,
} from "@/lib/reasoning-filter";
import { extractImagePartsFromUnknown, isAnchoredImageSource } from "@/lib/message-images";
import { toolDisplayName } from "@/lib/computer-use-tools";
import type { AssistantTurnBlock } from "@/stores/chat";
import type {
  AssistantMessageStats,
  ChatImageItem,
  ChatMessage,
  ChatSubAgentInfo,
  ChatToolItem,
} from "./chat-types";

type AgentToolPart = Extract<AgentMessagePart, { type: "tool" }>;
type AgentImagePart = Extract<AgentMessagePart, { type: "image" }>;

function normalizeContent(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

function displayUnknown(value: unknown): string | undefined {
  if (typeof value === "string") return normalizeContent(value);
  if (value == null) return undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function imagePartToEntry(part: AgentImagePart): ChatImageItem {
  const record = part as Record<string, unknown>;
  const url =
    part.url ||
    part.src ||
    part.path ||
    part.data ||
    (typeof record.image_url === "string" ? record.image_url : undefined) ||
    (record.image_url && typeof record.image_url === "object"
      ? (record.image_url as Record<string, unknown>).url
      : undefined);
  const name = part.name || part.filename || part.file_name || (typeof url === "string" && !url.startsWith("data:")
    ? url.replace(/\\/g, "/").split("/").pop()
    : undefined);
  return {
    ...(typeof url === "string" && url ? { url } : {}),
    ...(part.alt || name ? { alt: part.alt || name } : {}),
    ...(part.title ? { title: part.title } : {}),
    ...(name ? { name } : {}),
    ...(part.mimeType || part.mime_type || part.mediaType || part.contentType || part.content_type
      ? { mimeType: part.mimeType || part.mime_type || part.mediaType || part.contentType || part.content_type }
      : {}),
  };
}

function normalizeAssistantBlocks(
  blocks: AssistantTurnBlock[] | undefined,
  options: { includeProgress?: boolean } = {},
): AssistantTurnBlock[] | undefined {
  if (!blocks?.length) return undefined;

  const normalized: AssistantTurnBlock[] = [];
  for (const block of blocks) {
    if (block.type === "progress") {
      if (options.includeProgress) normalized.push(block);
      continue;
    }

    if (block.type !== "reasoning") {
      normalized.push(block);
      continue;
    }

    const progress = normalizeContent(normalizeCliThinkingProgress(block.text));
    if (progress && options.includeProgress) {
      normalized.push({ type: "progress", text: progress });
      continue;
    }

    const text = normalizeContent(normalizeReasoningText(block.text));
    if (text) normalized.push({ type: "reasoning", text });
  }

  return normalized.length ? normalized : undefined;
}

function summarizeArgs(args: Record<string, unknown>): string | undefined {
  const preferredKeys = ["context", "command", "cmd", "path", "file", "query", "url"];
  for (const key of preferredKeys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  const first = Object.entries(args).find(([, value]) => {
    return typeof value === "string" || typeof value === "number";
  });
  if (!first) return undefined;
  return `${first[0]}=${String(first[1])}`;
}

function parseToolInput(value: unknown): {
  context?: string;
  arguments?: Record<string, unknown>;
} {
  if (typeof value === "string") return { context: value };
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const args = value as Record<string, unknown>;
  return {
    context: summarizeArgs(args),
    arguments: args,
  };
}

function readSubAgent(value: unknown): ChatSubAgentInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.subAgentType === "string" ? { subAgentType: record.subAgentType } : {}),
    ...(typeof record.description === "string" ? { description: record.description } : {}),
    log: typeof record.log === "string" ? record.log : "",
  };
}

function toolPartToToolEntry(part: AgentToolPart, message: AgentUIMessage): ChatToolItem {
  const subAgent = readSubAgent(part.subAgent);
  const delegate = part.delegate as ChatToolItem["delegate"];
  const input = parseToolInput(part.input);
  const images = extractImagePartsFromUnknown("imageSource" in part ? part.imageSource : part.output)
    .filter((image) => isAnchoredImageSource(image.url))
    .map(imagePartToEntry);
  return {
    tool_id: part.toolCallId,
    name: toolDisplayName(part.name),
    status: part.state,
    context: input.context,
    preview: part.preview,
    summary: displayUnknown(part.output),
    error: part.errorText,
    startedAt: part.startedAt ?? message.createdAt,
    completedAt: part.completedAt,
    arguments: input.arguments,
    images: images.length ? images : undefined,
    ...(subAgent ? { subAgent } : {}),
    ...(delegate ? { delegate } : {}),
  };
}

function partsToBlocks(
  message: AgentUIMessage,
  options: { includeProgress?: boolean } = {},
): AssistantTurnBlock[] | undefined {
  const blocks: AssistantTurnBlock[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      const text = normalizeContent(part.text);
      if (text) blocks.push({ type: "text", text, ...(part.source ? { source: part.source } : {}) });
      continue;
    }
    if (part.type === "reasoning") {
      const text = normalizeContent(part.text);
      if (text) blocks.push({ type: "reasoning", text });
      continue;
    }
    if (part.type === "progress") {
      if (options.includeProgress) blocks.push({ type: "progress", text: part.text });
      continue;
    }
    if (part.type === "image") {
      blocks.push({ type: "image", image: imagePartToEntry(part) });
      continue;
    }
    if (part.type === "steer") {
      const text = normalizeContent(part.text);
      if (text || part.images?.length || part.imageCount) {
        blocks.push({
          type: "steer",
          text: text ?? "",
          ...(part.translatedText ? { translatedText: part.translatedText } : {}),
          ...(part.images?.length ? { images: part.images.map(imagePartToEntry) } : {}),
          ...(part.imageCount ? { imageCount: part.imageCount } : {}),
        });
      }
      continue;
    }
    if (part.type === "moa_reference") {
      const text = normalizeContent(part.text);
      if (text) {
        blocks.push({
          type: "moa_reference",
          label: part.label,
          text,
          index: part.index,
          count: part.count,
        });
      }
      continue;
    }
    if (part.type === "tool") {
      blocks.push({ type: "tool", tool: toolPartToToolEntry(part, message) });
    }
  }

  return normalizeAssistantBlocks(blocks, options);
}

function textFromParts(parts: AgentMessagePart[]): string | undefined {
  const text = parts
    .filter((part): part is Extract<AgentMessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
  return normalizeContent(text);
}

function reasoningFromParts(parts: AgentMessagePart[]): string | undefined {
  const reasoning = parts
    .filter((part): part is Extract<AgentMessagePart, { type: "reasoning" }> => part.type === "reasoning")
    .map((part) => part.text)
    .join("");
  return normalizeContent(normalizeReasoningText(reasoning));
}

function noticeTextFromParts(parts: AgentMessagePart[]): string | undefined {
  const text = parts
    .filter((part): part is Extract<AgentMessagePart, { type: "notice" }> => part.type === "notice")
    .map((part) => part.text)
    .join("\n\n");
  return normalizeContent(text);
}

function imagesFromParts(parts: AgentMessagePart[]): ChatImageItem[] | undefined {
  const images = parts
    .filter((part): part is AgentImagePart => part.type === "image")
    .map(imagePartToEntry);
  return images.length ? images : undefined;
}

function messageHasErrorNotice(message: AgentUIMessage): boolean {
  return message.parts.some((part) => part.type === "notice" && part.level === "error");
}

export function deriveAssistantStats(msg: AgentUIMessage): AssistantMessageStats | undefined {
  if (msg.role !== "assistant") return undefined;

  const usage = msg.metadata?.usage;
  const timing = msg.metadata?.timing;
  const stats: AssistantMessageStats = {};

  if (typeof timing?.ttftMs === "number") {
    stats.ttftMs = timing.ttftMs;
  } else if (
    typeof timing?.startedAt === "number" &&
    typeof timing?.firstTokenAt === "number" &&
    timing.firstTokenAt >= timing.startedAt
  ) {
    stats.ttftMs = timing.firstTokenAt - timing.startedAt;
  }

  if (typeof timing?.durationMs === "number") {
    stats.durationMs = timing.durationMs;
  } else if (
    typeof timing?.startedAt === "number" &&
    typeof timing?.completedAt === "number" &&
    timing.completedAt > timing.startedAt
  ) {
    stats.durationMs = timing.completedAt - timing.startedAt;
  }

  if (usage) {
    if (typeof usage.tokensTotal === "number") stats.tokensTotal = usage.tokensTotal;
    if (typeof usage.tokensInput === "number") stats.tokensInput = usage.tokensInput;
    if (typeof usage.tokensOutput === "number") stats.tokensOutput = usage.tokensOutput;
    if (typeof usage.tokensCompletion === "number") stats.tokensCompletion = usage.tokensCompletion;
    if (typeof usage.cacheRead === "number") stats.cacheRead = usage.cacheRead;
    if (typeof usage.cacheWrite === "number") stats.cacheWrite = usage.cacheWrite;
    if (typeof usage.apiCalls === "number") stats.apiCalls = usage.apiCalls;
    if (
      typeof usage.outputTokensPerSecond === "number" &&
      Number.isFinite(usage.outputTokensPerSecond) &&
      usage.outputTokensPerSecond > 0
    ) {
      stats.tokPerSec = usage.outputTokensPerSecond;
    }
  }

  if (typeof msg.metadata?.model === "string" && msg.metadata.model) {
    stats.model = msg.metadata.model;
  }
  if (typeof msg.metadata?.finishReason === "string") {
    stats.finishReason = msg.metadata.finishReason;
  }

  const costStatus = typeof msg.metadata?.costStatus === "string"
    ? msg.metadata.costStatus.toLowerCase()
    : undefined;
  if (
    typeof msg.metadata?.costUsd === "number" &&
    Number.isFinite(msg.metadata.costUsd) &&
    costStatus !== "stale_pricing" &&
    costStatus !== "unknown"
  ) {
    stats.costUsd = msg.metadata.costUsd;
  }

  const hasAny =
    stats.ttftMs !== undefined ||
    stats.durationMs !== undefined ||
    stats.tokensTotal !== undefined ||
    stats.tokensInput !== undefined ||
    stats.tokensOutput !== undefined ||
    stats.tokPerSec !== undefined ||
    stats.cacheRead !== undefined ||
    stats.apiCalls !== undefined ||
    stats.model !== undefined ||
    stats.costUsd !== undefined;

  return hasAny ? stats : undefined;
}

export function agentUIMessageToChatMessage(msg: AgentUIMessage): ChatMessage | null {
  const includeProgress = msg.status === "streaming";
  const text = msg.role === "system"
    ? noticeTextFromParts(msg.parts) ?? textFromParts(msg.parts)
    : textFromParts(msg.parts);
  const reasoning = reasoningFromParts(msg.parts);
  const images = imagesFromParts(msg.parts);
  const blocks = msg.role === "assistant"
    ? partsToBlocks(msg, { includeProgress })
    : undefined;
  const tools = blocks
    ?.filter((block): block is Extract<AssistantTurnBlock, { type: "tool" }> => block.type === "tool")
    .map((block) => block.tool);

  if (!text && !reasoning && !images?.length && !tools?.length && !blocks?.length) return null;

  return {
    id: msg.id,
    role: msg.role,
    createdAt: msg.createdAt,
    text,
    reasoning,
    images,
    tools: tools?.length ? tools : undefined,
    blocks,
    status: msg.status,
    error: msg.status === "error" || messageHasErrorNotice(msg),
    stats: deriveAssistantStats(msg),
    ...(typeof msg.retryFor === "string" ? { retryUserMessageId: msg.retryFor } : {}),
    ...(msg.restored === true ? { restored: true } : {}),
    ...(typeof msg.firstSeq === "number" ? { firstSeq: msg.firstSeq } : {}),
    ...(typeof msg.translatedText === "string" ? { translatedText: msg.translatedText } : {}),
  };
}

export function agentUIMessagesToChatMessages(messages: AgentUIMessage[]): ChatMessage[] {
  return messages
    .map(agentUIMessageToChatMessage)
    .filter((message): message is ChatMessage => message !== null);
}
