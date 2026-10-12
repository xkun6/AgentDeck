/**
 * 前端 ↔ Node sidecar 的 Agent 协议类型（JSON-RPC 2.0 over WebSocket）。
 *
 * 契约来源：docs/design.md 第 4 节。改这里之前先改 design.md。
 * 类型形状移植自 paseo packages/server/src/server/agent/agent-sdk-types.ts（Apache-2.0，精简版）。
 * 本文件只放纯 TS 类型与少量常量，不依赖 zod，前端与 sidecar 共用。
 */

// ---------------------------------------------------------------------------
// 4.3 共享类型
// ---------------------------------------------------------------------------

export type AgentProviderId = string; // "claude" | "codex" | "mock" | `acp:${string}`
export type AgentProviderKind = "claude" | "codex" | "acp" | "mock";

export interface ProviderInfo {
  id: AgentProviderId;
  kind: AgentProviderKind;
  label: string;
  available: boolean;
  unavailableReason?: string;
  command?: string[]; // ACP 的启动命令；claude/codex 为解析到的可执行文件
}

export interface AgentMode {
  id: string;
  label: string;
  description?: string;
  /** 跳过权限确认类模式（Claude bypassPermissions、Codex full-access），前端据此标红 */
  dangerous?: boolean;
}
export interface AgentModelDefinition {
  provider: AgentProviderId;
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}

export type AgentPromptInput =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string } // data 为 base64
    >;

export interface AgentUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  contextWindowMaxTokens?: number;
  contextWindowUsedTokens?: number;
}

export type ToolCallDetail =
  | { type: "shell"; command: string; cwd?: string; output?: string; exitCode?: number | null }
  | { type: "read"; filePath: string; content?: string; offset?: number; limit?: number }
  | { type: "edit"; filePath: string; oldString?: string; newString?: string; unifiedDiff?: string }
  | { type: "write"; filePath: string; content?: string }
  | {
      type: "search";
      query: string;
      toolName?: "search" | "grep" | "glob" | "web_search";
      content?: string;
      filePaths?: string[];
    }
  | { type: "fetch"; url: string; prompt?: string; result?: string }
  | { type: "plan"; text: string }
  | { type: "plain_text"; label?: string; text?: string }
  | { type: "unknown"; input: unknown; output: unknown };

export type ToolCallStatus = "running" | "completed" | "failed" | "canceled";
export interface ToolCallTimelineItem {
  type: "tool_call";
  callId: string;
  name: string;
  status: ToolCallStatus;
  detail: ToolCallDetail;
  error?: string | null;
  metadata?: Record<string, unknown>;
}

export type AgentTimelineItem =
  | { type: "user_message"; text: string; messageId?: string; clientMessageId?: string }
  | { type: "assistant_message"; text: string; messageId?: string } // 增量 chunk，前端按 messageId/顺序拼接
  | { type: "reasoning"; text: string } // 增量 chunk
  | ToolCallTimelineItem // 同 callId 多次推送，后者覆盖前者
  | { type: "todo"; items: { text: string; completed: boolean }[] }
  | { type: "error"; message: string };

export interface AgentPermissionAction {
  id: string;
  label: string;
  behavior: "allow" | "deny";
}
export interface AgentPermissionRequest {
  id: string;
  provider: AgentProviderId;
  name: string;
  kind: "tool" | "plan" | "question" | "mode" | "other";
  title?: string;
  description?: string;
  input?: Record<string, unknown>;
  detail?: ToolCallDetail;
  actions?: AgentPermissionAction[];
}
export type AgentPermissionResponse =
  | { behavior: "allow"; selectedActionId?: string; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; selectedActionId?: string; message?: string; interrupt?: boolean };

export type AgentStreamEvent =
  | { type: "thread_started"; sessionId: string }
  | { type: "turn_started"; turnId: string }
  | { type: "turn_completed"; turnId: string; usage?: AgentUsage }
  | { type: "turn_failed"; turnId: string; error: string; code?: string }
  | { type: "turn_canceled"; turnId: string; reason: string }
  | { type: "timeline"; turnId?: string; item: AgentTimelineItem }
  | { type: "permission_requested"; turnId?: string; request: AgentPermissionRequest }
  | { type: "permission_resolved"; requestId: string; response: AgentPermissionResponse }
  | { type: "usage_updated"; usage: AgentUsage }
  | { type: "model_changed"; modelId: string | null }
  | { type: "mode_changed"; modeId: string };

export interface AgentStreamEnvelope {
  agentId: string;
  seq: number;
  epoch: string;
  timestamp: number;
  event: AgentStreamEvent;
}

