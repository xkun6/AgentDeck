// 前端会话 UI 的视图模型（原 hermes-api.ts 中仍在使用的部分）。
// sidecar 事件经 web/src/stores/chat.ts 归约成这些消息结构后再渲染；
// 类型名沿用历史名称（Hermes* 前缀），只是内部标识符，不出现在界面上。

export type HermesImageSource =
  | string
  | {
      url?: string;
      src?: string;
      path?: string;
      data?: string;
      image_url?: unknown;
      imageUrl?: unknown;
      alt?: string;
      title?: string;
      name?: string;
      filename?: string;
      file_name?: string;
      mimeType?: string;
      mime_type?: string;
      mediaType?: string;
      contentType?: string;
      content_type?: string;
      is_image?: boolean;
      [key: string]: unknown;
    };

export interface HermesMessageUsage {
  tokensInput?: number;
  tokensOutput?: number;
  tokensPrompt?: number;
  tokensCompletion?: number;
  tokensTotal?: number;
  cacheRead?: number;
  cacheWrite?: number;
  apiCalls?: number;
  contextUsed?: number;
  contextMax?: number;
  contextPercent?: number;
  [key: string]: unknown;
}

export interface HermesMessageTiming {
  startedAt?: number;
  firstTokenAt?: number;
  completedAt?: number;
  ttftMs?: number;
  durationMs?: number;
  [key: string]: unknown;
}

export interface HermesMessageMetadata {
  usage?: HermesMessageUsage;
  timing?: HermesMessageTiming;
  model?: string;
  finishReason?: string;
  costUsd?: number | null;
  costStatus?: string;
  persistedId?: string | number;
  [key: string]: unknown;
}

interface HermesTextMessagePart {
  type: "text";
  text: string;
}

interface HermesReasoningMessagePart {
  type: "reasoning";
  text: string;
}

interface HermesProgressMessagePart {
  type: "progress";
  text: string;
}

interface HermesImageMessagePart {
  type: "image";
  url?: string;
  src?: string;
  path?: string;
  data?: string;
  image_url?: unknown;
  imageUrl?: unknown;
  alt?: string;
  title?: string;
  name?: string;
  filename?: string;
  file_name?: string;
  mimeType?: string;
  mime_type?: string;
  mediaType?: string;
  contentType?: string;
  content_type?: string;
  is_image?: boolean;
  [key: string]: unknown;
}

interface HermesToolMessagePart {
  type: "tool";
  toolCallId: string;
  name: string;
  state: "running" | "done" | "error";
  input?: unknown;
  preview?: string;
  output?: unknown;
  errorText?: string;
  startedAt?: number;
  completedAt?: number;
  [key: string]: unknown;
}

interface HermesNoticeMessagePart {
  type: "notice";
  level: "info" | "warning" | "error" | "system";
  text: string;
}

/** 多模型参考输出块（历史结构，保留以兼容渲染层的分支）。 */
interface HermesMoaReferenceMessagePart {
  type: "moa_reference";
  label: string;
  text: string;
  index?: number;
  count?: number;
}

export type HermesMessagePart =
  | HermesTextMessagePart
  | HermesReasoningMessagePart
  | HermesProgressMessagePart
  | HermesImageMessagePart
  | HermesToolMessagePart
  | HermesNoticeMessagePart
  | HermesMoaReferenceMessagePart;

export interface HermesUIMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  createdAt: number;
  status: "streaming" | "complete" | "error";
  parts: HermesMessagePart[];
  metadata?: HermesMessageMetadata;
  [key: string]: unknown;
}

/** 消息时间线底部用量信息（可选，由宿主提供）。 */
export interface SessionUsageResult {
  model?: string;
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  prompt?: number;
  completion?: number;
  total?: number;
  calls?: number;
  context_used?: number;
  context_max?: number;
  context_percent?: number;
  compressions?: number;
  cost_usd?: number;
  cost_status?: string;
  [key: string]: unknown;
}

/** 目录列表条目（下一阶段由 Rust `fs_list` 命令提供）。 */
export interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface FsListResponse {
  path?: string;
  parent?: string | null;
  home?: string;
  error?: string;
  entries: FsEntry[];
}
