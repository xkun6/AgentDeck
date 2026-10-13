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
  /** 该消息对应的时间线 seq（design.md 4.23：「从这里分叉」传给 agent.fork 的 throughSeq） */
  seq?: number;
}
