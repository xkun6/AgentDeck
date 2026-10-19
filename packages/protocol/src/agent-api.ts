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
  /** provider 能力（design.md 4.22 / 4.23）：steer = 支持运行中插话；fork = 原生分叉（native）或带摘要新开（summary） */
  capabilities?: ProviderCapabilities;
}

export interface ProviderCapabilities {
  steer?: boolean;
  fork?: "native" | "summary";
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
  /**
   * 仅 codex（其它 extends 填写时校验失败）：config.toml 原文（保留注释与格式），明文保存在 providers.json。
   * 只做会话级覆盖，不写用户 ~/.codex。
   */
  codexConfig?: string;
  /**
   * 仅 codex（其它 extends 填写时校验失败）：auth.json 内容（JSON 对象），明文保存在 providers.json。
   * 只读取其中的 OPENAI_API_KEY。
   */
  codexAuth?: Record<string, unknown>;
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

/** 斜杠命令（name 不带前导 /；design.md 4.14） */
export interface AgentSlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  aliases?: string[];
}
export type AgentMcpServerStatus = "connected" | "failed" | "needs-auth" | "pending" | "disabled";
export interface AgentMcpServer {
  name: string;
  status: AgentMcpServerStatus;
  error?: string;
  scope?: string;
  toolCount?: number;
}
/** server = 可按服务器单独重连（Claude）；all = 只能整体重新加载（Codex） */
export type AgentMcpReconnectScope = "server" | "all";
/** 后台任务（design.md 4.15）：Claude 的后台 Shell 命令（子代理 / workflow 不登记，由子代理列表负责；kind 目前恒为 command） */
export type AgentBackgroundTaskKind = "command" | "agent" | "workflow" | "other";
export type AgentBackgroundTaskStatus = "running" | "completed" | "failed" | "stopped";
export interface AgentBackgroundTask {
  taskId: string;
  kind: AgentBackgroundTaskKind;
  description: string;
  status: AgentBackgroundTaskStatus;
  /** 毫秒时间戳 */
  startedAt: number;
  endedAt?: number;
  summary?: string;
  error?: string;
  lastToolName?: string;
  usage?: { totalTokens?: number; toolUses?: number; durationMs?: number };
  /** 有可读的命令输出文件（只对 command） */
  hasOutput?: boolean;
  /** 后台命令文本（取自对应 Bash / PowerShell tool_use 的 input.command） */
  command?: string;
  /** 退出码（从 task_notification 的 summary 解析，解析不到不填） */
  exitCode?: number;
}
export interface AgentBackgroundTaskOutput {
  text: string;
  /** 文件超过 maxBytes，只返回了尾部 */
  truncated: boolean;
  /** 输出文件当前总字节数 */
  size: number;
}
export interface AgentMcpStatusResult {
  servers: AgentMcpServer[];
  reconnect: AgentMcpReconnectScope;
}
/** agent.status 的一个分组：标题 + 标签 / 值行（值为已格式化的中文文本） */
export interface AgentStatusSection {
  title: string;
  rows: Array<{ label: string; value: string }>;
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
  /** 本回合输出速度 tok/s（design.md 4.30）；回合中实时、结束时为最终值，不计入 totalUsage */
  outputTokensPerSecond?: number;
  /** 本回合合格响应的输出 token 之和；只在 turn_completed 给出（design.md 4.30），不计入 totalUsage */
  speedOutputTokens?: number;
  /** 本回合合格响应的生成时长之和（ms）；只在 turn_completed 给出（design.md 4.30），不计入 totalUsage */
  speedGenerationMs?: number;
}

/** 额度窗口（design.md 4.30） */
export interface AgentRateLimitWindow {
  /** "five_hour" | "seven_day" | "primary" | "secondary" | 其它原样 */
  id: string;
  /** 中文，如「5 小时」「7 天」「每周」 */
  label: string;
  /** 0–100 */
  usedPercent: number;
  /** 重置时刻，毫秒 */
  resetsAt?: number;
}

