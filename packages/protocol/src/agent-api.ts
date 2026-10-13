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
  kind: AgentProviderKind; // 自定义项取 extends 的值
  label: string;
  available: boolean;
  unavailableReason?: string;
  command?: string[]; // ACP 的启动命令；claude/codex 为解析到的可执行文件
  /** 来自 providers.json 的自定义 provider（id 形如 `custom:<id>`） */
  custom?: boolean;
  extends?: ProviderProfileExtends;
  description?: string;
}

// ---------------------------------------------------------------------------
// 4.7 自定义 provider / 三方中转
// ---------------------------------------------------------------------------

export type ProviderProfileExtends = "claude" | "codex" | "acp";
export type ProviderProfileAuthMode = "auth_token" | "api_key";

export interface ProviderProfileModel {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}

/** providers.json 中的一项；provider id 为 `custom:<id>` */
export interface ProviderProfile {
  /** ^[a-z][a-z0-9-]{0,31}$ */
  id: string;
  extends: ProviderProfileExtends;
  /** 1–40 字 */
  label: string;
  description?: string;
  /** 默认 true；false 时不出现在 provider.list */
  enabled?: boolean;
  /** http(s) URL，保存时去掉末尾 / */
  baseUrl?: string;
  apiKey?: string;
  /** 仅 claude，默认 auth_token */
  authMode?: ProviderProfileAuthMode;
  /** 额外环境变量，最后应用（可覆盖推导值） */
  env?: Record<string, string>;
  /** acp 必填；claude / codex 可选：覆盖可执行文件 */
  command?: string[];
  models?: ProviderProfileModel[];
  /** 仅 claude */
  disallowedTools?: string[];
  /**
   * 仅 claude（其它 extends 填写时校验失败）：Claude Code 设置（JSON 对象），明文保存在 providers.json。
   * 合并顺序：settings → 推导 env → env，结果作为一份 JSON 经 `--settings` 传入。
   */
  settings?: Record<string, unknown>;
}

/** `<AGENTDECK_DATA_DIR>/providers.json` */
export interface ProviderConfigFile {
  version: 1;
  providers: ProviderProfile[];
}

/** provider.test 的结果（不发起对话，不计费） */
export interface ProviderTestResult {
  ok: boolean;
  status?: number;
  latencyMs?: number;
  models?: { id: string; label: string }[];
  /** 中文错误信息，不含密钥 */
  error?: string;
}

/** 自定义 provider 的 id 前缀 */
export const CUSTOM_PROVIDER_ID_PREFIX = "custom:";

export interface AgentMode {
  id: string;
  label: string;
  description?: string;
  /** 跳过权限确认类模式（Claude bypassPermissions、Codex full-access），前端据此标红 */
  dangerous?: boolean;
}
/** 思考强度档位（design.md 4.10） */
export interface AgentThinkingOption {
  id: string;
  label: string;
  description?: string;
}
export interface AgentModelDefinition {
  provider: AgentProviderId;
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  /** 该模型可选的思考强度；缺省表示不支持选择（前端隐藏选择器） */
  thinkingOptions?: AgentThinkingOption[];
  /** provider 自身的默认档位（仅供展示；快照中 null 才表示跟随 CLI） */
  defaultThinkingOptionId?: string;
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
  /**
   * provider 子代理（Claude Task/Agent、Codex collab）的父卡片（design.md 4.11）。
   * 显示名 `subAgentType ?? "Task"`，摘要为 description；log 每行形如 `[Read] foo.ts`。
   */
  | {
      type: "sub_agent";
      subAgentType?: string;
      description?: string;
      childSessionId?: string;
      log: string;
      actions?: { index: number; toolName: string; summary?: string }[];
    }
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
  /** modeId 为 null 表示回到「跟随 Agent 设置」（如 Claude 批准计划后切回用户默认模式） */
  | { type: "mode_changed"; modeId: string | null }
  /** 思考强度变化（design.md 4.10）；null 表示跟随 CLI 自身设置 */
  | { type: "thinking_option_changed"; thinkingOptionId: string | null };

export interface AgentStreamEnvelope {
  agentId: string;
  seq: number;
  epoch: string;
  timestamp: number;
  event: AgentStreamEvent;
}

// ---------------------------------------------------------------------------
// 4.11 provider 子代理（移植自 paseo provider-subagents/store.ts 与 protocol messages.ts，精简版）
// ---------------------------------------------------------------------------

export type ProviderSubagentStatus = "running" | "completed" | "failed" | "canceled";

/** 一个 provider 子代理（Claude 的 Task/Agent 子代理、Codex 的子线程）；只存在于 sidecar 内存中 */
export interface ProviderSubagentDescriptor {
  /** Claude：Task 工具调用的 tool_use_id；Codex：子线程 id */
  id: string;
  parentAgentId: string;
  /** 直接上级 provider 子代理；null 表示父会话的直接子代理 */
  parentSubagentId: string | null;
  provider: AgentProviderId;
  /** 子代理类型（如 Explore）；同一批并发子代理通常相同 */
  title: string | null;
  /** 交给该子代理的任务，用于区分兄弟子代理 */
  description: string | null;
  status: ProviderSubagentStatus;
  createdAt: number;
  updatedAt: number;
  /** 父时间线中对应的工具卡片 callId */
  toolCallId: string | null;
  cwd: string | null;
  /** provider 给出的完整次级标签（如「Explore · Haiku 4.5 · 12.3k tokens」），前端原样显示 */
  subtitle: string | null;
}

/** 子代理时间线的一行；seq 在同一子代理内从 1 递增 */
export interface ProviderSubagentTimelineRow {
  seq: number;
  timestamp: number;
  item: AgentTimelineItem;
}

/** `agent.subagents.update` 通知 */
export type ProviderSubagentUpdate =
  | { kind: "upsert"; agentId: string; subagent: ProviderSubagentDescriptor }
  | { kind: "timeline"; agentId: string; subagentId: string; row: ProviderSubagentTimelineRow }
  | { kind: "remove"; agentId: string; subagentId: string };

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
  /** 思考强度档位；null / 缺省 = 跟随 CLI 自身设置（design.md 4.10） */
  thinkingOptionId?: string | null;
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
  agentSetThinking: "agent.setThinking",
  agentClose: "agent.close",
  agentTimeline: "agent.timeline",
  agentDelete: "agent.delete",
  agentSubagentsList: "agent.subagents.list",
  agentSubagentsTimeline: "agent.subagents.timeline",
  providerConfigGet: "provider.config.get",
  providerConfigSet: "provider.config.set",
  providerTest: "provider.test",
} as const;

