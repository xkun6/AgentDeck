// 自定义 provider（design.md 4.7）：复用 claude / codex / acp 的现有实现，只通过启动配置覆盖参数化，
// 外面包一层负责 provider id / 静态模型列表 / 默认模型 / 脱敏。
import path from "node:path";

import type {
  AgentMode,
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentStreamEvent,
  ProviderProfile,
  ProviderProfileExtends,
} from "@agentdeck/protocol";

import type {
  AgentAvailability,
  AgentClient,
  AgentSession,
  AgentSessionConfig,
} from "../../agent/types.js";
import type { Logger } from "../../logger.js";
import { findExecutable } from "../../utils/executable-resolution/executable-resolution.js";
import { AcpAgentClient } from "../acp/acp-client.js";
import { CLAUDE_MODES, ClaudeAgentClient, type ClaudeLaunchOverride } from "../claude/claude-agent.js";
import {
  createDefaultClaudeExecutableDeps,
  resolveClaudeExecutable,
  type ClaudeExecutableResolution,
} from "../claude/claude-executable.js";
import { CODEX_MODES, CodexAgentClient } from "../codex/codex-agent.js";
import { resolveCodexLaunch, type CodexLaunch } from "../codex/launch.js";
import { buildClaudeLaunchOverride, buildCodexLaunchOverride, mergeClaudeSettings } from "./launch.js";
import {
  addSecrets,
  collectSecrets,
  createRedactingLogger,
  redactError,
  redactEvent,
  redactText,
} from "./redact.js";
import { customProviderId } from "./schema.js";
import { readClaudeSettingsFile } from "./settings-file.js";

export interface CustomClientDeps {
  logger: Logger;
  /** sidecar 进程环境 */
  env: NodeJS.ProcessEnv;
  /** 测试注入：替代 PATH 上的可执行文件查找 */
  findExecutable?: (name: string) => Promise<string | null>;
  /** 测试注入：直接构造内层 client（跳过真实 claude / codex / acp 实现） */
  createInner?: (profile: ProviderProfile, logger: Logger) => AgentClient;
}

/** 由 profile 构造 AgentClient；未启用的 profile 由调用方过滤 */
export function createCustomProviderClient(
  profile: ProviderProfile,
  deps: CustomClientDeps,
): CustomProviderClient {
  // settingsFile 的 env 值在每次读取后追加进同一个数组（logger 与会话代理按引用持有）
  const secrets = collectSecrets(profile);
  const growable = profile.extends === "claude" && profile.settingsFile !== undefined;
  const logger = createRedactingLogger(deps.logger, secrets, growable);
  const inner = deps.createInner
    ? deps.createInner(profile, logger)
    : createInnerClient(profile, { ...deps, logger }, secrets);
  return new CustomProviderClient(profile, inner, secrets);
}

/**
 * Claude 中转的启动覆盖；配置了 settingsFile 时，每次启动 / 恢复会话（及模型探测）都重新读取并合并，
 * 读到的 env 值追加进 `secrets`（原地），日志只打印顶层键名。
 */
export function createCustomClaudeLaunch(
  profile: ProviderProfile,
  secrets: string[],
  logger: Logger,
): ClaudeLaunchOverride {
  const launch: ClaudeLaunchOverride = buildClaudeLaunchOverride(profile);
  const settingsFile = profile.settingsFile;
  if (settingsFile) {
    launch.resolveExtraArgs = async () => {
      const fileSettings = await readClaudeSettingsFile(settingsFile);
      addSecrets(secrets, collectSecrets(profile, fileSettings));
      logger.info(
        "%s：已读取设置文件，顶层键 [%s]；内联设置顶层键 [%s]",
        customProviderId(profile.id),
        Object.keys(fileSettings).join(", "),
        Object.keys(profile.settings ?? {}).join(", "),
      );
      return buildClaudeLaunchOverride(profile, fileSettings).extraArgs;
    };
  }
  return launch;
}

/**
 * 中转的模型发现来源：中转自身合并后的 settings（settingsFile → settings → 推导 env → profile.env），
 * 不读用户 ~/.claude/settings.json（中转不应继承用户的模型设置）；settingsFile 读取失败时返回 null。
 */