export interface AgentRateLimits {
  windows: AgentRateLimitWindow[];
  status?: "allowed" | "warning" | "rejected";
  /** 毫秒 */
  updatedAt: number;
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
  /** Claude AskUserQuestion（design.md 4.13）；answers 键为 question 原文，多选为 ", " 拼接 */
  | {
      type: "question";
      questions: AgentQuestion[];
      answers?: Record<string, string>;
    }
  /**
   * MCP elicitation（design.md 4.32）：MCP 服务通过 Claude / Codex 向用户索取表单输入或要求在浏览器里完成一步操作。
   * form 模式带 fields（已由 JSON Schema 归一化）；url 模式带 url 与 elicitationId。
   */
  | {
      type: "elicitation";
      serverName: string;
      mode: "form" | "url";
      message: string;
      url?: string;
      elicitationId?: string;
      fields?: ElicitationField[];
    }
  | { type: "unknown"; input: unknown; output: unknown };

export type ElicitationFieldType = "string" | "number" | "integer" | "boolean" | "select" | "multiselect";
export interface ElicitationFieldOption {
  value: string;
  label: string;
}
/** elicitation 表单的一个字段（由 requestedSchema 的 properties 归一化而来，见 sidecar providers/shared/elicitation-schema.ts） */
export interface ElicitationField {
  key: string;
  title?: string;
  description?: string;
  required: boolean;
  type: ElicitationFieldType;
  /** select / multiselect 的选项 */
  options?: ElicitationFieldOption[];
  /** string 的 format：email / uri / date / date-time 等 */
  format?: string;
  /** number / integer 的 minimum / maximum；multiselect 的 minItems / maxItems */
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  /** string / number / boolean 的默认值；select 为选项 value，multiselect 为 value 数组 */
  default?: string | number | boolean | string[];
  /** 输入需要遮罩（format: "password" / writeOnly / 键名像密码） */
  secret?: boolean;
}

export interface AgentQuestionOption {
  label: string;
  description?: string;
  preview?: string;
}
export interface AgentQuestion {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: AgentQuestionOption[];
  /**
   * 是否允许「其他」自由输入。缺省 = 允许（Claude AskUserQuestion 的题目一律带「其他」）；
   * Codex request_user_input 按 `isOther` 显式给出 true / false。
   */
  isOther?: boolean;
  /** 输入框需要遮罩（Codex `isSecret`），作用于「其他」输入与纯文本题 */
  isSecret?: boolean;
  /** 纯文本题：没有选项，只有一个输入框（Codex `options: null`）；options 为空数组时也按纯文本题处理 */
  freeText?: boolean;
}

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
  | {
      type: "user_message";
      text: string;
      messageId?: string;
      clientMessageId?: string;
      /** 运行中插话（design.md 4.22）：归属当前回合，不开新回合 */
      steer?: true;
      /** 会话开启翻译时实际发给 Agent 的文本（design.md 4.35）；与 text 相同时省略 */
      translatedText?: string;
    }
  | { type: "assistant_message"; text: string; messageId?: string; source?: "command" } // 增量 chunk，前端按 messageId/顺序拼接
  | { type: "reasoning"; text: string } // 增量 chunk
  | ToolCallTimelineItem // 同 callId 多次推送，后者覆盖前者
  | { type: "todo"; items: { text: string; completed: boolean }[] }
  | { type: "error"; message: string }
  /** 上下文压缩（design.md 4.13）；同 compactionId 多次推送后者覆盖前者 */
  | {
      type: "compaction";
      compactionId: string;
      status: "running" | "completed" | "failed";
      trigger?: "auto" | "manual";
      preTokens?: number;
      error?: string;
    }
  /** 系统提示（居中显示），如会话分叉后的「已从「X」分叉」（design.md 4.23） */
  | { type: "notice"; text: string };

export interface AgentPermissionAction {
  /**
   * 约定 id（design.md 5.3）：`allow_session` = 本会话始终允许，`allow_project` = 永久允许（写入项目 / 执行策略）；
   * 其余 id 由 provider 自定（Claude allow/deny、Codex accept/decline/cancel、ACP optionId 等）。
   */
  id: string;
  label: string;
  behavior: "allow" | "deny";
  /** 「始终允许」类动作的持久化范围；前端据此用次要样式，避免误点（ACP 的 optionId 不固定，不能只靠 id 判断） */
  persist?: "session" | "permanent";
  /** 动作的补充说明（如永久规则内容与写入位置），前端放在 tooltip 与按钮下方的说明行 */
  description?: string;
}
export interface AgentPermissionRequest {
  id: string;
  provider: AgentProviderId;
  name: string;
  kind: "tool" | "plan" | "question" | "mode" | "elicitation" | "other";
  title?: string;
  description?: string;
  input?: Record<string, unknown>;
  detail?: ToolCallDetail;
  actions?: AgentPermissionAction[];
  /** 为 true 时前端不得把「允许」类按钮作为默认 / 主按钮（Claude `default_to_no`，高风险请求） */
  defaultDeny?: boolean;
}
export type AgentPermissionResponse =
  | { behavior: "allow"; selectedActionId?: string; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; selectedActionId?: string; message?: string; interrupt?: boolean };

/**
 * 轮次来源：`background` 表示 CLI 在没有 agent.send 的情况下自行开始的轮次（如后台子代理完成后的续写）；
 * `keepalive` 表示缓存保活发出的回合（design.md 4.36）
 */
export type AgentTurnOrigin = "background" | "keepalive";

export type AgentStreamEvent =
  | { type: "thread_started"; sessionId: string }
  /** origin 缺省 = 由 agent.send 发起；"background" = CLI 自发轮次（design.md 4.12）；"keepalive" = 缓存保活（4.36） */
  | { type: "turn_started"; turnId: string; origin?: AgentTurnOrigin }
  /** nativeRef：provider 原生回合锚点，供 agent.fork 截断分叉用（Claude = 本轮最后一条 assistant 消息 uuid，Codex = 原生 turnId，design.md 4.23） */
  | { type: "turn_completed"; turnId: string; usage?: AgentUsage; nativeRef?: string }
  | { type: "turn_failed"; turnId: string; error: string; code?: string }
  | { type: "turn_canceled"; turnId: string; reason: string }
  /** 用户在 Agent 首次响应前撤回了本轮消息（design.md 4.16）；回放时据此隐藏该用户消息与本轮 */
  | { type: "user_message_retracted"; turnId: string; clientMessageId?: string }
  | { type: "timeline"; turnId?: string; item: AgentTimelineItem }
  | { type: "permission_requested"; turnId?: string; request: AgentPermissionRequest }
  | { type: "permission_resolved"; requestId: string; response: AgentPermissionResponse }
  | { type: "usage_updated"; usage: AgentUsage }
  /** 账户额度更新（design.md 4.30）；写入快照 rateLimits，不计入 usage */
  | { type: "rate_limits_updated"; rateLimits: AgentRateLimits }
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
  /** 会话累计 token：每次 turn_completed 按本轮用量累加；旧会话无此字段（design.md 4.4） */
  totalUsage?: { inputTokens: number; outputTokens: number };
  /** 最近收到的账户额度（design.md 4.30）；随 meta 持久化 */
  rateLimits?: AgentRateLimits;
  lastError?: string | null;
  /**
   * 本会话有运行中的 provider 子代理或后台任务（design.md 4.11 / 4.15）；由 sidecar 维护，不持久化（缺省 = false）。
   * 前端显示状态时 `status === "running" || backgroundActive` 视为「进行中」；不影响发送与忙碌判断。
   */
  backgroundActive?: boolean;
  persistence?: AgentPersistenceHandle | null;
  /** 首条用户消息前 120 字（首尾空白去掉、换行压成空格） */
  preview?: string;
  /** 该 agent 当前最大 seq，无事件为 0 */
  lastSeq: number;
  /** 有 persistence 句柄且 provider 支持 resumeSession */
  resumable: boolean;
  /** 置顶（design.md 4.17）；缺省视为 false */
  pinned?: boolean;
  /** 归档（design.md 4.17）；缺省视为 false */
  archived?: boolean;
  /**
   * 会话来源（design.md 4.25 / 4.26）：缺省 = 用户新建（"user"）；"schedule" = 定时任务新建；
   * "judge" = 目标循环的隐藏评判会话（前端侧栏与历史页默认不显示）；"delegate" / "group" / "kanban" 见 4.26。
   */
  origin?: AgentOrigin;
  /** 父会话（由其它会话经 agentdeck MCP `delegate` 委派创建，design.md 4.26） */
  parentAgentId?: string;
  /** 并行协作组 id（design.md 4.27） */
  groupId?: string;
  /** 允许被其它会话经 send_to_agent 调用（design.md 4.26），经 agent.update 设置 */
  interopTarget?: boolean;
  /** 会话开启翻译（design.md 4.35），经 agent.update 设置；缺省视为 false */
  translation?: boolean;
  /** 缓存保活（design.md 4.36，仅 Claude），经 agent.update 设置；缺省视为 false */
  cacheKeepAlive?: boolean;
  createdAt: number;
  updatedAt: number;
}

