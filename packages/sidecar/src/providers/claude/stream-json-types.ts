// Claude Code CLI 的 stream-json stdio 协议（`--input-format stream-json --output-format stream-json`）
// 中 AgentDeck 实际读写的消息形状。AgentDeck 原创的精简定义：只声明用到的字段，其余字段一律忽略。
// 协议按本机 Claude Code 2.1.x 的实际行为核对：stdin / stdout 都是每行一个 JSON 对象。

/**
 * AgentDeck 暴露的权限模式（CLI 还支持 dontAsk，本项目不用）。
 * `default` 即 CLI 的「Manual」：`manual` 只是 CLI 接受的别名，CLI 内部仍记为 `default`（2.1.296 实测）。
 */
export type ClaudePermissionMode = "default" | "acceptEdits" | "auto" | "plan" | "bypassPermissions";

export type ClaudeImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export type ClaudeUserContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: ClaudeImageMediaType; data: string };
    };

// ---------------------------------------------------------------------------
// stdin：我们写给 CLI 的消息
// ---------------------------------------------------------------------------

/** 一轮用户输入；`uuid` 会在该轮 result 的 `user_message_uuid` 中回显 */
export interface ClaudeUserInput {
  type: "user";
  message: { role: "user"; content: ClaudeUserContentBlock[] };
  parent_tool_use_id: null;
  session_id: string;
  uuid: string;
}

/** 我们发给 CLI 的控制请求体 */
export type ClaudeOutgoingControl =
  /** forwardSubagentText：让 CLI 转发子代理的完整 assistant 消息（与 Agent SDK 相同，design.md 4.11） */
  | { subtype: "initialize"; forwardSubagentText?: boolean; perTaskStopAffordance?: boolean }
  | { subtype: "interrupt" }
  | { subtype: "set_model"; model?: string }
  /** mode 也可能是用户设置里的其它 CLI 模式（切回基础模式时） */
  | { subtype: "set_permission_mode"; mode: string }
  /** MCP 服务器状态（应答见 ClaudeMcpStatusResponse，design.md 4.14） */
  | { subtype: "mcp_status" }
  /** 重连单个 MCP 服务器；失败时控制应答为 error */
  | { subtype: "mcp_reconnect"; serverName: string }
  /** 停止单个后台任务（design.md 4.15） */
  | { subtype: "stop_task"; task_id: string };

/** 对 CLI 控制请求的应答（写入 stdin） */
export interface ClaudeControlResponseOut {
  type: "control_response";
  response:
    | { subtype: "success"; request_id: string; response: Record<string, unknown> }
    | { subtype: "error"; request_id: string; error: string };
}

// ---------------------------------------------------------------------------
// stdout：CLI 输出的消息
// ---------------------------------------------------------------------------

export interface ClaudeContentBlock {
  type?: string;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  text?: unknown;
  thinking?: unknown;
  tool_use_id?: unknown;
  tool_name?: unknown;
  content?: unknown;
  is_error?: unknown;
}

export interface ClaudeSystemMessage {
  type: "system";
  subtype?: string;
  session_id?: string;
}

/**
 * `system` `status` 消息：status 为 requesting / compacting / null；压缩结束时可带 compact_result / compact_error
 * （字段以 @anthropic-ai/claude-agent-sdk 的 SDKStatusMessage 为准，design.md 4.13）。
 */
export interface ClaudeStatusSystemMessage extends ClaudeSystemMessage {
  status?: unknown;
  compact_result?: unknown;
  compact_error?: unknown;
}

/** `system` `compact_boundary` 消息（SDKCompactBoundaryMessage）：上下文压缩完成 */
export interface ClaudeCompactBoundaryMessage extends ClaudeSystemMessage {
  compact_metadata?: { trigger?: unknown; pre_tokens?: unknown; post_tokens?: unknown };
}

/**
 * 子代理 task 协议的 system 消息（subtype 为 task_started / task_updated / task_progress / task_notification）
 * 中用到的字段（Claude Code 2.1.296 实测，design.md 4.11）。
 */
export interface ClaudeTaskSystemMessage extends ClaudeSystemMessage {
  task_id?: unknown;
  tool_use_id?: unknown;
  description?: unknown;
  subagent_type?: unknown;
  /** local_agent / local_workflow / local_bash 等 */
  task_type?: unknown;
  prompt?: unknown;
  skip_transcript?: unknown;
  /** task_started */
  is_backgrounded?: unknown;
  /** task_updated */
  patch?: {
    status?: unknown;
    description?: unknown;
    end_time?: unknown;
    error?: unknown;
    is_backgrounded?: unknown;
  };
  /** task_notification */
  status?: unknown;
  /** task_notification：如 `Background command "…" completed (exit code 0)` */
  summary?: unknown;
  /** task_notification：任务输出文件 */
  output_file?: unknown;
  /** task_progress */
  last_tool_name?: unknown;
  /** task_progress / task_notification */
  usage?: { total_tokens?: unknown; tool_uses?: unknown; duration_ms?: unknown };
}

