// Derived from paseo packages/server/src/server/agent/agent-sdk-types.ts (Apache-2.0); modified for AgentDeck
// sidecar 内部的 Agent 适配接口（design.md 第 5 节，精简版）。事件与数据类型从 @agentdeck/protocol 导入。
import type {
  AgentMcpStatusResult,
  AgentMode,
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentProviderId,
  AgentProviderKind,
  AgentSlashCommand,
  AgentStreamEvent,
  AgentTimelineItem,
  ProviderProfileExtends,
  ProviderSubagentStatus,
} from "@agentdeck/protocol";

import type { Logger } from "../logger.js";

/**
 * provider 子代理的输入事件（design.md 4.11）。upsert 中字段省略 = 保留原值，显式 null = 清空；
 * status 省略时保留（新建默认 running）。timestamp 为毫秒时间戳，缺省取当前时间。
 */
export type ProviderSubagentInputEvent =
  | {
      type: "upsert";
      id: string;
      title?: string | null;
      description?: string | null;
      status?: ProviderSubagentStatus;
      toolCallId?: string | null;
      cwd?: string | null;
      subtitle?: string | null;
      parentSubagentId?: string | null;
      timestamp?: number;
    }
  | { type: "timeline"; id: string; item: AgentTimelineItem; timestamp?: number }
  | { type: "remove"; id: string };

/** 会话内部流事件：provider 子代理变化，不进主时间线、不占 seq（AgentManager 拦截写入子代理 store） */
export interface ProviderSubagentStreamEvent {
  type: "provider_subagent";
  event: ProviderSubagentInputEvent;
}

/** AgentSession.subscribe 回调收到的事件 */
export type AgentSessionEvent = AgentStreamEvent | ProviderSubagentStreamEvent;

export interface AgentSessionConfig {
  cwd: string;
  model?: string;
  modeId?: string;
  /** 思考强度档位；null / 缺省 = 跟随 CLI 自身设置（design.md 4.10） */
  thinkingOptionId?: string | null;
}

/**
 * 一个原生 Agent 会话。
 *
 * 事件约定（AgentManager 依赖）：
 * - `startTurn` 生成 turnId，并发出 `turn_started`（可在 resolve 前或后），turn 结束时发且只发一次
 *   `turn_completed` / `turn_failed` / `turn_canceled`；
 * - CLI 自行开始的轮次（没有 startTurn）发 `turn_started { origin: "background" }`，同样以一个结束事件收尾；
 *   该轮进行中仍可调用 `startTurn`（provider 先结束自发轮次再开新轮，design.md 4.12）；
 * - `user_message` 由 AgentManager 统一记录，provider **不要**再发；
 * - `respondToPermission` 应在 resolve 前发出 `permission_resolved`（manager 有兜底补发）；
 * - `setModel` / `setMode` / `setThinking` 应发出 `model_changed` / `mode_changed` /
 *   `thinking_option_changed`（manager 有兜底补发）。
 */
export interface AgentSession {
  readonly provider: AgentProviderId;
  /** 原生会话 id，thread_started 后可得 */
  readonly id: string | null;
  startTurn(
    prompt: AgentPromptInput,
    opts?: { clientMessageId?: string },
  ): Promise<{ turnId: string }>;
  /** 回调可能收到内部事件 `provider_subagent`（只有支持子代理的 provider 会发） */
  subscribe(cb: (e: AgentSessionEvent) => void): () => void;
  getPendingPermissions(): AgentPermissionRequest[];
  respondToPermission(requestId: string, r: AgentPermissionResponse): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  describePersistence(): AgentPersistenceHandle | null;
  setModel?(modelId: string | null): Promise<void>;
  setMode?(modeId: string): Promise<void>;
  /**
   * 切换思考强度（null = 跟随 CLI 设置），下一轮生效；档位不合法时抛错。
   * 正在运行一轮时返回 notice（中文提示）。
   */
  setThinking?(thinkingOptionId: string | null): Promise<{ notice?: string } | void>;
  /** 斜杠命令列表（design.md 4.14）；未实现时 AgentManager 退回 provider 目录的 commands */
  listCommands?(): Promise<AgentSlashCommand[]>;
  /** MCP 服务器状态（design.md 4.14） */
  getMcpStatus?(): Promise<AgentMcpStatusResult>;
  /** 重连 MCP：作用域为 server 时重连 serverName，为 all 时忽略 serverName、整体重新加载 */
  reconnectMcp?(serverName?: string): Promise<void>;
}

export interface AgentAvailability {
  available: boolean;
  reason?: string;
  /** 解析到的启动命令（ProviderInfo.command）；claude/codex 为可执行文件，ACP 为完整命令 */
  command?: string[];
}

export interface AgentClient {
  readonly provider: AgentProviderId;
  readonly kind: AgentProviderKind;
  readonly label: string;
  /** 来自 providers.json 的自定义 provider（design.md 4.7）；内置 provider 不设置 */
  readonly custom?: { extends: ProviderProfileExtends; description?: string };
  isAvailable(): Promise<AgentAvailability>;
  /** commands 只供 agent.commands 在会话未加载时使用，不出现在 provider.listModels 的结果里 */
  fetchCatalog(opts?: {
    cwd?: string;
  }): Promise<{
    models: AgentModelDefinition[];
    modes: AgentMode[];
    commands?: AgentSlashCommand[];
  }>;
  createSession(cfg: AgentSessionConfig): Promise<AgentSession>;
  resumeSession?(handle: AgentPersistenceHandle, cfg: { cwd: string }): Promise<AgentSession>;
  shutdown?(): Promise<void>;
}

/** provider 工厂的上下文：每个 providers/<name>/index.ts 导出一个工厂，registry 只负责汇总 */
export interface ProviderFactoryContext {
  logger: Logger;
  /** AGENTDECK_DATA_DIR（可能未设置） */
  dataDir?: string;
  /** sidecar 进程环境（含 AGENTDECK_* 配置项；spawn 子进程时请用 utils/spawn.ts，它会剔除内部变量） */
  env: NodeJS.ProcessEnv;
}

export type ProviderFactory = (
  ctx: ProviderFactoryContext,
) => AgentClient[] | Promise<AgentClient[]>;