export type AgentOrigin = "user" | "delegate" | "group" | "schedule" | "judge" | "kanban";

// ---------------------------------------------------------------------------
// 4.25 调度器：定时任务、心跳、目标循环
// ---------------------------------------------------------------------------

export type ScheduleTarget =
  | { type: "agent"; agentId: string }
  | {
      type: "new";
      provider: AgentProviderId;
      cwd: string;
      model?: string | null;
      modeId?: string | null;
      thinkingOptionId?: string | null;
      title?: string;
    };

export type ScheduleTrigger = { cron: string } | { everyMinutes: number } | { at: number };

export type GoalState = "running" | "done" | "stopped" | "exhausted" | "failed";

export interface ScheduleBase {
  id: string;
  name: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CronSchedule extends ScheduleBase {
  kind: "cron";
  trigger: ScheduleTrigger;
  target: ScheduleTarget;
  prompt: string;
  onBusy: "skip" | "wait";
}

export interface HeartbeatSchedule extends ScheduleBase {
  kind: "heartbeat";
  agentId: string;
  idleMinutes: number;
  prompt: string;
  maxRuns?: number;
  runs: number;
}

export interface GoalSchedule extends ScheduleBase {
  kind: "goal";
  agentId: string;
  goal: string;
  /** 默认 "GOAL_DONE" */
  doneMarker: string;
  maxIterations: number;
  iterations: number;
  judge?: { provider: AgentProviderId; model?: string | null };
  stopOnFailure: boolean;
  state: GoalState;
}

export type Schedule = CronSchedule | HeartbeatSchedule | GoalSchedule;

/** `schedule.upsert` 入参：无 id 为新建；服务端补齐时间戳与计数字段 */
export type ScheduleDraft =
  | (Omit<CronSchedule, "id" | "enabled" | "createdAt" | "updatedAt"> &
      Partial<Pick<CronSchedule, "id" | "enabled">>)
  | (Omit<HeartbeatSchedule, "id" | "enabled" | "createdAt" | "updatedAt" | "runs"> &
      Partial<Pick<HeartbeatSchedule, "id" | "enabled" | "runs">>)
  | (Omit<
      GoalSchedule,
      | "id"
      | "enabled"
      | "createdAt"
      | "updatedAt"
      | "iterations"
      | "state"
      | "doneMarker"
      | "stopOnFailure"
    > &
      Partial<
        Pick<
          GoalSchedule,
          "id" | "enabled" | "iterations" | "state" | "doneMarker" | "stopOnFailure"
        >
      >);

export interface ScheduleRun {
  scheduleId: string;
  ts: number;
  agentId?: string;
  turnId?: string;
  outcome: "sent" | "skipped_busy" | "skipped_paused" | "missed" | "failed" | "done";
  message?: string;
}

/** `schedule.notice`：目标循环结束 / 定时任务失败，由前端转成系统通知 */
export interface ScheduleNotice {
  scheduleId: string;
  name: string;
  kind: "done" | "exhausted" | "failed";
  message: string;
  agentId?: string;
}

// ---------------------------------------------------------------------------
// 4.28 看板式任务分派
// ---------------------------------------------------------------------------

export interface BoardAssignee {
  provider: AgentProviderId;
  model?: string | null;
  modeId?: string | null;
}

export type BoardTaskStatus = "todo" | "running" | "review" | "done" | "blocked";

export interface BoardSettings {
  /** 每个任务独立 git worktree（默认：项目在 git 仓库内时 true）；非 git 仓库时忽略 */
  worktreePerTask: boolean;
  /** 依赖全部 done 的 todo 按 order 自动派发，受 maxConcurrent 限制 */
  autoDispatch: boolean;
  maxConcurrent: number;
  defaultAssignee: BoardAssignee;
}

export interface BoardTask {
  id: string;
  title: string;
  description: string;
  status: BoardTaskStatus;
  assignee?: BoardAssignee;
  dependsOn?: string[];
  agentId?: string;
  worktree?: { path: string; branch: string };
  attempts: number;
  maxAttempts: number;
  blockedReason?: string;
  order: number;
  createdAt: number;
  updatedAt: number;
}

export interface Board {
  projectPath: string;
  settings: BoardSettings;
  tasks: BoardTask[];
}

/** `board.upsertTask` 入参：无 id 为新建；状态只能经 `board.moveTask` 改变 */
export interface BoardTaskDraft {
  id?: string;
  title: string;
  description?: string;
  /** null = 清除指派（使用看板默认指派） */
  assignee?: BoardAssignee | null;
  dependsOn?: string[];
  maxAttempts?: number;
}

export type BoardSettingsPatch = Partial<Omit<BoardSettings, "defaultAssignee">> & {
  defaultAssignee?: BoardAssignee;
};

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
  | "TASK_NOT_FOUND"
  | "RETRACT_UNAVAILABLE"
  | "RESPONSE_TOO_LARGE"
  /** 翻译未配置或请求失败（design.md 4.35） */
  | "TRANSLATION_FAILED"
  | "INTERNAL_ERROR";

// ---------------------------------------------------------------------------
// 4.19 会话全文搜索 / 4.20 用量统计
// ---------------------------------------------------------------------------

export interface AgentSearchHit {
  agentId: string;
  seq: number;
  timestamp: number;
  role: "user" | "assistant" | "reasoning" | "tool";
  /** 命中处前后各约 60 字，换行压成空格 */
  snippet: string;
  /** 命中在 snippet 内的位置（UTF-16 下标） */
  matchStart: number;
  matchLength: number;
}

export interface UsageTurnRecord {
  /** 回合结束时间（ms） */
  ts: number;
  agentId: string;
  provider: AgentProviderId;
  /** 回合进行时快照中的 model；null = provider 默认 */
  model: string | null;
  turnId: string;
  origin: "user" | "background";
  outcome: "completed" | "failed" | "canceled";
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** turn_started → 结束 */
  durationMs?: number;
  /** turn_started → 本回合第一个 assistant_message */
  ttftMs?: number;
  /** 本回合合格响应的输出 token 之和（取自 turn_completed.usage，design.md 4.30） */
  speedOutputTokens?: number;
  /** 本回合合格响应的生成时长之和（ms，取自 turn_completed.usage，design.md 4.30） */
  speedGenerationMs?: number;
}

export interface UsageSummary {
  /** 历史回填尚未完成 */
  backfilling: boolean;
  totals: {
    turns: number;
    failedTurns: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
  /** day 为 sidecar 进程本地日期 yyyy-MM-dd，升序，只含有数据的日期 */
  byDay: Array<{
    day: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    costUsd: number;
    turns: number;
  }>;
  byProvider: Array<{
    provider: AgentProviderId;
    label: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    turns: number;
  }>;
  byModel: Array<{
    provider: AgentProviderId;
    model: string | null;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    turns: number;
  }>;
  /** 前 10（按 输入+输出 tokens 降序）；title 为用户标题，缺省取首条消息预览；已删除的会话为 null */
  topAgents: Array<{
    agentId: string;
    title: string | null;
    provider: AgentProviderId;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    turns: number;
    deleted: boolean;
  }>;
  perf: {
    ttftP50Ms?: number;
    ttftP95Ms?: number;
    durationP50Ms?: number;
    durationP95Ms?: number;
    /** Σ speedOutputTokens ÷ Σ speedGenerationMs（design.md 4.20 / 4.30）；没有数据时缺省 */
    outputTokensPerSec?: number;
  };
}

// ---------------------------------------------------------------------------
// 4.24 sidecar 设置与按回合文件快照（影子仓库）
// ---------------------------------------------------------------------------

export interface SidecarSettings {
  snapshots: { enabled: boolean; maxFiles: number; maxFileBytes: number };
  /** 4.26 以后实现，目前只存取 */
  interop: { enabled: boolean };
  /** 4.31 远程网关（手机接入）；默认关闭，端口 1024–65535 */
  remote: { enabled: boolean; port: number };
  /** 4.34 空闲会话回收：enabled 默认 true；idleMinutes 默认 15，整数 1–1440 */
  idleReclaim: { enabled: boolean; idleMinutes: number };
  /** 4.35 翻译：语言与显示开关（endpoint 另存，见 TranslationEndpoint） */
  translation: {
    userLanguage: string;
    agentLanguage: string;
    translateReasoning: boolean;
    enabledByDefault: boolean;
  };
}

export interface SidecarSettingsPatch {
  snapshots?: Partial<SidecarSettings["snapshots"]>;
  interop?: Partial<SidecarSettings["interop"]>;
  remote?: Partial<SidecarSettings["remote"]>;
  idleReclaim?: Partial<SidecarSettings["idleReclaim"]>;
  translation?: Partial<SidecarSettings["translation"]>;
}

// ---------------------------------------------------------------------------
// 4.35 翻译
// ---------------------------------------------------------------------------

export type TranslationDirection = "user-to-agent" | "agent-to-user";

/** 翻译 endpoint（`translation-endpoint.json`，含明文密钥；远程客户端不可读写） */
export interface TranslationEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
  protocol: "chat-completions" | "responses";
  reasoningEffort: "default" | "none" | "minimal" | "low" | "medium" | "high";
  timeoutMs: number;
}

// ---------------------------------------------------------------------------
// 4.31 远程网关（安卓 App 接入）
// ---------------------------------------------------------------------------

export interface RemoteAddress {
  host: string;
  port: number;
  kind: "lan" | "tailscale";
}

/** 已配对设备（公开版，不含 secretSha256） */
export interface RemoteDevice {
  deviceId: string;
  name: string;
  pairedAt: number;
  lastSeenAt?: number;
}

export interface RemoteStatus {
  enabled: boolean;
  port: number;
  listening: boolean;
  /** 中文原因：端口被占用、未设置数据目录等 */
  error?: string;
  addresses: RemoteAddress[];
  devices: Array<RemoteDevice & { connected: boolean }>;
}

/**
 * `client.attention`：只发给远程客户端，手机据此弹本地通知。
 * `kind: "resolved"` 是撤回信号（permission_resolved 时发出）：手机据 `agentId` + `requestId` 取消对应的系统通知并关掉应用内提示条，不弹新通知。
 */
export interface AttentionNotice {
  /** 去重用 */
  id: string;
  kind: "finished" | "failed" | "permission" | "schedule" | "resolved";
  agentId?: string;
  /** kind 为 "permission" / "resolved" 时的审批请求 id；手机据 agentId + requestId 算出同一个系统通知 id */
  requestId?: string;
  /** kind 为 "permission" 时的审批类型（与 AgentPermissionRequest.kind 一致），手机据此区分「待审批 / 待回答 / 待确认计划」 */
  permissionKind?: AgentPermissionRequest["kind"];
  /** 会话标题或调度名 */
  title: string;
  /** 中文摘要，≤ 120 字（不含工具输出原文） */
  body: string;
  timestamp: number;
}

export type SnapshotFileStatus = "A" | "M" | "D" | "R";

export interface SnapshotChangedFile {
  path: string;
  status: SnapshotFileStatus;
}

export type SnapshotSkipReason = "too_many_files" | "git_unavailable" | "disabled";

export interface SnapshotTurn {
  turnId: string;
  /** 本回合 turn_started 的 seq */
  seq: number;
  startedAt: number;
  before: string | null;
  after: string | null;
  changedFiles: SnapshotChangedFile[];
  skipped?: SnapshotSkipReason;
  /** 影子仓库已被清理 */
  pruned?: boolean;
}

// ---------------------------------------------------------------------------
// 4.27 界面发起的并行协作（扇出 + 汇总）
// ---------------------------------------------------------------------------

export type AgentGroupStatus = "running" | "chairing" | "done" | "failed";
export type AgentGroupChairMode = "synthesize" | "review";

export interface AgentGroupMember {
  agentId: string;
  provider: AgentProviderId;
  model?: string | null;
  worktree?: { path: string; branch: string };
}

export interface AgentGroup {
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  createdAt: number;
  members: AgentGroupMember[];
  chair?: { provider: AgentProviderId; model?: string | null; mode: AgentGroupChairMode; agentId?: string };
  status: AgentGroupStatus;
}

export interface GroupCreateParams {
  title?: string;
  prompt: string;
  cwd: string;
  /** 2–6 个 */
  members: Array<{
    provider: AgentProviderId;
    model?: string | null;
    modeId?: string | null;
    thinkingOptionId?: string | null;
  }>;
  worktree: "none" | "per-member";
  chair?: { provider: AgentProviderId; model?: string | null; mode: AgentGroupChairMode };
}

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
  agentRetract: "agent.retract",
  agentSteer: "agent.steer",
  agentFork: "agent.fork",
  agentPermissionRespond: "agent.permission.respond",
  agentSetModel: "agent.setModel",
  agentSetMode: "agent.setMode",
  agentSetThinking: "agent.setThinking",
  agentClose: "agent.close",
  agentReclaim: "agent.reclaim",
  agentTimeline: "agent.timeline",
  agentDelete: "agent.delete",
  agentUpdate: "agent.update",
  agentSearch: "agent.search",
  usageSummary: "usage.summary",
  settingsGet: "settings.get",
  settingsSet: "settings.set",
  snapshotList: "snapshot.list",
  snapshotDiff: "snapshot.diff",
  snapshotRestore: "snapshot.restore",
  snapshotStorage: "snapshot.storage",
  snapshotPrune: "snapshot.prune",
  scheduleList: "schedule.list",
  scheduleUpsert: "schedule.upsert",
  scheduleDelete: "schedule.delete",
  scheduleRunNow: "schedule.runNow",
  scheduleRuns: "schedule.runs",
  scheduleSetPaused: "schedule.setPaused",
  boardGet: "board.get",
  boardUpdateSettings: "board.updateSettings",
  boardUpsertTask: "board.upsertTask",
  boardDeleteTask: "board.deleteTask",
  boardMoveTask: "board.moveTask",
  boardMerge: "board.merge",
  groupCreate: "group.create",
  groupList: "group.list",
  groupGet: "group.get",
  groupDelete: "group.delete",
  agentSubagentsList: "agent.subagents.list",
  agentSubagentsTimeline: "agent.subagents.timeline",
  agentCommands: "agent.commands",
  agentMcpStatus: "agent.mcp.status",
  agentMcpReconnect: "agent.mcp.reconnect",
  agentStatus: "agent.status",
  agentTasksList: "agent.tasks.list",
  agentTasksStop: "agent.tasks.stop",
  agentTasksOutput: "agent.tasks.output",
  providerConfigGet: "provider.config.get",
  providerConfigSet: "provider.config.set",
  providerTest: "provider.test",
  remoteStatus: "remote.status",
  remotePairingCreate: "remote.pairing.create",
  remoteDevicesRevoke: "remote.devices.revoke",
  translationTranslate: "translation.translate",
  translationEndpointGet: "translation.endpoint.get",
  translationEndpointSet: "translation.endpoint.set",
} as const;

