// 通用 ACP AgentClient：每个目录条目（内置或 acp-agents.json）对应一个实例。
import type {
  AgentMode,
  AgentModelDefinition,
  AgentPersistenceHandle,
} from "@agentdeck/protocol";

import { AgentRpcError } from "../../agent/errors.js";
import type {
  AgentAvailability,
  AgentClient,
  AgentSession,
  AgentSessionConfig,
} from "../../agent/types.js";
import type { Logger } from "../../logger.js";
import { findExecutable } from "../../utils/executable-resolution/executable-resolution.js";
import { AcpAgentSession, type AcpSessionInit } from "./acp-session.js";
import type { AcpAgentEntry } from "./catalog.js";

export interface AcpAgentClientOptions {
  logger: Logger;
  env: NodeJS.ProcessEnv;
  /** 测试用：替换可执行文件查找 */
  findExecutable?: (name: string) => Promise<string | null>;
}

export class AcpAgentClient implements AgentClient {
  readonly kind = "acp" as const;
  readonly provider: string;
  readonly label: string;

  private readonly entry: AcpAgentEntry;
  private readonly logger: Logger;
  private readonly env: NodeJS.ProcessEnv;
  private readonly find: (name: string) => Promise<string | null>;
  /** 最近一次建会话时 agent 报告的模型/模式（ACP 只有建会话后才可得） */
  private lastCatalog: { models: AgentModelDefinition[]; modes: AgentMode[] } = {
    models: [],
    modes: [],
  };

  constructor(entry: AcpAgentEntry, options: AcpAgentClientOptions) {
    this.entry = entry;
    this.provider = entry.id;
    this.label = entry.label;
    this.logger = options.logger;
    this.env = options.env;
    this.find = options.findExecutable ?? ((name) => findExecutable(name));
  }

  async isAvailable(): Promise<AgentAvailability> {
    const command = [...this.entry.command];
    const executable = await this.find(this.entry.command[0]!);
    if (!executable) {
      return {
        available: false,
        reason: `未找到命令「${this.entry.command[0]}」：请先安装 ${this.label}，并确认它在 PATH 中`,
        command,
      };
    }
    // npx 类条目：npx 存在即视为可用，不做额外探测（首次运行会下载包）
    return { available: true, command };
  }

  /**
   * 不为拿目录而单独启动 agent（npx 条目会触发下载）：返回最近一次会话报告的模型/模式，
   * 在本 provider 第一次建会话之前为空列表。
   */
  async fetchCatalog(): Promise<{ models: AgentModelDefinition[]; modes: AgentMode[] }> {
    return structuredClone(this.lastCatalog);
  }

  async createSession(cfg: AgentSessionConfig): Promise<AgentSession> {
    return this.startSession(cfg.cwd, {
      type: "new",
      ...(cfg.model !== undefined ? { model: cfg.model } : {}),
      ...(cfg.modeId !== undefined ? { modeId: cfg.modeId } : {}),
      ...(cfg.thinkingOptionId != null ? { thinkingOptionId: cfg.thinkingOptionId } : {}),
    });
  }

  async resumeSession(handle: AgentPersistenceHandle, cfg: { cwd: string }): Promise<AgentSession> {
    return this.startSession(cfg.cwd, { type: "load", sessionId: handle.sessionId });
  }

  private async startSession(cwd: string, init: AcpSessionInit): Promise<AcpAgentSession> {
    const executable = await this.find(this.entry.command[0]!);
    if (!executable) {
      throw new AgentRpcError(
        "PROVIDER_UNAVAILABLE",
        `未找到命令「${this.entry.command[0]}」：请先安装 ${this.label}`,
      );
    }
    const session = await AcpAgentSession.start({
      spec: {
        provider: this.provider,
        label: this.label,
        executable,
        args: this.entry.command.slice(1),
        ...(this.entry.env ? { envOverlay: this.entry.env } : {}),
      },
      cwd,
      logger: this.logger,
      env: this.env,
      init,
    });
    this.lastCatalog = session.catalog();
    return session;
  }
}