export async function loadCustomClaudeSettings(
  profile: ProviderProfile,
): Promise<Record<string, unknown> | null> {
  try {
    const fileSettings = profile.settingsFile ? await readClaudeSettingsFile(profile.settingsFile) : undefined;
    return mergeClaudeSettings(profile, fileSettings);
  } catch {
    return null;
  }
}

function createInnerClient(profile: ProviderProfile, deps: CustomClientDeps, secrets: string[]): AgentClient {
  const providerId = customProviderId(profile.id);
  const find = deps.findExecutable ?? ((name: string) => findExecutable(name));
  switch (profile.extends) {
    case "claude": {
      const command = profile.command?.[0];
      return new ClaudeAgentClient({
        logger: deps.logger,
        env: deps.env,
        providerId,
        label: profile.label,
        launch: createCustomClaudeLaunch(profile, secrets, deps.logger),
        loadSettings: () => loadCustomClaudeSettings(profile),
        ...(command
          ? { resolveExecutable: () => resolveCustomClaudeExecutable(command, deps.env, find, deps.logger) }
          : {}),
      });
    }
    case "codex": {
      const command = profile.command;
      return new CodexAgentClient({
        logger: deps.logger,
        env: deps.env,
        providerId,
        label: profile.label,
        launch: buildCodexLaunchOverride(profile),
        ...(command
          ? { resolveLaunch: () => resolveCustomCodexLaunch(command, deps.env, find, deps.logger) }
          : {}),
      });
    }
    case "acp":
      return new AcpAgentClient(
        {
          id: providerId,
          label: profile.label,
          command: [...(profile.command ?? [])],
          ...(profile.env ? { env: { ...profile.env } } : {}),
          builtin: false,
        },
        { logger: deps.logger, env: deps.env, findExecutable: find },
      );
  }
}

async function locate(
  command: string,
  find: (name: string) => Promise<string | null>,
): Promise<string | null> {
  return path.isAbsolute(command) ? command : find(command);
}

/** command 覆盖：只认指定的可执行文件（不回退到 PATH 上的默认 claude），仍走 .cmd shim 解析与 --version 校验 */
async function resolveCustomClaudeExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  find: (name: string) => Promise<string | null>,
  logger: Logger,
): Promise<ClaudeExecutableResolution> {
  const located = await locate(command, find);
  if (located) {
    const resolution = await resolveClaudeExecutable(
      createDefaultClaudeExecutableDeps({ ...env, AGENTDECK_CLAUDE_PATH: located }, (message) =>
        logger.warn(message),
      ),
    );
    if (resolution.available && resolution.source === "env") {
      return resolution;
    }
  }
  return { available: false, reason: `自定义命令「${command}」不可用：未找到或无法运行（--version 校验失败）` };
}

async function resolveCustomCodexLaunch(
  command: readonly string[],
  env: NodeJS.ProcessEnv,
  find: (name: string) => Promise<string | null>,
  logger: Logger,
): Promise<CodexLaunch | null> {
  const located = await locate(command[0]!, find);
  if (!located) {
    return null;
  }
  const launch = resolveCodexLaunch({
    env: { ...env, AGENTDECK_CODEX_PATH: located },
    onWarning: (message) => logger.warn("[codex] %s", message),
  });
  if (!launch || launch.source !== "env") {
    return null;
  }
  return { ...launch, args: [...launch.args, ...command.slice(1)] };
}

export class CustomProviderClient implements AgentClient {
  readonly provider: string;
  readonly kind: ProviderProfileExtends;
  readonly label: string;
  readonly custom: { extends: ProviderProfileExtends; description?: string };
  readonly profile: ProviderProfile;

  private readonly staticModels: AgentModelDefinition[] | null;

  constructor(
    profile: ProviderProfile,
    readonly inner: AgentClient,
    private readonly secrets: readonly string[],
  ) {
    this.profile = structuredClone(profile);
    this.provider = customProviderId(profile.id);
    this.kind = profile.extends;
    this.label = profile.label;
    this.custom = {
      extends: profile.extends,
      ...(profile.description !== undefined ? { description: profile.description } : {}),
    };
    this.staticModels =
      profile.models && profile.models.length > 0
        ? profile.models.map((model) => ({ ...model, provider: this.provider }))
        : null;
  }