/** `dormant`：已持久化但未加载到内存的会话（sidecar 重启后的历史会话），再 send 时自动恢复 */
export type AgentStatus = "starting" | "idle" | "running" | "error" | "closed" | "dormant";
export interface AgentPersistenceHandle {
  provider: AgentProviderId;
  sessionId: string;
  nativeHandle?: string;
  metadata?: Record<string, unknown>;
}
export interface AgentSnapshot {
  id: string;
  provider: AgentProviderId;
  cwd: string;
  title?: string;
  model?: string | null;
  modeId?: string | null;
  availableModes?: AgentMode[];
  status: AgentStatus;
  activeTurnId?: string | null;
  pendingPermissions: AgentPermissionRequest[];
  lastUsage?: AgentUsage;
  lastError?: string | null;
  persistence?: AgentPersistenceHandle | null;
  /** 首条用户消息前 120 字（首尾空白去掉、换行压成空格） */
  preview?: string;
  /** 该 agent 当前最大 seq，无事件为 0 */
  lastSeq: number;
  /** 有 persistence 句柄且 provider 支持 resumeSession */
  resumable: boolean;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 线协议
// ---------------------------------------------------------------------------

export type AgentRpcId = string | number;

export interface AgentRpcRequest<M extends string = string, P = unknown> {
  jsonrpc: "2.0";
  id: AgentRpcId;
  method: M;
  params?: P;
}

export interface AgentRpcNotification<M extends string = string, P = unknown> {
  jsonrpc: "2.0";
  method: M;
  params: P;
}

export interface AgentRpcErrorObject {
  code: number;
  message: string;
  data?: { code?: AgentRpcBusinessErrorCode | string; [key: string]: unknown };
}

export type AgentRpcResponse<R = unknown> =
  | { jsonrpc: "2.0"; id: AgentRpcId | null; result: R }
  | { jsonrpc: "2.0"; id: AgentRpcId | null; error: AgentRpcErrorObject };

/** JSON-RPC 标准错误码 + 业务错误码（design.md 第 4 节） */
export const AGENT_RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  BUSINESS_ERROR: -32000,
} as const;

/** `-32000` 业务错误时 `error.data.code` 的取值 */
export type AgentRpcBusinessErrorCode =
  | "PROVIDER_NOT_FOUND"
  | "PROVIDER_UNAVAILABLE"
  | "AGENT_NOT_FOUND"
  | "AGENT_CLOSED"
  | "TURN_IN_PROGRESS"
  | "PERMISSION_NOT_FOUND"
  | "NOT_SUPPORTED"
  | "INTERNAL_ERROR";

// ---------------------------------------------------------------------------
// 4.1 请求方法 / 4.2 通知：方法名常量与参数/返回映射
// ---------------------------------------------------------------------------

export const AGENT_RPC_METHODS = {
  sidecarInfo: "sidecar.info",
  providerList: "provider.list",
  providerListModels: "provider.listModels",
  agentCreate: "agent.create",
  agentList: "agent.list",
  agentSend: "agent.send",
  agentCancel: "agent.cancel",
  agentPermissionRespond: "agent.permission.respond",
  agentSetModel: "agent.setModel",
  agentSetMode: "agent.setMode",
  agentClose: "agent.close",
  agentTimeline: "agent.timeline",
  agentDelete: "agent.delete",
} as const;

export const AGENT_RPC_NOTIFICATIONS = {
  agentStream: "agent.stream",
  agentState: "agent.state",
  agentRemoved: "agent.removed",
} as const;

/** 无参数方法：`params` 可省略或为空对象 */
export type AgentRpcEmptyParams = Record<string, never> | undefined;

export interface AgentRpcMethods {
  "sidecar.info": { params: AgentRpcEmptyParams; result: { version: string; pid: number } };
  "provider.list": { params: AgentRpcEmptyParams; result: ProviderInfo[] };
  "provider.listModels": {
    params: { provider: AgentProviderId; cwd?: string };
    result: { models: AgentModelDefinition[]; modes: AgentMode[] };
  };
  "agent.create": {
    params: {
      provider: AgentProviderId;
      cwd: string;
      model?: string;
      modeId?: string;
      title?: string;
    };
    result: { agent: AgentSnapshot };
  };
  "agent.list": { params: AgentRpcEmptyParams; result: { agents: AgentSnapshot[] } };
  "agent.send": {
    params: { agentId: string; prompt: AgentPromptInput; clientMessageId?: string };
    result: { turnId: string };
  };
  "agent.cancel": { params: { agentId: string }; result: Record<string, never> };
  "agent.permission.respond": {
    params: { agentId: string; requestId: string; response: AgentPermissionResponse };
    result: Record<string, never>;
  };
  "agent.setModel": {
    params: { agentId: string; modelId: string | null };
    result: { agent: AgentSnapshot };
  };
  "agent.setMode": { params: { agentId: string; modeId: string }; result: { agent: AgentSnapshot } };
  "agent.close": { params: { agentId: string }; result: Record<string, never> };
  "agent.timeline": {
    params: { agentId: string; sinceSeq?: number };
    result: { epoch: string; entries: AgentStreamEnvelope[] };
  };
  "agent.delete": { params: { agentId: string }; result: Record<string, never> };
}

export type AgentRpcMethodName = keyof AgentRpcMethods;
export type AgentRpcParams<M extends AgentRpcMethodName> = AgentRpcMethods[M]["params"];
export type AgentRpcResult<M extends AgentRpcMethodName> = AgentRpcMethods[M]["result"];

export interface AgentRpcNotifications {
  "agent.stream": AgentStreamEnvelope;
  "agent.state": { agent: AgentSnapshot };
  "agent.removed": { agentId: string };
}

export type AgentRpcNotificationName = keyof AgentRpcNotifications;
export type AgentRpcNotificationParams<N extends AgentRpcNotificationName> =
  AgentRpcNotifications[N];
