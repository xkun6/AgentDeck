import type { AssistantTurnBlock, ImageEntry, ToolEntry } from "@/stores/chat";

export type ChatRole = "user" | "assistant" | "system" | "tool";

/** provider 子代理父卡片（sub_agent detail，design.md 4.11） */
export interface ChatSubAgentInfo {
  subAgentType?: string;
  description?: string;
  log: string;
}

export interface ChatToolItem extends ToolEntry {
  arguments?: Record<string, unknown>;
  images?: ChatImageItem[];
  subAgent?: ChatSubAgentInfo;
}

export type ChatImageItem = ImageEntry;

export interface AssistantMessageStats {
  ttftMs?: number;
  durationMs?: number;
  tokensTotal?: number;
  tokensInput?: number;
  tokensOutput?: number;
  tokensCompletion?: number;
  tokPerSec?: number;
  cacheRead?: number;
  cacheWrite?: number;
  costUsd?: number;
  model?: string;
  apiCalls?: number;
  finishReason?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  createdAt: number;
  text?: string;
  reasoning?: string;
  images?: ChatImageItem[];
  tools?: ChatToolItem[];
  blocks?: AssistantTurnBlock[];
  status?: "streaming" | "complete" | "error";
  title?: string;
  error?: boolean;
  stats?: AssistantMessageStats;
  /** 回合以失败 / 中断结束留下的提示：对应的用户消息 id，可在此处重试（design.md 4.21） */
  retryUserMessageId?: string;
  /** 用户消息由时间线重建，图片没有保存（design.md 4.21） */
  restored?: boolean;
}
