// Derived from paseo packages/server/src/server/agent/agent-sdk-types.ts (Apache-2.0); modified for AgentDeck
// sidecar 内部的 Agent 适配接口（design.md 第 5 节，精简版）。事件与数据类型从 @agentdeck/protocol 导入。
import type {
  AgentMode,
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentProviderId,
  AgentProviderKind,
  AgentStreamEvent,
} from "@agentdeck/protocol";

import type { Logger } from "../logger.js";

export interface AgentSessionConfig {
  cwd: string;
  model?: string;
  modeId?: string;
}

/**
 * 一个原生 Agent 会话。
 *
 * 事件约定（AgentManager 依赖）：
 * - `startTurn` 生成 turnId，并发出 `turn_started`（可在 resolve 前或后），turn 结束时发且只发一次
 *   `turn_completed` / `turn_failed` / `turn_canceled`；
 * - `user_message` 由 AgentManager 统一记录，provider **不要**再发；
 * - `respondToPermission` 应在 resolve 前发出 `permission_resolved`（manager 有兜底补发）；
 * - `setModel` / `setMode` 应发出 `model_changed` / `mode_changed`（manager 有兜底补发）。
 */
export interface AgentSession {
  readonly provider: AgentProviderId;
  /** 原生会话 id，thread_started 后可得 */
  readonly id: string | null;
  startTurn(
    prompt: AgentPromptInput,
    opts?: { clientMessageId?: string },
  ): Promise<{ turnId: string }>;
  subscribe(cb: (e: AgentStreamEvent) => void): () => void;
  getPendingPermissions(): AgentPermissionRequest[];
  respondToPermission(requestId: string, r: AgentPermissionResponse): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  describePersistence(): AgentPersistenceHandle | null;
  setModel?(modelId: string | null): Promise<void>;
  setMode?(modeId: string): Promise<void>;
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
  isAvailable(): Promise<AgentAvailability>;
  fetchCatalog(opts?: {
    cwd?: string;
  }): Promise<{ models: AgentModelDefinition[]; modes: AgentMode[] }>;
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