  async isAvailable(): Promise<AgentAvailability> {
    let availability = await this.guard(() => this.inner.isAvailable());
    const settingsFile = this.kind === "claude" ? this.profile.settingsFile : undefined;
    if (availability.available && settingsFile) {
      // settingsFile 不存在或不是 JSON 对象时不可用（每次检查都重新读取，不缓存）
      try {
        await readClaudeSettingsFile(settingsFile);
      } catch (error) {
        availability = { available: false, reason: (error as Error).message };
      }
    }
    return availability.reason !== undefined
      ? { ...availability, reason: redactText(availability.reason, this.secrets) }
      : availability;
  }

  async fetchCatalog(opts?: {
    cwd?: string;
  }): Promise<{ models: AgentModelDefinition[]; modes: AgentMode[] }> {
    if (this.staticModels && this.kind !== "acp") {
      // claude / codex 的模式是固定列表：不必为拿模式启动 CLI（静态模型替代动态发现）
      const modes = this.kind === "claude" ? CLAUDE_MODES : CODEX_MODES;
      return { models: structuredClone(this.staticModels), modes: structuredClone(modes) };
    }
    const catalog = await this.guard(() => this.inner.fetchCatalog(opts));
    return this.staticModels ? { ...catalog, models: structuredClone(this.staticModels) } : catalog;
  }

  async createSession(cfg: AgentSessionConfig): Promise<AgentSession> {
    // 未指定模型时用静态列表里的默认模型（中转接口通常不认 CLI 的默认模型名）
    const defaultModel = this.staticModels?.find((model) => model.isDefault)?.id;
    const config: AgentSessionConfig =
      cfg.model === undefined && defaultModel !== undefined ? { ...cfg, model: defaultModel } : cfg;
    const session = await this.guard(() => this.inner.createSession(config));
    return new RedactingSession(session, this.secrets);
  }

  async resumeSession(handle: AgentPersistenceHandle, cfg: { cwd: string }): Promise<AgentSession> {
    const inner = this.inner;
    if (!inner.resumeSession) {
      throw new Error(`${this.label} 不支持恢复会话`);
    }
    const session = await this.guard(() =>
      inner.resumeSession!({ ...handle, provider: this.provider }, cfg),
    );
    return new RedactingSession(session, this.secrets);
  }

  async shutdown(): Promise<void> {
    await this.inner.shutdown?.();
  }

  private async guard<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } catch (error) {
      throw redactError(error, this.secrets);
    }
  }
}

/** 会话代理：事件与错误中的机密值脱敏，其余原样转发 */
class RedactingSession implements AgentSession {
  setModel?: (modelId: string | null) => Promise<void>;
  setMode?: (modeId: string) => Promise<void>;

  constructor(
    private readonly inner: AgentSession,
    private readonly secrets: readonly string[],
  ) {
    if (inner.setModel) {
      this.setModel = (modelId) => this.guard(() => inner.setModel!(modelId));
    }
    if (inner.setMode) {
      this.setMode = (modeId) => this.guard(() => inner.setMode!(modeId));
    }
  }

  get provider(): string {
    return this.inner.provider;
  }

  get id(): string | null {
    return this.inner.id;
  }

  startTurn(prompt: AgentPromptInput, opts?: { clientMessageId?: string }): Promise<{ turnId: string }> {
    return this.guard(() => this.inner.startTurn(prompt, opts));
  }

  subscribe(cb: (e: AgentStreamEvent) => void): () => void {
    return this.inner.subscribe((event) => cb(redactEvent(event, this.secrets)));
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return this.inner.getPendingPermissions();
  }

  respondToPermission(requestId: string, r: AgentPermissionResponse): Promise<void> {
    return this.guard(() => this.inner.respondToPermission(requestId, r));
  }

  interrupt(): Promise<void> {
    return this.guard(() => this.inner.interrupt());
  }

  close(): Promise<void> {
    return this.guard(() => this.inner.close());
  }

  describePersistence(): AgentPersistenceHandle | null {
    return this.inner.describePersistence();
  }

  private async guard<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } catch (error) {
      throw redactError(error, this.secrets);
    }
  }
}