export const AGENT_RPC_NOTIFICATIONS = {
  agentStream: "agent.stream",
  agentState: "agent.state",
  agentRemoved: "agent.removed",
  providerChanged: "provider.changed",
  settingsChanged: "settings.changed",
  agentSubagentsUpdate: "agent.subagents.update",
  agentTasksUpdate: "agent.tasks.update",
  scheduleChanged: "schedule.changed",
  scheduleNotice: "schedule.notice",
  boardChanged: "board.changed",
  groupChanged: "group.changed",
  groupRemoved: "group.removed",
  remoteChanged: "remote.changed",
  clientAttention: "client.attention",
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
      /** 会话翻译开关；省略 = 用户新建的会话取 settings.translation.enabledByDefault（design.md 4.35） */
      translation?: boolean;
    };
    result: { agent: AgentSnapshot };
  };
  "agent.list": { params: AgentRpcEmptyParams; result: { agents: AgentSnapshot[] } };
  "agent.send": {
    params: { agentId: string; prompt: AgentPromptInput; clientMessageId?: string };
    result: { turnId: string };
  };
  "agent.cancel": { params: { agentId: string }; result: Record<string, never> };
  /** 首次响应前撤回本轮用户消息（design.md 4.16）；返回原始 prompt 供回填输入框 */
  "agent.retract": {
    params: { agentId: string };
    result: { prompt: AgentPromptInput; clientMessageId?: string };
  };
  /** 运行中插话（design.md 4.22）：投递给进行中的回合；无回合 / provider 不支持 → NOT_SUPPORTED */
  "agent.steer": {
    params: { agentId: string; prompt: AgentPromptInput; clientMessageId?: string };
    result: Record<string, never>;
  };
  /** 基于原会话新建分叉会话（design.md 4.23）；throughSeq 缺省 = 整个会话 */
  "agent.fork": {
    params: { agentId: string; throughSeq?: number; title?: string };
    result: { agent: AgentSnapshot };
  };
  /** 只改元数据（design.md 4.17）：title 为 null / 空串 = 清除自定义标题；不改 updatedAt、不恢复会话 */
  "agent.update": {
    params: {
      agentId: string;
      title?: string | null;
      pinned?: boolean;
      archived?: boolean;
      /** 允许被其它会话经 send_to_agent 调用（design.md 4.26） */
      interopTarget?: boolean;
      /** 会话翻译开关（design.md 4.35） */
      translation?: boolean;
      /** 缓存保活开关（design.md 4.36，仅 Claude） */
      cacheKeepAlive?: boolean;
    };
    result: { agent: AgentSnapshot };
  };
  /** 会话全文搜索（design.md 4.19）：query 去首尾空白后 1–200 字；limit 缺省 100、上限 500 */
  "agent.search": {
    params: { query: string; limit?: number; agentIds?: string[] };
    result: { hits: AgentSearchHit[]; truncated: boolean };
  };
  /** 跨会话用量统计（design.md 4.20）：sinceMs 缺省为最近 30 天 */
  "usage.summary": {
    params: { sinceMs?: number; untilMs?: number } | undefined;
    result: UsageSummary;
  };
  /** sidecar 设置（design.md 4.24） */
  "settings.get": { params: AgentRpcEmptyParams; result: SidecarSettings };
  "settings.set": { params: { patch: SidecarSettingsPatch }; result: SidecarSettings };
  "snapshot.list": { params: { agentId: string }; result: { turns: SnapshotTurn[] } };
  /** before 与 after（默认）或当前工作区的 unified diff，上限 512 KB */
  "snapshot.diff": {
    params: { agentId: string; turnId: string; path?: string; against?: "after" | "current" };
    result: { diff: string; truncated: boolean };
  };
  /** 把文件恢复到该回合开始前；同 cwd 有进行中的回合 → TURN_IN_PROGRESS */
  "snapshot.restore": {
    params: { agentId: string; turnId: string; paths?: string[] };
    result: { restored: string[]; deleted: string[]; backupCommit: string };
  };
  "snapshot.storage": {
    params: AgentRpcEmptyParams;
    result: { repos: Array<{ cwd: string; bytes: number }> };
  };
  "snapshot.prune": { params: { cwd: string }; result: Record<string, never> };
  /** 调度器（design.md 4.25） */
  "schedule.list": {
    params: AgentRpcEmptyParams;
    result: { schedules: Schedule[]; paused: boolean };
  };
  /** 无 id 为新建；cron 非法 / 参数非法 → -32602；目标会话不存在 → AGENT_NOT_FOUND */
  "schedule.upsert": { params: { schedule: ScheduleDraft }; result: { schedule: Schedule } };
  "schedule.delete": { params: { id: string }; result: Record<string, never> };
  /** cron / heartbeat：立即发送一次；goal：继续循环。不等待发送完成，结果见运行记录 */
  "schedule.runNow": { params: { id: string }; result: Record<string, never> };
  /** 默认 100，按时间倒序 */
  "schedule.runs": { params: { id?: string; limit?: number }; result: { runs: ScheduleRun[] } };
  "schedule.setPaused": { params: { paused: boolean }; result: { paused: boolean } };
  /** 看板式任务分派（design.md 4.28）；不存在的看板返回默认空看板 */
  "board.get": { params: { projectPath: string }; result: { board: Board } };
  /** settings 为补丁：只覆盖给出的字段 */
  "board.updateSettings": {
    params: { projectPath: string; settings: BoardSettingsPatch };
    result: { board: Board };
  };
  "board.upsertTask": {
    params: { projectPath: string; task: BoardTaskDraft };
    result: { board: Board; task: BoardTask };
  };
  /** removeWorktree 清理失败不阻止删除，原因放在 warning */
  "board.deleteTask": {
    params: { projectPath: string; taskId: string; removeWorktree?: boolean };
    result: { board: Board; warning?: string };
  };
  "board.moveTask": {
    params: { projectPath: string; taskId: string; status: BoardTaskStatus; order?: number };
    result: { board: Board };
  };
  /** 冲突时已 merge --abort，任务留在 review；工作区有未提交改动等 → 业务错误 */
  "board.merge": {
    params: { projectPath: string; taskId: string; removeWorktree: boolean };
    result: { ok: boolean; conflicts?: string[]; board: Board; warning?: string };
  };
  /** 并行协作组（design.md 4.27）；成员数 2–6、per-member 但 cwd 不在 git 仓库内 → -32602 */
  "group.create": { params: GroupCreateParams; result: { group: AgentGroup } };
  "group.list": { params: AgentRpcEmptyParams; result: { groups: AgentGroup[] } };
  "group.get": { params: { id: string }; result: { group: AgentGroup } };
  /** 成员会话保留（解除 groupId）；removeWorktrees 失败的条目放进 warnings */
  "group.delete": {
    params: { id: string; removeWorktrees: boolean };
    result: { warnings?: string[] };
  };
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
  /** 结束 provider 进程、会话转为 dormant，下次发送自动恢复（design.md 4.34） */
  "agent.reclaim": { params: { agentId: string }; result: { agent: AgentSnapshot } };
  /**
   * 时间线读取。只给 `sinceSeq` 或不带参数：返回其后全部条目（不带 hasOlder）。
   * 给 `limit`（1–2000）为向前分页（design.md 4.31）：从 `beforeSeq`（缺省 = 末尾之后）往前取至少 limit 条，
   * 再扩到最近的回合起点，返回 `hasOlder`；`sinceSeq` 与 `beforeSeq` / `limit` 同时给出为 -32602。
   */
  "agent.timeline": {
    params: { agentId: string; sinceSeq?: number; beforeSeq?: number; limit?: number };
    result: { epoch: string; entries: AgentStreamEnvelope[]; hasOlder?: boolean };
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
  /** 斜杠命令列表（按 name 去重）；dormant / closed 会话走 provider 目录，不恢复会话（design.md 4.14） */
  "agent.commands": { params: { agentId: string }; result: { commands: AgentSlashCommand[] } };
  /** MCP 服务器状态；dormant / closed 且可恢复时先自动恢复会话（design.md 4.14） */
  "agent.mcp.status": { params: { agentId: string }; result: AgentMcpStatusResult };
  /** AgentDeck 本地 /status：会话 / 账户 / 用量限制 / MCP 分组；会话处理同 agent.mcp.status（design.md 4.14） */
  "agent.status": { params: { agentId: string }; result: { sections: AgentStatusSection[] } };
  /**
   * 重连 MCP 并返回重连后的最新状态（design.md 4.14）。
   * reconnect 为 server（Claude）时必须带 serverName；all（Codex）忽略 serverName，整体重新加载。
   */
  "agent.mcp.reconnect": {
    params: { agentId: string; serverName?: string };
    result: AgentMcpStatusResult;
  };
  /** 后台任务列表（仅 Claude；其它 provider 返回 []，design.md 4.15） */
  "agent.tasks.list": { params: { agentId: string }; result: { tasks: AgentBackgroundTask[] } };
  /** 停止单个后台任务；会话进程未运行 → AGENT_CLOSED，不支持 → NOT_SUPPORTED，任务未知 → TASK_NOT_FOUND */
  "agent.tasks.stop": {
    params: { agentId: string; taskId: string };
    result: Record<string, never>;
  };
  /** 读后台命令输出文件的尾部：maxBytes 缺省 64KB、上限 256KB */
  "agent.tasks.output": {
    params: { agentId: string; taskId: string; maxBytes?: number };
    result: AgentBackgroundTaskOutput;
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
  /** 远程网关状态（design.md 4.31）；远程客户端调用返回 -32601 */
  "remote.status": { params: AgentRpcEmptyParams; result: RemoteStatus };
  /** 签发一次性配对二维码内容；网关未监听时 NOT_SUPPORTED；远程客户端调用返回 -32601 */
  "remote.pairing.create": {
    params: AgentRpcEmptyParams;
    result: { offerUrl: string; expiresAt: number };
  };
  /** 吊销设备并立即断开其全部连接；远程客户端调用返回 -32601 */
  "remote.devices.revoke": { params: { deviceId: string }; result: Record<string, never> };
  /** 翻译（design.md 4.35）：text 1–100000 字；未配置 / 失败 → TRANSLATION_FAILED */
  "translation.translate": {
    params: { direction: TranslationDirection; text: string };
    result: { text: string };
  };
  "translation.endpoint.get": { params: AgentRpcEmptyParams; result: TranslationEndpoint };
  "translation.endpoint.set": {
    params: { patch: Partial<TranslationEndpoint> };
    result: TranslationEndpoint;
  };
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
  /** sidecar 设置变化（design.md 4.24） */
  "settings.changed": { settings: SidecarSettings };
  /** provider 子代理描述 / 时间线变化（design.md 4.11），向所有连接广播，前端按 agentId 过滤 */
  "agent.subagents.update": ProviderSubagentUpdate;
  /** 后台任务整表推送（design.md 4.15），向所有连接广播，前端按 agentId 过滤 */
  "agent.tasks.update": { agentId: string; tasks: AgentBackgroundTask[] };
  /** 调度表 / 运行记录变化（design.md 4.25），向所有连接广播 */
  "schedule.changed": { schedules: Schedule[]; paused: boolean };
  /** 目标循环结束 / 定时任务失败（design.md 4.25），前端据此弹系统通知 */
  "schedule.notice": ScheduleNotice;
  /** 看板变化（design.md 4.28），向所有连接广播 */
  "board.changed": { projectPath: string; board: Board };
  /** 协作组新建 / 状态 / 成员变化（design.md 4.27），向所有连接广播 */
  "group.changed": { group: AgentGroup };
  /** 协作组被删除（design.md 4.27 补记） */
  "group.removed": { groupId: string };
  /** 远程网关启停、设备配对 / 吊销 / 连接 / 断开（design.md 4.31），只发给本机客户端 */
  "remote.changed": RemoteStatus;
  /** 需要用户回到会话的事件（design.md 4.31），只发给已认证的远程客户端 */
  "client.attention": AttentionNotice;
}

export type AgentRpcNotificationName = keyof AgentRpcNotifications;
export type AgentRpcNotificationParams<N extends AgentRpcNotificationName> =
  AgentRpcNotifications[N];