/**
 * 斜杠命令条目（initialize 应答的 commands 与 `system` `commands_changed` 消息共用；name 不带前导 /）。
 * 字段以 @anthropic-ai/claude-agent-sdk 的 SlashCommand 为准，宽松解析。
 */
export interface ClaudeSlashCommandEntry {
  name?: unknown;
  description?: unknown;
  argumentHint?: unknown;
  aliases?: unknown;
}

/** `system` `commands_changed` 消息：可用斜杠命令变化，整体替换（design.md 4.14） */
export interface ClaudeCommandsChangedMessage extends ClaudeSystemMessage {
  commands?: unknown;
}

/** mcp_status 控制请求的应答（字段以 Agent SDK 的 McpServerStatus 为准，只声明用到的） */
export interface ClaudeMcpStatusResponse {
  mcpServers?: Array<{
    name?: unknown;
    /** connected / failed / needs-auth / pending / disabled */
    status?: unknown;
    error?: unknown;
    scope?: unknown;
    tools?: unknown;
  }>;
}

/** Messages API 流式事件（message_start / content_block_delta / message_delta 等）中用到的字段 */
export interface ClaudeStreamEvent {
  type: string;
  message?: {
    id?: string;
    usage?: {
      input_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
      cache_read_input_tokens?: unknown;
    };
  };
  usage?: { output_tokens?: unknown };
  delta?: { type?: string; text?: unknown; thinking?: unknown };
}

export interface ClaudeStreamEventMessage {
  type: "stream_event";
  /** 非空表示子代理内部输出 */
  parent_tool_use_id?: string | null;
  session_id?: string;
  event: ClaudeStreamEvent;
}

export interface ClaudeAssistantMessage {
  type: "assistant";
  parent_tool_use_id?: string | null;
  session_id?: string;
  /** model 只在子代理帧里用到（子代理 subtitle） */
  message: { id?: unknown; model?: unknown; content?: ClaudeContentBlock[] };
}

/** CLI 回送的 user 消息：主要承载 tool_result 块，`tool_use_result` 为单个工具的结构化输出 */
export interface ClaudeUserOutputMessage {
  type: "user";
  parent_tool_use_id?: string | null;
  session_id?: string;
  message: { content?: unknown };
  tool_use_result?: unknown;
}

/** 一轮结束；subtype 为 success 或 error_*（error_during_execution / error_max_turns 等） */
export interface ClaudeResultMessage {
  type: "result";
  subtype: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  session_id?: string;
  user_message_uuid?: string;
  total_cost_usd?: number;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, { contextWindow?: unknown } | undefined>;
}

/** 交给上层的普通消息（控制类消息由 ClaudeCliSession 内部处理，不会出现在这里） */
export type ClaudeOutputMessage =
  | ClaudeSystemMessage
  | ClaudeStreamEventMessage
  | ClaudeAssistantMessage
  | ClaudeUserOutputMessage
  | ClaudeResultMessage;

/** CLI 发来的工具权限请求（control_request 的 request，subtype 为 can_use_tool） */
export interface ClaudeCanUseToolRequest {
  subtype: "can_use_tool";
  tool_name: string;
  input: Record<string, unknown>;
  tool_use_id?: string;
  title?: string;
  display_name?: string;
  description?: string;
  decision_reason?: string;
}

/** initialize 应答里用到的部分 */
export interface ClaudeInitializeResponse {
  /** 2.1.296 起每项还带 resolvedModel / supportsEffort / supportedEffortLevels（思考强度档位来源） */
  models?: Array<{
    value?: unknown;
    displayName?: unknown;
    description?: unknown;
    resolvedModel?: unknown;
    supportsEffort?: unknown;
    supportedEffortLevels?: unknown;
  }>;
  /** 进程当前的权限模式；未传 --permission-mode 启动时即用户设置的默认模式 */
  current_permission_mode?: unknown;
  /** 可用的斜杠命令（内置命令、skill、项目 / 用户命令；可能重名，design.md 4.14） */
  commands?: ClaudeSlashCommandEntry[];
  /** 当前输出风格名（/status 展示用） */
  output_style?: unknown;
  /** 登录账户信息（SDK AccountInfo：email / organization / subscriptionType / tokenSource / apiKeySource / apiProvider） */
  account?: unknown;
}

// ---------------------------------------------------------------------------
// 权限回调
// ---------------------------------------------------------------------------

export type ClaudePermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string; interrupt?: boolean };

export interface ClaudeCanUseToolContext {
  /** CLI 发来 control_cancel_request 或进程退出时触发 */
  signal: AbortSignal;
  toolUseId?: string;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
}

export type ClaudeCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  context: ClaudeCanUseToolContext,
) => Promise<ClaudePermissionResult>;