export const AGENT_RPC_NOTIFICATIONS = {
  agentStream: "agent.stream",
  agentState: "agent.state",
  agentRemoved: "agent.removed",
  providerChanged: "provider.changed",
  agentSubagentsUpdate: "agent.subagents.update",
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
      /** null / 省略 = 跟随 CLI 自身设置 */
      thinkingOptionId?: string | null;
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
  /** 下一轮生效；运行中切换时 notice 为中文提示（design.md 4.10） */
  "agent.setThinking": {
    params: { agentId: string; thinkingOptionId: string | null };
    result: { agent: AgentSnapshot; notice?: string };
  };
  "agent.close": { params: { agentId: string }; result: Record<string, never> };
  "agent.timeline": {
    params: { agentId: string; sinceSeq?: number };
    result: { epoch: string; entries: AgentStreamEnvelope[] };
  };
  "agent.delete": { params: { agentId: string }; result: Record<string, never> };
  /** 该会话当前已知的 provider 子代理（按 createdAt 升序，含各层级） */
  "agent.subagents.list": {
    params: { agentId: string };
    result: { subagents: ProviderSubagentDescriptor[] };
  };
  /**
   * 子代理时间线分页：direction 缺省 tail（最近 limit 条）；before 取 seq < cursorSeq 的最近 limit 条；
   * after 取 seq > cursorSeq 的前 limit 条。limit 缺省 200、上限 1000。子代理不存在返回空 rows。
   */
  "agent.subagents.timeline": {
    params: {
      agentId: string;
      subagentId: string;
      direction?: "tail" | "before" | "after";
      cursorSeq?: number;
      limit?: number;
    };
    result: { rows: ProviderSubagentTimelineRow[]; hasOlder: boolean; hasNewer: boolean };
  };
  /** 含明文 apiKey（仅本机 token 鉴权的连接可见，前端负责遮挡显示）；未设 AGENTDECK_DATA_DIR 时 path 为 null */
  "provider.config.get": {
    params: AgentRpcEmptyParams;
    result: { providers: ProviderProfile[]; path: string | null };
  };
  /** 整表替换；校验失败返回 -32602（data.issues）；未设 AGENTDECK_DATA_DIR 时返回 NOT_SUPPORTED */
  "provider.config.set": {
    params: { providers: ProviderProfile[] };
    result: { providers: ProviderInfo[] };
  };
  /** 可测试未保存的表单 */
  "provider.test": { params: { profile: ProviderProfile }; result: ProviderTestResult };
}

export type AgentRpcMethodName = keyof AgentRpcMethods;
export type AgentRpcParams<M extends AgentRpcMethodName> = AgentRpcMethods[M]["params"];
export type AgentRpcResult<M extends AgentRpcMethodName> = AgentRpcMethods[M]["result"];

export interface AgentRpcNotifications {
  "agent.stream": AgentStreamEnvelope;
  "agent.state": { agent: AgentSnapshot };
  "agent.removed": { agentId: string };
  /** providers.json 被替换后广播，前端据此刷新 provider.list */
  "provider.changed": Record<string, never>;
  /** provider 子代理描述 / 时间线变化（design.md 4.11），向所有连接广播，前端按 agentId 过滤 */
  "agent.subagents.update": ProviderSubagentUpdate;
}

export type AgentRpcNotificationName = keyof AgentRpcNotifications;
export type AgentRpcNotificationParams<N extends AgentRpcNotificationName> =
  AgentRpcNotifications[N];
