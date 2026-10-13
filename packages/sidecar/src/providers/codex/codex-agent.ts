// Codex provider：每个会话一个 `codex app-server` 子进程，stdio 换行分隔 JSON-RPC（design.md 5.1）。
// 协议流程与事件映射参考 paseo packages/server/src/server/agent/providers/codex-app-server-agent.ts
// （Apache-2.0）的启动、initialize、thread/start、turn/start、审批、interrupt、model/list 与通知处理，
// 按 AgentDeck 的精简接口重写；字段以本机 codex-cli 0.162.1 `app-server generate-ts` 生成的类型为准。
// 子线程（子代理）通知由 ./subagent-router.ts 路由到子代理时间线（design.md 4.11）。
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  AgentMcpServer,
  AgentMcpServerStatus,
  AgentMcpStatusResult,
  AgentMode,
  AgentModelDefinition,
  AgentThinkingOption,
  AgentPermissionAction,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentSlashCommand,
  AgentStatusSection,
  AgentStreamEvent,
  AgentUsage,
  ToolCallDetail,
  ToolCallTimelineItem,
} from "@agentdeck/protocol";

import packageJson from "../../../package.json" with { type: "json" };
import type {
  AgentAvailability,
  AgentClient,
  AgentSession,
  AgentSessionConfig,
  AgentSessionEvent,
} from "../../agent/types.js";
import { buildMcpSection, buildRows, formatResetsIn, formatWindowLabel } from "../../agent/status-sections.js";
import type { Logger } from "../../logger.js";
import { execCommand, spawnProcess } from "../../utils/spawn.js";
import {
  CodexAppServerClient,
  CodexAppServerRpcError,
  type JsonRpcId,
} from "./app-server-transport.js";
import { describeCodexLaunch, resolveCodexLaunch, type CodexLaunch } from "./launch.js";
import { CodexSubagentRouter } from "./subagent-router.js";
import {
  makeThinkingOption,
  normalizeThinkingOptionId,
  THINKING_APPLIES_NEXT_TURN_NOTICE,
} from "../shared/thinking-options.js";
import {
  mapCodexToolCallFromThreadItem,
  normalizeCommandExecutionCommand,
} from "./tool-call-mapper.js";

export const CODEX_PROVIDER_ID = "codex";

const CLIENT_VERSION: string = packageJson.version;
const VERSION_PROBE_TIMEOUT_MS = 8_000;
const INITIALIZE_TIMEOUT_MS = 20_000;
const THREAD_START_TIMEOUT_MS = 60_000;
const TURN_START_TIMEOUT_MS = 60_000;
const MODEL_LIST_TIMEOUT_MS = 15_000;
const INTERRUPT_TIMEOUT_MS = 2_000;
const NATIVE_TURN_ID_WAIT_MS = 2_000;
const MODEL_LIST_MAX_PAGES = 5;
const MCP_STATUS_TIMEOUT_MS = 30_000;
const MCP_RELOAD_TIMEOUT_MS = 60_000;
const MCP_STATUS_MAX_PAGES = 20;

/**
 * Codex 的斜杠命令（design.md 4.14）：只有 /compact，由 sidecar 拦截改调 thread/compact/start；
 * 其它 Codex TUI 命令 app-server 不支持。
 */
export const CODEX_SLASH_COMMANDS: readonly AgentSlashCommand[] = [
  { name: "compact", description: "压缩当前对话上下文" },
];

/** prompt 去掉首尾空白后恰好是 `/compact`（字符串，或只有一个 text 块且无图片） */
export function isCodexCompactPrompt(prompt: AgentPromptInput): boolean {
  if (typeof prompt === "string") {
    return prompt.trim() === "/compact";
  }
  const [only] = prompt;
  return prompt.length === 1 && only?.type === "text" && only.text.trim() === "/compact";
}

/** mcpServerStatus/list 的 runtimeStatus → AgentMcpServerStatus（notStarted / starting / null 等归为 pending） */
function toMcpServerStatus(runtimeStatus: unknown): AgentMcpServerStatus {
  switch (runtimeStatus) {
    case "connected":
      return "connected";
    case "authenticationRequired":
      return "needs-auth";
    case "failed":
    case "cancelled":
      return "failed";
    case "disabled":
      return "disabled";
    default:
      return "pending";
  }
}

/** mcpServerStatus/list 的一项 → AgentMcpServer；没有 name 返回 null */
export function mapCodexMcpServer(entry: unknown): AgentMcpServer | null {
  const record = asRecord(entry);
  const name = str(record?.name);
  if (!record || !name) {
    return null;
  }
  const tools = asRecord(record.tools);
  const error = str(record.toolsError);
  return {
    name,
    status: toMcpServerStatus(record.runtimeStatus),
    ...(error ? { error } : {}),
    ...(tools ? { toolCount: Object.keys(tools).length } : {}),
  };
}

/** account/read → 「账户」分组；形状不认识返回 null */
export function buildCodexAccountSection(response: unknown): AgentStatusSection | null {
  const record = asRecord(response);
  if (!record) return null;
  const account = asRecord(record.account);
  if (!account) {
    return {
      title: "账户",
      rows: buildRows([
        ["登录方式", "未登录"],
        ["需要 OpenAI 认证", record.requiresOpenaiAuth === true ? "是" : null],
      ]),
    };
  }
  switch (account.type) {
    case "apiKey":
      return { title: "账户", rows: [{ label: "登录方式", value: "API Key" }] };
    case "chatgpt":
      return {
        title: "账户",
        rows: buildRows([
          ["登录方式", "ChatGPT 账号"],
          ["邮箱", str(account.email)],
          ["套餐", str(account.planType)],
        ]),
      };
    case "amazonBedrock":
      return { title: "账户", rows: [{ label: "登录方式", value: "Amazon Bedrock" }] };
    default:
      return null;
  }
}

/** account/rateLimits/read → 「用量限制」分组：主要 / 次要窗口的已用百分比与重置时间；没有窗口返回 null */
export function buildCodexRateLimitSection(response: unknown, now = Date.now()): AgentStatusSection | null {
  const snapshot = asRecord(asRecord(response)?.rateLimits);
  if (!snapshot) return null;
  const rows: AgentStatusSection["rows"] = [];
  for (const key of ["primary", "secondary"] as const) {
    const window = asRecord(snapshot[key]);
    const used = window?.usedPercent;
    if (!window || typeof used !== "number" || !Number.isFinite(used)) continue;
    const minutes = typeof window.windowDurationMins === "number" ? window.windowDurationMins : null;
    const reset = formatResetsIn(typeof window.resetsAt === "number" ? window.resetsAt : null, now);
    const label = formatWindowLabel(minutes);
    rows.push({
      label: label === "用量" ? (key === "primary" ? "主要窗口" : "次要窗口") : `${label}窗口`,
      value: `已用 ${Math.round(used)}%${reset ? `，${reset}` : ""}`,
    });
  }
  return rows.length > 0 ? { title: "用量限制", rows } : null;
}

export const DEFAULT_CODEX_MODE_ID = "auto";

export const CODEX_MODES: AgentMode[] = [
  {
    id: "read-only",
    label: "只读",
    description: "只读沙箱，可读文件与运行只读命令；写文件或越权命令需要审批",
  },
  {
    id: "auto",
    label: "自动",
    description: "工作区可写沙箱；越出工作区或需要网络时请求审批（默认）",
  },
  {
    id: "full-access",
    label: "完全访问",
    description: "无沙箱、不请求审批，可修改任意文件与访问网络",
    dangerous: true,
  },
];

type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type CodexApprovalPolicy = "on-request" | "never";

const MODE_PRESETS: Record<string, { approvalPolicy: CodexApprovalPolicy; sandbox: CodexSandboxMode }> = {
  "read-only": { approvalPolicy: "on-request", sandbox: "read-only" },
  auto: { approvalPolicy: "on-request", sandbox: "workspace-write" },
  "full-access": { approvalPolicy: "never", sandbox: "danger-full-access" },
};

const PERMISSION_ACTIONS: AgentPermissionAction[] = [
  { id: "accept", label: "允许", behavior: "allow" },
  { id: "decline", label: "拒绝", behavior: "deny" },
];

function presetFor(modeId: string) {
  return MODE_PRESETS[modeId] ?? MODE_PRESETS[DEFAULT_CODEX_MODE_ID]!;
}

function assertCodexMode(modeId: string): void {
  if (!MODE_PRESETS[modeId]) {
    throw new Error(`Codex 不支持模式：${modeId}（可选：${Object.keys(MODE_PRESETS).join(" / ")}）`);
  }
}

/** turn/start 的 sandboxPolicy 是对象（thread/start 的 sandbox 是字符串） */
export function toSandboxPolicy(sandbox: CodexSandboxMode): Record<string, unknown> {
  switch (sandbox) {
    case "read-only":
      return { type: "readOnly", networkAccess: false };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    case "workspace-write":
      return {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 字段名兼容 camelCase / snake_case */
function pick(record: JsonRecord | null, ...keys: string[]): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) {
      return record[key];
    }
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstPositiveNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** thread/tokenUsage/updated → AgentUsage（取最近一次请求 last 的用量与上下文窗口） */
export function toAgentUsage(tokenUsage: unknown): AgentUsage | undefined {
  const usage = asRecord(tokenUsage);
  if (!usage) return undefined;
  const last = asRecord(pick(usage, "last", "last_token_usage"));
  const inputTokens = finiteNumber(pick(last, "inputTokens", "input_tokens"));
  const cachedInputTokens = finiteNumber(pick(last, "cachedInputTokens", "cached_input_tokens"));
  const outputTokens = finiteNumber(pick(last, "outputTokens", "output_tokens"));
  const contextWindowMaxTokens = firstPositiveNumber(
    usage.modelContextWindow,
    usage.model_context_window,
  );
  const contextWindowUsedTokens = firstPositiveNumber(last?.totalTokens, last?.total_tokens);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(contextWindowMaxTokens !== undefined ? { contextWindowMaxTokens } : {}),
    ...(contextWindowUsedTokens !== undefined ? { contextWindowUsedTokens } : {}),
  };
}

interface TokenPair {
  inputTokens?: number;
  outputTokens?: number;
}

/** 本轮 token 统计（design.md 5.3）：起点 = 本轮首条带 total 的更新的 total − last，latest 为本轮最新 total */
export interface CodexTurnTokens {
  start: TokenPair;
  latest: TokenPair;
}

function readTokenPair(record: JsonRecord | null): TokenPair {
  const inputTokens = finiteNumber(pick(record, "inputTokens", "input_tokens"));
  const outputTokens = finiteNumber(pick(record, "outputTokens", "output_tokens"));
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

/** 按一条 thread/tokenUsage/updated 更新本轮 token 统计；该条没有 total 时原样返回 */
export function updateCodexTurnTokens(
  tokens: CodexTurnTokens | undefined,
  tokenUsage: unknown,
): CodexTurnTokens | undefined {
  const usage = asRecord(tokenUsage);
  const total = readTokenPair(asRecord(pick(usage, "total", "total_token_usage")));
  if (total.inputTokens === undefined && total.outputTokens === undefined) {
    return tokens;
  }
  if (tokens) {
    return { start: tokens.start, latest: total };
  }
  const last = readTokenPair(asRecord(pick(usage, "last", "last_token_usage")));
  const startOf = (value: number | undefined, delta: number | undefined) =>
    value === undefined ? undefined : value - (delta ?? 0);
  const inputTokens = startOf(total.inputTokens, last.inputTokens);
  const outputTokens = startOf(total.outputTokens, last.outputTokens);
  return {
    start: {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
    },
    latest: total,
  };
}

/**
 * turn_completed 的 usage：token 数为本轮合计（最新 total − 起点），没有 total 时退回 last；
 * 上下文窗口等其余字段仍取最近一次 last（design.md 5.3）
 */
export function codexTurnCompletedUsage(
  usage: AgentUsage | undefined,
  tokens: CodexTurnTokens | undefined,
): AgentUsage | undefined {
  if (!usage) return undefined;
  const turnTotal = (key: keyof TokenPair): number | undefined => {
    const latest = tokens?.latest[key];
    const start = tokens?.start[key];
    return latest !== undefined && start !== undefined ? latest - start : usage[key];
  };
  const inputTokens = turnTotal("inputTokens");
  const outputTokens = turnTotal("outputTokens");
  return {
    ...usage,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

/** turn/plan/updated → todo */
export function planToTodoItems(plan: unknown): { text: string; completed: boolean }[] {
  if (!Array.isArray(plan)) return [];
  return plan
    .map((entry) => asRecord(entry))
    .filter((entry): entry is JsonRecord => entry !== null)
    .map((entry) => ({
      text: (str(entry.step) ?? str(entry.text) ?? "").trim(),
      completed: String(entry.status ?? "").toLowerCase() === "completed",
    }))
    .filter((entry) => entry.text.length > 0);
}

/**
 * model/list 的一项 → AgentModelDefinition（隐藏模型跳过）。
 * 思考档位来自 supportedReasoningEfforts，defaultReasoningEffort 不在其中时补一项（参照 paseo）。
 */
export function toModelDefinition(
  raw: unknown,
  providerId: string = CODEX_PROVIDER_ID,
): AgentModelDefinition | null {
  const record = asRecord(raw);
  if (!record || record.hidden === true) return null;
  const id = str(record.id) ?? str(record.model);
  if (!id) return null;
  const label = str(record.displayName) ?? str(record.display_name) ?? id;
  const description = str(record.description);
  const defaultEffort = normalizeThinkingOptionId(
    str(pick(record, "defaultReasoningEffort", "default_reasoning_effort")),
  );
  const thinkingOptions = codexThinkingOptions(
    pick(record, "supportedReasoningEfforts", "supported_reasoning_efforts"),
    defaultEffort,
  );
  return {
    provider: providerId,
    id,
    label,
    ...(description ? { description } : {}),
    ...(record.isDefault === true || record.is_default === true ? { isDefault: true } : {}),
    ...(thinkingOptions.length > 0 ? { thinkingOptions } : {}),
    ...(defaultEffort && thinkingOptions.length > 0 ? { defaultThinkingOptionId: defaultEffort } : {}),
  };
}

function codexThinkingOptions(raw: unknown, defaultEffort: string | null): AgentThinkingOption[] {
  const options = new Map<string, AgentThinkingOption>();
  for (const entry of Array.isArray(raw) ? raw : []) {
    const record = asRecord(entry);
    const effort = normalizeThinkingOptionId(
      typeof entry === "string" ? entry : str(pick(record, "reasoningEffort", "reasoning_effort")),
    );
    if (effort && !options.has(effort)) {
      options.set(effort, makeThinkingOption(effort, { description: str(record?.description) ?? null }));
    }
  }
  if (defaultEffort && !options.has(defaultEffort)) {
    options.set(defaultEffort, makeThinkingOption(defaultEffort, { description: "模型默认档位" }));
  }
  return Array.from(options.values());
}

async function listCodexModels(
  client: CodexAppServerClient,
  providerId: string,
): Promise<AgentModelDefinition[]> {
  const models: AgentModelDefinition[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MODEL_LIST_MAX_PAGES; page += 1) {
    const response = asRecord(
      await client.request("model/list", cursor ? { cursor } : {}, MODEL_LIST_TIMEOUT_MS),
    );
    const data = Array.isArray(response?.data) ? response.data : [];
    for (const entry of data) {
      const model = toModelDefinition(entry, providerId);
      if (model && !models.some((m) => m.id === model.id)) {
        models.push(model);
      }
    }
    cursor = str(pick(response, "nextCursor", "next_cursor")) ?? null;
    if (!cursor) break;
  }
  return models;
}

function isAlreadyIdleInterruptError(error: unknown): boolean {
  return (
    error instanceof CodexAppServerRpcError &&
    /no active turn|not running|already (?:idle|completed|finished)/i.test(error.message)
  );
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

// ---------------------------------------------------------------------------
// app-server 进程
// ---------------------------------------------------------------------------

interface AppServerDeps {
  logger: Logger;
  env: NodeJS.ProcessEnv;
}

/** 拉起 `codex app-server` 并完成 initialize → initialized 握手 */
async function openAppServer(
  launch: CodexLaunch,
  cwd: string,
  deps: AppServerDeps,
): Promise<CodexAppServerClient> {
  const child = spawnProcess(launch.command, [...launch.args, "app-server"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    detached: process.platform !== "win32",
    baseEnv: deps.env,
    ...(launch.envOverlay ? { envOverlay: launch.envOverlay } : {}),
  });
  if (!child.stdin || !child.stdout || !child.stderr) {
    child.kill();
    throw new Error("Codex app-server 子进程缺少 stdio 管道");
  }
  const client = new CodexAppServerClient(child as ChildProcessWithoutNullStreams, deps.logger);
  try {
    await client.request(
      "initialize",
      {
        clientInfo: { name: "agentdeck", title: "AgentDeck", version: CLIENT_VERSION },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
      INITIALIZE_TIMEOUT_MS,
    );
    client.notify("initialized", {});
  } catch (error) {
    const tail = client.stderrTail.trim();
    await client.dispose().catch(() => undefined);
    throw new Error(
      `Codex app-server 初始化失败：${errorMessage(error)}${tail ? `\n${tail.slice(-1000)}` : ""}`,
    );
  }
  return client;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * 启动配置覆盖（自定义中转 provider 用，design.md 4.7）；不传时行为与内置 codex provider 完全相同。
 */
export interface CodexLaunchOverride {
  /** 从继承环境中剔除的变量（不区分大小写），在 envOverlay 之前生效 */
  stripEnv?: readonly string[];
  /** 叠加到 app-server 进程环境的变量（最后应用） */
  envOverlay?: Readonly<Record<string, string>>;
  /** 合并进 thread/start、thread/resume 的 `config` 覆盖（如 model_provider / model_providers） */
  threadConfig?: Readonly<Record<string, unknown>>;
}

export interface CodexAgentClientOptions {
  logger: Logger;
  env: NodeJS.ProcessEnv;
  /** 测试注入：替代默认的可执行文件定位 */
  resolveLaunch?: () => CodexLaunch | null | Promise<CodexLaunch | null>;
  /** provider id，默认 `codex`（自定义中转为 `custom:<id>`） */
  providerId?: string;
  /** 显示名，默认 `Codex` */
  label?: string;
  launch?: CodexLaunchOverride;
}

const NOT_FOUND_REASON =
  "未找到 Codex CLI：请先安装（npm i -g @openai/codex），或用环境变量 AGENTDECK_CODEX_PATH 指定 codex 可执行文件";

/** 剔除 stripEnv（不区分大小写）后叠加 envOverlay；都没有时原样返回 */
export function applyCodexEnvOverride(
  env: NodeJS.ProcessEnv,
  launch: CodexLaunchOverride | undefined,
): NodeJS.ProcessEnv {
  if (!launch?.stripEnv?.length && !launch?.envOverlay) {
    return env;
  }
  const strip = new Set((launch.stripEnv ?? []).map((key) => key.toUpperCase()));
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!strip.has(key.toUpperCase())) {
      result[key] = value;
    }
  }
  return { ...result, ...launch.envOverlay };
}

export class CodexAgentClient implements AgentClient {
  readonly provider: string;
  readonly kind = "codex" as const;
  readonly label: string;
  /** 支持 turn/steer（design.md 4.22） */
  readonly capabilities = { steer: true } as const;

  private readonly sessions = new Set<CodexAgentSession>();
  /** 已应用 launch 覆盖的环境（解析可执行文件与拉起 app-server 共用） */
  private readonly env: NodeJS.ProcessEnv;
  private readonly logger: Logger;
  private readonly threadConfig: Readonly<Record<string, unknown>> | undefined;

  constructor(private readonly options: CodexAgentClientOptions) {
    this.provider = options.providerId ?? CODEX_PROVIDER_ID;
    this.label = options.label ?? "Codex";
    this.logger = options.logger;
    this.env = applyCodexEnvOverride(options.env, options.launch);
    this.threadConfig = options.launch?.threadConfig;
  }

  private async resolveLaunch(): Promise<CodexLaunch | null> {
    if (this.options.resolveLaunch) {
      return this.options.resolveLaunch();
    }
    return resolveCodexLaunch({
      env: this.env,
      onWarning: (message) => this.logger.warn("[codex] %s", message),
    });
  }

  private async requireLaunch(): Promise<CodexLaunch> {
    const launch = await this.resolveLaunch();
    if (!launch) {
      throw new Error(NOT_FOUND_REASON);
    }
    return launch;
  }

  async isAvailable(): Promise<AgentAvailability> {
    let launch: CodexLaunch | null;
    try {
      launch = await this.resolveLaunch();
    } catch (error) {
      // 「编程 Agent」页配置的路径无效：报不可用并给出原因，不回退自动查找
      return { available: false, reason: errorMessage(error) };
    }
    if (!launch) {
      return { available: false, reason: NOT_FOUND_REASON };
    }
    const command = describeCodexLaunch(launch);
    try {
      const { stdout } = await execCommand(launch.command, [...launch.args, "--version"], {
        timeout: VERSION_PROBE_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
        shell: false,
        baseEnv: this.env,
        ...(launch.envOverlay ? { envOverlay: launch.envOverlay } : {}),
      });
      this.logger.debug("[codex] %s → %s", command.join(" "), stdout.trim());
      return { available: true, command };
    } catch (error) {
      return {
        available: false,
        reason: `Codex CLI 无法运行（${command.join(" ")} --version）：${errorMessage(error)}`,
        command,
      };
    }
  }

  async fetchCatalog(opts?: { cwd?: string }): Promise<{
    models: AgentModelDefinition[];
    modes: AgentMode[];
    commands?: AgentSlashCommand[];
  }> {
    const modes = CODEX_MODES.map((mode) => ({ ...mode }));
    const commands = CODEX_SLASH_COMMANDS.map((command) => ({ ...command }));
    let client: CodexAppServerClient | null = null;
    try {
      const launch = await this.requireLaunch();
      client = await openAppServer(launch, opts?.cwd ?? os.homedir(), {
        logger: this.logger,
        env: this.env,
      });
      const models = await listCodexModels(client, this.provider);
      return { models, modes, commands };
    } catch (error) {
      this.logger.warn("[codex] 获取模型列表失败：%s", errorMessage(error));
      return { models: [], modes, commands };
    } finally {
      await client?.dispose().catch(() => undefined);
    }
  }

  private async sessionBaseDeps(): Promise<
    Pick<CodexSessionDeps, "launch" | "logger" | "env" | "providerId" | "threadConfig" | "onClosed">
  > {
    return {
      launch: await this.requireLaunch(),
      logger: this.logger,
      env: this.env,
      providerId: this.provider,
      ...(this.threadConfig ? { threadConfig: this.threadConfig } : {}),
      onClosed: (s) => this.sessions.delete(s),
    };
  }

  async createSession(cfg: AgentSessionConfig): Promise<AgentSession> {
    const modeId = cfg.modeId ?? DEFAULT_CODEX_MODE_ID;
    assertCodexMode(modeId);
    const session = new CodexAgentSession({
      ...(await this.sessionBaseDeps()),
      cwd: cfg.cwd,
      model: cfg.model ?? null,
      modeId,
      thinkingOptionId: cfg.thinkingOptionId ?? null,
      threadId: null,
    });
    this.sessions.add(session);
    try {
      await session.connect();
    } catch (error) {
      await session.close();
      throw error;
    }
    return session;
  }

  async resumeSession(handle: AgentPersistenceHandle, cfg: { cwd: string }): Promise<AgentSession> {
    const session = new CodexAgentSession({
      ...(await this.sessionBaseDeps()),
      cwd: cfg.cwd,
      model: null,
      modeId: DEFAULT_CODEX_MODE_ID,
      threadId: handle.sessionId,
    });
    this.sessions.add(session);
    try {
      await session.connect();
    } catch (error) {
      await session.close();
      throw error;
    }
    return session;
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(Array.from(this.sessions, (session) => session.close()));
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

interface ActiveTurn {
  turnId: string;
  nativeTurnId: string | null;
  nativeTurnIdWaiters: Array<(id: string | null) => void>;
  finished: boolean;
  /** 最近一次 last 口径的用量（usage_updated 推送的就是它） */
  usage?: AgentUsage;
  /** 本轮 token 起点与最新合计（design.md 5.3） */
  tokens?: CodexTurnTokens;
  /** itemId → 已流式发出的 assistant 文本 */
  agentText: Map<string, string>;
  /** itemId → 已流式发出的 reasoning 文本与来源（summary / raw，先到者为准） */
  reasoning: Map<string, { text: string; source: "summary" | "raw" }>;
  /** 最近一次不再重试的 error 通知 */
  lastError: { message: string; code?: string } | null;
  /** 本轮见过 contextCompaction item：旧版 thread/compacted 通知不再重复发压缩事件（design.md 4.13） */
  sawCompaction?: boolean;
}

type PermissionKind = "command" | "file" | "legacy-exec" | "legacy-patch" | "elicitation";

interface PendingPermission {
  request: AgentPermissionRequest;
  kind: PermissionKind;
  rpcId: JsonRpcId;
  resolve: (result: unknown) => void;
}

interface CodexSessionDeps {
  launch: CodexLaunch;
  logger: Logger;
  env: NodeJS.ProcessEnv;
  /** 默认 `codex` */
  providerId?: string;
  /** 合并进 thread/start、thread/resume 的 `config` 覆盖 */
  threadConfig?: Readonly<Record<string, unknown>>;
  cwd: string;
  model: string | null;
  modeId: string;
  /** 思考强度（turn/start 的 effort）；null / 缺省为跟随 Codex 配置 */
  thinkingOptionId?: string | null;
  threadId: string | null;
  onClosed?: (session: CodexAgentSession) => void;
}

/** 把 AgentPermissionResponse 转成 codex 期望的应答体 */
export function buildPermissionDecision(
  kind: PermissionKind,
  response: AgentPermissionResponse,
): unknown {
  const allow = response.behavior === "allow";
  const cancel = response.behavior === "deny" && response.interrupt === true;
  switch (kind) {
    case "command":
    case "file":
      return { decision: allow ? "accept" : cancel ? "cancel" : "decline" };
    case "legacy-exec":
    case "legacy-patch":
      if (allow) return { decision: "approved" };
      if (cancel) return { decision: "abort" };
      return {
        decision: {
          denied: { rejection: response.behavior === "deny" && response.message ? response.message : "用户拒绝" },
        },
      };
    case "elicitation":
      return allow
        ? { action: "accept", content: {}, _meta: null }
        : { action: cancel ? "cancel" : "decline", content: null, _meta: null };
  }
}

const CANCEL_RESPONSE: AgentPermissionResponse = {
  behavior: "deny",
  message: "回合已结束",
  interrupt: true,
};

export class CodexAgentSession implements AgentSession {
  readonly provider: string;

  private client: CodexAppServerClient | null = null;
  private connecting: Promise<CodexAppServerClient> | null = null;
  private threadId: string | null;
  private threadLoaded = false;
  /** 进行中的 thread/start / thread/resume（回合与 MCP 查询可能并发调用 ensureThread） */
  private threadLoading: Promise<void> | null = null;
  private threadAnnounced = false;
  private model: string | null;
  private modeId: string;
  /** setModel / setMode 之后下一轮 turn/start 需要带上覆盖 */
  private modelOverridePending = false;
  private modeOverridePending = false;
  /** null 为跟随 Codex 配置（turn/start 不带 effort） */
  private thinkingOptionId: string | null;
  /** 已在本线程的 turn/start 带过具体 effort：codex 会沿用到后续回合，切回 null 时要显式带默认档位 */
  private effortOverridden = false;
  private active: ActiveTurn | null = null;
  private readonly finishedNativeTurnIds = new Set<string>();
  private readonly pending = new Map<string, PendingPermission>();
  /** itemId → 最近一次映射出的工具调用（审批请求复用其 detail） */
  private readonly toolItems = new Map<string, ToolCallTimelineItem>();
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  private readonly imageFiles: string[] = [];
  private readonly subagents: CodexSubagentRouter;
  private closed = false;

  constructor(private readonly deps: CodexSessionDeps) {
    this.provider = deps.providerId ?? CODEX_PROVIDER_ID;
    this.threadId = deps.threadId;
    this.model = deps.model;
    this.modeId = deps.modeId;
    this.thinkingOptionId = normalizeThinkingOptionId(deps.thinkingOptionId);
    this.subagents = new CodexSubagentRouter({
      cwd: deps.cwd,
      rootThreadId: () => this.threadId,
      emitSubagent: (event) => this.emit({ type: "provider_subagent", event }),
      // 子线程活动可能晚于父回合结束：没有活动回合时不带 turnId
      emitParentCard: (item) =>
        this.emit({ type: "timeline", ...(this.active ? { turnId: this.active.turnId } : {}), item }),
    });
  }

  get id(): string | null {
    return this.threadId;
  }

  /** 拉起 app-server 并握手；resume 时顺带 thread/resume（失败尽早暴露） */
  async connect(): Promise<void> {
    await this.ensureClient();
    if (this.threadId) {
      await this.ensureThread();
    }
  }

  subscribe(cb: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return Array.from(this.pending.values(), (p) => p.request);
  }

  describePersistence(): AgentPersistenceHandle | null {
    return this.threadId ? { provider: this.provider, sessionId: this.threadId } : null;
  }

  async startTurn(
    prompt: AgentPromptInput,
    opts?: { clientMessageId?: string },
  ): Promise<{ turnId: string }> {
    if (this.closed) {
      throw new Error("Codex 会话已关闭");
    }
    if (this.active) {
      throw new Error("Codex 会话正在执行中");
    }
    const turn: ActiveTurn = {
      turnId: randomUUID(),
      nativeTurnId: null,
      nativeTurnIdWaiters: [],
      finished: false,
      agentText: new Map(),
      reasoning: new Map(),
      lastError: null,
    };
    this.active = turn;
    this.emit({ type: "turn_started", turnId: turn.turnId });
    void this.runTurnStart(turn, prompt, opts);
    return { turnId: turn.turnId };
  }

  /** 后台完成：确保 app-server 与线程就绪 → turn/start；任何失败都以 turn_failed 结束本轮 */
  private async runTurnStart(
    turn: ActiveTurn,
    prompt: AgentPromptInput,
    opts?: { clientMessageId?: string },
  ): Promise<void> {
    let client: CodexAppServerClient;
    try {
      client = await this.ensureClient();
      await this.ensureThread();
    } catch (error) {
      this.finishTurn(turn, {
        type: "turn_failed",
        turnId: turn.turnId,
        error: `Codex 会话启动失败：${errorMessage(error)}`,
      });
      return;
    }
    if (!this.threadAnnounced && this.threadId) {
      this.threadAnnounced = true;
      this.emit({ type: "thread_started", sessionId: this.threadId });
    }
    if (turn.finished) {
      return; // 准备期间已被中断或关闭
    }

    if (isCodexCompactPrompt(prompt)) {
      // 手动压缩（design.md 4.14）：改调 thread/compact/start；原生 turnId、contextCompaction item 与
      // turn/completed 都像普通回合一样经通知到达
      try {
        await client.request(
          "thread/compact/start",
          { threadId: this.threadId },
          TURN_START_TIMEOUT_MS,
        );
      } catch (error) {
        this.finishTurn(turn, {
          type: "turn_failed",
          turnId: turn.turnId,
          error: `Codex thread/compact/start 失败：${errorMessage(error)}`,
        });
      }
      return;
    }

    const params: JsonRecord = {
      threadId: this.threadId,
      input: this.buildUserInput(prompt),
    };
    if (opts?.clientMessageId) {
      params.clientUserMessageId = opts.clientMessageId;
    }
    if (this.model && this.modelOverridePending) {
      params.model = this.model;
    }
    if (this.modeOverridePending) {
      const preset = presetFor(this.modeId);
      params.approvalPolicy = preset.approvalPolicy;
      params.sandboxPolicy = toSandboxPolicy(preset.sandbox);
    }
    const effort = this.thinkingOptionId ?? (this.effortOverridden ? await this.defaultEffort(client) : null);
    if (effort) {
      params.effort = effort;
    }
    if (turn.finished) {
      return; // 查询默认档位期间已被中断或关闭
    }

    let response: unknown;
    try {
      response = await client.request("turn/start", params, TURN_START_TIMEOUT_MS);
    } catch (error) {
      this.finishTurn(turn, {
        type: "turn_failed",
        turnId: turn.turnId,
        error: `Codex turn/start 失败：${errorMessage(error)}`,
      });
      return;
    }
    this.modelOverridePending = false;
    this.modeOverridePending = false;
    if (effort) {
      this.effortOverridden = this.thinkingOptionId !== null;
    }
    const nativeId = str(asRecord(asRecord(response)?.turn)?.id);
    if (!nativeId) {
      return;
    }
    if (turn.finished && !turn.nativeTurnId) {
      // 本地已结束（如等待原生 turnId 超时后被中断）：补发一次中断，并丢弃该回合后续通知
      this.finishedNativeTurnIds.add(nativeId);
      if (this.threadId) {
        client
          .request("turn/interrupt", { threadId: this.threadId, turnId: nativeId }, INTERRUPT_TIMEOUT_MS)
          .catch(() => undefined);
      }
      return;
    }
    this.setNativeTurnId(turn, nativeId);
  }

  async respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void> {
    const pending = this.pending.get(requestId);
    if (!pending) {
      throw new Error(`找不到待处理的权限请求：${requestId}`);
    }
    this.pending.delete(requestId);
    this.emit({ type: "permission_resolved", requestId, response });
    pending.resolve(buildPermissionDecision(pending.kind, response));
  }

  async interrupt(): Promise<void> {
    const turn = this.active;
    if (!turn || turn.finished) {
      return;
    }
    const nativeTurnId = turn.nativeTurnId ?? (await this.waitForNativeTurnId(turn));
    const client = this.client;
    if (nativeTurnId && client && !client.isClosed && this.threadId && !turn.finished) {
      try {
        await client.request(
          "turn/interrupt",
          { threadId: this.threadId, turnId: nativeTurnId },
          INTERRUPT_TIMEOUT_MS,
        );
      } catch (error) {
        if (!isAlreadyIdleInterruptError(error)) {
          this.deps.logger.warn("[codex] turn/interrupt 失败：%s", errorMessage(error));
        }
      }
    } else if (!nativeTurnId) {
      this.deps.logger.warn("[codex] 未拿到原生 turnId，直接在本地结束回合");
    }
    this.finishTurn(turn, { type: "turn_canceled", turnId: turn.turnId, reason: "interrupted" });
  }

  /** 运行中插话（design.md 4.22）：turn/steer，错误（含 review / compact 回合不可插话）原样转成中文消息 */
  async steer(prompt: AgentPromptInput, opts?: { clientMessageId?: string }): Promise<void> {
    const turn = this.active;
    if (!turn || turn.finished) {
      throw new Error("当前没有进行中的回合");
    }
    const nativeTurnId = turn.nativeTurnId ?? (await this.waitForNativeTurnId(turn));
    const client = this.client;
    if (!nativeTurnId || !client || client.isClosed || !this.threadId || turn.finished) {
      throw new Error("Codex 回合尚未就绪，无法插话");
    }
    const params: JsonRecord = {
      threadId: this.threadId,
      input: this.buildUserInput(prompt),
      expectedTurnId: nativeTurnId,
    };
    if (opts?.clientMessageId) {
      params.clientUserMessageId = opts.clientMessageId;
    }
    try {
      await client.request("turn/steer", params, TURN_START_TIMEOUT_MS);
    } catch (error) {
      throw new Error(`Codex 插话失败：${errorMessage(error)}`);
    }
  }

  async setModel(modelId: string | null): Promise<void> {
    if (modelId === null && this.threadLoaded && this.client && !this.client.isClosed) {
      // 线程已按旧模型启动：恢复默认需要显式传默认模型
      try {
        const models = await listCodexModels(this.client, this.provider);
        const fallback = models.find((m) => m.isDefault) ?? models[0];
        this.model = fallback?.id ?? null;
        this.modelOverridePending = this.model !== null;
      } catch (error) {
        this.deps.logger.warn("[codex] 查询默认模型失败，保持当前模型：%s", errorMessage(error));
      }
    } else {
      this.model = modelId;
      this.modelOverridePending = modelId !== null;
    }
    this.emit({ type: "model_changed", modelId });
  }

  /** 只改配置，下一次 turn/start 生效（design.md 4.10） */
  async setThinking(thinkingOptionId: string | null): Promise<{ notice?: string }> {
    this.thinkingOptionId = normalizeThinkingOptionId(thinkingOptionId);
    this.emit({ type: "thinking_option_changed", thinkingOptionId: this.thinkingOptionId });
    return this.active && !this.active.finished ? { notice: THINKING_APPLIES_NEXT_TURN_NOTICE } : {};
  }

  /** design.md 4.14：只有 /compact（sidecar 拦截） */
  async listCommands(): Promise<AgentSlashCommand[]> {
    return CODEX_SLASH_COMMANDS.map((command) => ({ ...command }));
  }

  /** mcpServerStatus/list 翻页汇总；线程尚不存在时先建线程。只能整体重新加载（reconnect: all） */
  async getMcpStatus(): Promise<AgentMcpStatusResult> {
    const client = await this.ensureClient();
    await this.ensureThread();
    const servers: AgentMcpServer[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MCP_STATUS_MAX_PAGES; page += 1) {
      const response = asRecord(
        await client.request(
          "mcpServerStatus/list",
          { threadId: this.threadId, detail: "toolsAndAuthOnly", ...(cursor ? { cursor } : {}) },
          MCP_STATUS_TIMEOUT_MS,
        ),
      );
      const data: unknown[] = Array.isArray(response?.data) ? response.data : [];
      for (const entry of data) {
        const server = mapCodexMcpServer(entry);
        if (server) {
          servers.push(server);
        }
      }
      cursor = str(response?.nextCursor) ?? null;
      if (!cursor) {
        break;
      }
    }
    return { servers, reconnect: "all" };
  }

  /**
   * AgentDeck 本地 /status（design.md 4.14）：会话 / 账户 / 用量限制 / MCP。
   * account/read、account/rateLimits/read 读不到就跳过该分组；MCP 失败只在该分组显示错误。
   */
  async getStatus(): Promise<AgentStatusSection[]> {
    const client = await this.ensureClient();
    const [account, limits, mcp] = await Promise.all([
      client.request("account/read", { refreshToken: false }, MODEL_LIST_TIMEOUT_MS).catch((error: unknown) => {
        this.deps.logger.debug("[codex] account/read 失败：%s", errorMessage(error));
        return null;
      }),
      client.request("account/rateLimits/read", undefined, MODEL_LIST_TIMEOUT_MS).catch((error: unknown) => {
        this.deps.logger.debug("[codex] account/rateLimits/read 失败：%s", errorMessage(error));
        return null;
      }),
      buildMcpSection(() => this.getMcpStatus()),
    ]);
    const modeLabel = CODEX_MODES.find((m) => m.id === this.modeId)?.label;
    const sections: AgentStatusSection[] = [
      {
        title: "会话",
        rows: buildRows([
          ["线程 ID", this.threadId],
          ["工作目录", this.deps.cwd],
          ["模型", this.model ?? "默认（跟随设置）"],
          ["模式", modeLabel ? `${modeLabel}（${this.modeId}）` : this.modeId],
        ]),
      },
    ];
    const accountSection = buildCodexAccountSection(account);
    if (accountSection) sections.push(accountSection);
    const limitSection = buildCodexRateLimitSection(limits);
    if (limitSection) sections.push(limitSection);
    sections.push(mcp);
    return sections;
  }

  /** config/mcpServer/reload：从磁盘重载 MCP 配置并整体生效；没有按服务器重连，忽略 serverName */
  async reconnectMcp(): Promise<void> {
    const client = await this.ensureClient();
    await client.request("config/mcpServer/reload", undefined, MCP_RELOAD_TIMEOUT_MS);
  }

  /**
   * 切回「跟随配置」时显式带的默认档位：config/read 的 model_reasoning_effort，
   * 取不到再用当前模型（未指定时为默认模型）的 defaultReasoningEffort；都取不到返回 null。
   */
  private async defaultEffort(client: CodexAppServerClient): Promise<string | null> {
    try {
      const config = asRecord(asRecord(await client.request("config/read", {}, MODEL_LIST_TIMEOUT_MS))?.config);
      const configured = normalizeThinkingOptionId(
        str(pick(config, "model_reasoning_effort", "modelReasoningEffort")),
      );
      if (configured) return configured;
    } catch (error) {
      this.deps.logger.debug("[codex] config/read 失败：%s", errorMessage(error));
    }
    try {
      const models = await listCodexModels(client, this.provider);
      const model = this.model
        ? models.find((m) => m.id === this.model)
        : (models.find((m) => m.isDefault) ?? models[0]);
      return model?.defaultThinkingOptionId ?? null;
    } catch (error) {
      this.deps.logger.warn("[codex] 查询默认思考档位失败：%s", errorMessage(error));
      return null;
    }
  }

  async setMode(modeId: string): Promise<void> {
    assertCodexMode(modeId);
    this.modeId = modeId;
    this.modeOverridePending = this.threadLoaded;
    this.emit({ type: "mode_changed", modeId });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const turn = this.active;
    if (turn) {
      this.finishTurn(turn, { type: "turn_canceled", turnId: turn.turnId, reason: "会话已关闭" });
    }
    this.cancelAllPermissions({ behavior: "deny", message: "会话已关闭", interrupt: true });
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        await client.dispose();
      } catch (error) {
        this.deps.logger.warn("[codex] 关闭 app-server 失败：%s", errorMessage(error));
      }
    }
    for (const file of this.imageFiles.splice(0)) {
      rmSync(file, { force: true });
    }
    this.subagents.reset();
    this.listeners.clear();
    this.deps.onClosed?.(this);
  }

  // -------------------------------------------------------------------------
  // 连接与线程
  // -------------------------------------------------------------------------

  private async ensureClient(): Promise<CodexAppServerClient> {
    if (this.client && !this.client.isClosed) {
      return this.client;
    }
    if (this.closed) {
      throw new Error("Codex 会话已关闭");
    }
    if (!this.connecting) {
      this.connecting = openAppServer(this.deps.launch, this.deps.cwd, this.deps)
        .then((client) => {
          if (this.closed) {
            void client.dispose().catch(() => undefined);
            throw new Error("Codex 会话已关闭");
          }
          this.attachClient(client);
          return client;
        })
        .finally(() => {
          this.connecting = null;
        });
    }
    return this.connecting;
  }

  private attachClient(client: CodexAppServerClient): void {
    this.client = client;
    this.threadLoaded = false;
    // 旧进程已不在，它的回合不会再有通知
    this.finishedNativeTurnIds.clear();
    client.setNotificationHandler((method, params) => {
      try {
        this.handleNotification(method, params);
      } catch (error) {
        this.deps.logger.warn("[codex] 处理通知 %s 失败：%s", method, errorMessage(error));
      }
    });
    client.setUnexpectedTerminationHandler((error) => this.handleTermination(client, error));
    client.setRequestHandler("item/commandExecution/requestApproval", (params, rpcId) =>
      this.handleCommandApproval(params, rpcId),
    );
    client.setRequestHandler("item/fileChange/requestApproval", (params, rpcId) =>
      this.handleFileChangeApproval(params, rpcId),
    );
    client.setRequestHandler("execCommandApproval", (params, rpcId) =>
      this.handleLegacyExecApproval(params, rpcId),
    );
    client.setRequestHandler("applyPatchApproval", (params, rpcId) =>
      this.handleLegacyPatchApproval(params, rpcId),
    );
    client.setRequestHandler("mcpServer/elicitation/request", (params, rpcId) =>
      this.handleElicitation(params, rpcId),
    );
  }

  private ensureThread(): Promise<void> {
    if (!this.threadLoading) {
      this.threadLoading = this.loadThread().finally(() => {
        this.threadLoading = null;
      });
    }
    return this.threadLoading;
  }

  private async loadThread(): Promise<void> {
    const client = await this.ensureClient();
    if (this.threadLoaded) {
      return;
    }
    const preset = presetFor(this.modeId);
    const base: JsonRecord = {
      cwd: this.deps.cwd,
      approvalPolicy: preset.approvalPolicy,
      sandbox: preset.sandbox,
      ...(this.model ? { model: this.model } : {}),
      // 自定义中转：model_provider / model_providers 等配置覆盖（codex 0.162.1 thread/start、thread/resume 均支持 config）
      ...(this.deps.threadConfig ? { config: structuredClone(this.deps.threadConfig) } : {}),
    };
    if (this.threadId) {
      await client.request(
        "thread/resume",
        { ...base, threadId: this.threadId },
        THREAD_START_TIMEOUT_MS,
      );
    } else {
      const response = asRecord(await client.request("thread/start", base, THREAD_START_TIMEOUT_MS));
      const threadId = str(asRecord(response?.thread)?.id) ?? str(pick(response, "threadId", "thread_id"));
      if (!threadId) {
        throw new Error("Codex thread/start 未返回 thread.id");
      }
      this.threadId = threadId;
    }
    this.threadLoaded = true;
    // thread/start、thread/resume 已带上当前模式与模型
    this.modelOverridePending = false;
    this.modeOverridePending = false;
  }

  private handleTermination(client: CodexAppServerClient, error: Error): void {
    if (this.client !== client) {
      return;
    }
    this.client = null;
    this.threadLoaded = false;
    this.deps.logger.warn("[codex] app-server 意外退出：%s", error.message);
    this.cancelAllPermissions({ behavior: "deny", message: "Codex app-server 已退出" });
    // 子线程随进程一起消失
    this.subagents.failRunning();
    this.subagents.reset();
    const turn = this.active;
    if (turn) {
      this.finishTurn(turn, {
        type: "turn_failed",
        turnId: turn.turnId,
        error: `Codex app-server 进程意外退出：${error.message}`,
        code: "PROCESS_EXITED",
      });
    }
  }

  // -------------------------------------------------------------------------
  // 回合
  // -------------------------------------------------------------------------

  private buildUserInput(prompt: AgentPromptInput): JsonRecord[] {
    if (typeof prompt === "string") {
      return [{ type: "text", text: prompt, text_elements: [] }];
    }
    const input: JsonRecord[] = [];
    for (const part of prompt) {
      if (part.type === "text") {
        input.push({ type: "text", text: part.text, text_elements: [] });
        continue;
      }
      const file = this.writeImageFile(part.data, part.mimeType);
      if (file) {
        input.push({ type: "localImage", path: file });
      }
    }
    return input;
  }

  private writeImageFile(base64: string, mimeType: string): string | null {
    try {
      const dir = path.join(os.tmpdir(), "agentdeck-codex-images");
      mkdirSync(dir, { recursive: true });
      const ext = IMAGE_EXTENSIONS[mimeType.toLowerCase()] ?? "png";
      const file = path.join(dir, `${randomUUID()}.${ext}`);
      writeFileSync(file, Buffer.from(base64, "base64"));
      this.imageFiles.push(file);
      return file;
    } catch (error) {
      this.deps.logger.warn("[codex] 写入图片临时文件失败，忽略该图片：%s", errorMessage(error));
      return null;
    }
  }

  private setNativeTurnId(turn: ActiveTurn, nativeTurnId: string): void {
    if (turn.nativeTurnId) {
      return;
    }
    turn.nativeTurnId = nativeTurnId;
    for (const waiter of turn.nativeTurnIdWaiters.splice(0)) {
      waiter(nativeTurnId);
    }
  }

  private waitForNativeTurnId(turn: ActiveTurn): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        turn.nativeTurnIdWaiters = turn.nativeTurnIdWaiters.filter((w) => w !== done);
        resolve(turn.nativeTurnId);
      }, NATIVE_TURN_ID_WAIT_MS);
      const done = (id: string | null) => {
        clearTimeout(timer);
        resolve(id);
      };
      turn.nativeTurnIdWaiters.push(done);
    });
  }

  /** 结束回合：只发一次终态事件，清理挂起审批 */
  private finishTurn(
    turn: ActiveTurn,
    event: Extract<AgentStreamEvent, { type: "turn_completed" | "turn_failed" | "turn_canceled" }>,
  ): void {
    if (turn.finished) {
      return;
    }
    turn.finished = true;
    if (turn.nativeTurnId) {
      this.finishedNativeTurnIds.add(turn.nativeTurnId);
    }
    for (const waiter of turn.nativeTurnIdWaiters.splice(0)) {
      waiter(null);
    }
    if (this.active === turn) {
      this.active = null;
    }
    this.cancelAllPermissions(CANCEL_RESPONSE);
    this.toolItems.clear();
    this.emit(event);
  }

  private cancelAllPermissions(response: AgentPermissionResponse): void {
    for (const [requestId, pending] of Array.from(this.pending)) {
      this.pending.delete(requestId);
      this.emit({ type: "permission_resolved", requestId, response });
      pending.resolve(
        buildPermissionDecision(pending.kind, {
          behavior: "deny",
          interrupt: true,
          ...(response.behavior === "deny" && response.message ? { message: response.message } : {}),
        }),
      );
    }
  }

  // -------------------------------------------------------------------------
  // 通知
  // -------------------------------------------------------------------------

  private handleNotification(method: string, rawParams: unknown): void {
    const params = asRecord(rawParams);

    if (method === "serverRequest/resolved") {
      this.handleServerRequestResolved(params);
      return;
    }

    // 其它线程（子代理）的通知路由到子代理时间线，不进入本会话时间线；不受父回合限制
    const threadId = str(pick(params, "threadId", "thread_id"));
    if (threadId && this.threadId && threadId !== this.threadId) {
      this.subagents.routeNotification(method, params, threadId);
      return;
    }

    const turn = this.active;
    const notificationTurnId =
      str(pick(params, "turnId", "turn_id")) ?? str(asRecord(params?.turn)?.id);
    if (notificationTurnId && this.finishedNativeTurnIds.has(notificationTurnId)) {
      return;
    }

    if (method === "turn/started") {
      if (turn && notificationTurnId) {
        this.setNativeTurnId(turn, notificationTurnId);
      }
      return;
    }

    if (!turn || turn.finished) {
      this.deps.logger.debug("[codex] 空闲时收到通知 %s，忽略", method);
      return;
    }
    if (notificationTurnId && turn.nativeTurnId && notificationTurnId !== turn.nativeTurnId) {
      this.deps.logger.debug("[codex] 忽略其它回合（%s）的通知 %s", notificationTurnId, method);
      return;
    }

    switch (method) {
      case "item/agentMessage/delta":
        this.handleAgentMessageDelta(turn, params);
        return;
      case "item/reasoning/summaryTextDelta":
        this.handleReasoningDelta(turn, params, "summary");
        return;
      case "item/reasoning/textDelta":
        this.handleReasoningDelta(turn, params, "raw");
        return;
      case "item/reasoning/summaryPartAdded":
        this.handleReasoningPartAdded(turn, params);
        return;
      case "item/started":
        this.handleItem(turn, params, "started");
        return;
      case "item/completed":
        this.handleItem(turn, params, "completed");
        return;
      case "turn/plan/updated": {
        const items = planToTodoItems(params?.plan);
        if (items.length > 0) {
          this.emitTimeline(turn, { type: "todo", items });
        }
        return;
      }
      case "thread/tokenUsage/updated": {
        const tokenUsage = pick(params, "tokenUsage", "token_usage");
        const usage = toAgentUsage(tokenUsage);
        if (usage) {
          turn.usage = usage;
          turn.tokens = updateCodexTurnTokens(turn.tokens, tokenUsage);
          this.emit({ type: "usage_updated", usage });
        }
        return;
      }
      case "thread/compacted":
        // 旧版通知（已被 contextCompaction item 取代）：本轮没见过 item 时补一条完成事件
        if (!turn.sawCompaction) {
          turn.sawCompaction = true;
          this.emitTimeline(turn, {
            type: "compaction",
            compactionId: `compact-${notificationTurnId ?? turn.turnId}`,
            status: "completed",
          });
        }
        return;
      case "turn/completed":
        this.handleTurnCompleted(turn, params);
        return;
      case "error":
        this.handleErrorNotification(turn, params);
        return;
      default:
        return;
    }
  }

  private handleAgentMessageDelta(turn: ActiveTurn, params: JsonRecord | null): void {
    const itemId = str(pick(params, "itemId", "item_id")) ?? "agent-message";
    const delta = typeof params?.delta === "string" ? params.delta : "";
    if (!delta) return;
    turn.agentText.set(itemId, (turn.agentText.get(itemId) ?? "") + delta);
    this.emitTimeline(turn, { type: "assistant_message", text: delta, messageId: itemId });
  }

  private handleReasoningDelta(
    turn: ActiveTurn,
    params: JsonRecord | null,
    source: "summary" | "raw",
  ): void {
    const itemId = str(pick(params, "itemId", "item_id")) ?? "reasoning";
    const delta = typeof params?.delta === "string" ? params.delta : "";
    if (!delta) return;
    const state = turn.reasoning.get(itemId);
    if (state && state.source !== source) {
      return; // 同一推理项只取一种来源，避免摘要与原文重复
    }
    turn.reasoning.set(itemId, { text: (state?.text ?? "") + delta, source });
    this.emitTimeline(turn, { type: "reasoning", text: delta });
  }

  private handleReasoningPartAdded(turn: ActiveTurn, params: JsonRecord | null): void {
    const itemId = str(pick(params, "itemId", "item_id")) ?? "reasoning";
    const state = turn.reasoning.get(itemId);
    if (state && state.source === "summary" && state.text.length > 0) {
      state.text += "\n\n";
      this.emitTimeline(turn, { type: "reasoning", text: "\n\n" });
    }
  }

  private handleItem(turn: ActiveTurn, params: JsonRecord | null, phase: "started" | "completed"): void {
    const item = asRecord(params?.item);
    if (!item) return;
    const type = str(item.type);
    const itemId = str(item.id);

    if (type === "agentMessage") {
      if (phase !== "completed") return;
      const text = typeof item.text === "string" ? item.text : "";
      const streamed = itemId ? turn.agentText.get(itemId) : undefined;
      const missing = streamed === undefined ? text : text.startsWith(streamed) ? text.slice(streamed.length) : "";
      if (missing) {
        if (itemId) turn.agentText.set(itemId, text);
        this.emitTimeline(turn, {
          type: "assistant_message",
          text: missing,
          ...(itemId ? { messageId: itemId } : {}),
        });
      }
      return;
    }

    if (type === "reasoning") {
      if (phase !== "completed") return;
      const streamed = itemId ? turn.reasoning.get(itemId) : undefined;
      if (streamed && streamed.text.length > 0) return;
      const summary = Array.isArray(item.summary) ? item.summary.filter((s) => typeof s === "string") : [];
      const content = Array.isArray(item.content) ? item.content.filter((s) => typeof s === "string") : [];
      const text = (summary.length > 0 ? summary : content).join("\n\n").trim();
      if (text) {
        this.emitTimeline(turn, { type: "reasoning", text });
      }
      return;
    }

    if (type === "plan") {
      if (phase !== "completed") return;
      const text = typeof item.text === "string" ? item.text.trim() : "";
      if (text && itemId) {
        this.emitTimeline(turn, {
          type: "tool_call",
          callId: itemId,
          name: "plan",
          status: "completed",
          error: null,
          detail: { type: "plan", text },
        });
      }
      return;
    }

    // 上下文压缩（design.md 4.13）：不是工具调用，单独成一条 compaction 事件
    if (type === "contextCompaction" || type === "context_compaction") {
      turn.sawCompaction = true;
      this.emitTimeline(turn, {
        type: "compaction",
        compactionId: itemId ?? `compact-${turn.turnId}`,
        status: phase === "started" ? "running" : "completed",
      });
      return;
    }

    const tool = mapCodexToolCallFromThreadItem(item, { cwd: this.deps.cwd });
    if (!tool) return;
    const routed = this.subagents.handleRootItem(item, tool);
    if (routed === "handled") return; // 已登记子线程的 subAgentActivity：更新的是既有卡片
    const card = routed ? routed.card : tool;
    this.toolItems.set(card.callId, card);
    this.emitTimeline(turn, card);
    routed?.replay();
  }

  private handleTurnCompleted(turn: ActiveTurn, params: JsonRecord | null): void {
    const nativeTurn = asRecord(params?.turn);
    const status = String(nativeTurn?.status ?? "completed");
    if (status === "interrupted") {
      this.finishTurn(turn, { type: "turn_canceled", turnId: turn.turnId, reason: "interrupted" });
      return;
    }
    if (status === "failed") {
      const nativeError = asRecord(nativeTurn?.error);
      const message =
        str(nativeError?.message) ?? turn.lastError?.message ?? "Codex 回合失败";
      const code = codexErrorCode(pick(nativeError, "codexErrorInfo", "codex_error_info")) ?? turn.lastError?.code;
      this.finishTurn(turn, {
        type: "turn_failed",
        turnId: turn.turnId,
        error: message,
        ...(code ? { code } : {}),
      });
      return;
    }
    const usage = codexTurnCompletedUsage(turn.usage, turn.tokens);
    this.finishTurn(turn, {
      type: "turn_completed",
      turnId: turn.turnId,
      ...(usage ? { usage } : {}),
    });
  }

  private handleErrorNotification(turn: ActiveTurn, params: JsonRecord | null): void {
    const error = asRecord(params?.error);
    const message = str(error?.message) ?? str(params?.message) ?? "Codex 返回错误";
    const willRetry = pick(params, "willRetry", "will_retry") === true;
    if (willRetry) {
      this.deps.logger.warn("[codex] 可重试错误：%s", message);
      return;
    }
    const code = codexErrorCode(pick(error, "codexErrorInfo", "codex_error_info"));
    turn.lastError = { message, ...(code ? { code } : {}) };
    this.finishTurn(turn, {
      type: "turn_failed",
      turnId: turn.turnId,
      error: message,
      ...(code ? { code } : {}),
    });
  }

  private handleServerRequestResolved(params: JsonRecord | null): void {
    const rpcId = pick(params, "requestId", "request_id");
    if (typeof rpcId !== "string" && typeof rpcId !== "number") return;
    for (const [requestId, pending] of this.pending) {
      if (String(pending.rpcId) !== String(rpcId)) continue;
      this.pending.delete(requestId);
      const response: AgentPermissionResponse = { behavior: "deny", message: "Codex 已撤销该请求" };
      this.emit({ type: "permission_resolved", requestId, response });
      pending.resolve(buildPermissionDecision(pending.kind, { ...response, interrupt: true }));
      return;
    }
  }

  // -------------------------------------------------------------------------
  // 审批（server → client 请求）
  // -------------------------------------------------------------------------

  private requestPermission(
    kind: PermissionKind,
    rpcId: JsonRpcId,
    request: Omit<AgentPermissionRequest, "id" | "provider" | "kind" | "actions">,
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.resolve(
        buildPermissionDecision(kind, { behavior: "deny", interrupt: true, message: "会话已关闭" }),
      );
    }
    const full: AgentPermissionRequest = {
      id: randomUUID(),
      provider: this.provider,
      kind: "tool",
      actions: PERMISSION_ACTIONS.map((a) => ({ ...a })),
      ...request,
    };
    return new Promise((resolve) => {
      this.pending.set(full.id, { request: full, kind, rpcId, resolve });
      const turn = this.active;
      this.emit({
        type: "permission_requested",
        ...(turn ? { turnId: turn.turnId } : {}),
        request: full,
      });
    });
  }

  private handleCommandApproval(rawParams: unknown, rpcId: JsonRpcId): Promise<unknown> {
    const params = asRecord(rawParams);
    const itemId = str(pick(params, "itemId", "item_id"));
    const cached = itemId ? this.toolItems.get(itemId) : undefined;
    const command =
      normalizeCommandExecutionCommand(params?.command) ??
      (cached?.detail.type === "shell" ? cached.detail.command : undefined) ??
      "";
    const cwd = str(params?.cwd) ?? this.deps.cwd;
    const reason = str(params?.reason);
    const writeStdin = params?.kind === "writeStdin";
    return this.requestPermission("command", rpcId, {
      name: "shell",
      title: writeStdin ? "向终端写入输入" : command ? `运行命令：${command}` : "运行命令",
      ...(reason ? { description: reason } : {}),
      input: { command, cwd, ...(itemId ? { itemId } : {}) },
      detail: { type: "shell", command, cwd },
    });
  }

  private handleFileChangeApproval(rawParams: unknown, rpcId: JsonRpcId): Promise<unknown> {
    const params = asRecord(rawParams);
    const itemId = str(pick(params, "itemId", "item_id"));
    const cached = itemId ? this.toolItems.get(itemId) : undefined;
    const reason = str(params?.reason);
    const grantRoot = str(pick(params, "grantRoot", "grant_root"));
    const detail: ToolCallDetail =
      cached && (cached.detail.type === "edit" || cached.detail.type === "write")
        ? cached.detail
        : { type: "unknown", input: { reason: reason ?? null, grantRoot: grantRoot ?? null }, output: null };
    const filePath = detail.type === "edit" || detail.type === "write" ? detail.filePath : undefined;
    return this.requestPermission("file", rpcId, {
      name: "apply_patch",
      title: filePath ? `修改文件：${filePath}` : "修改文件",
      ...(reason ? { description: reason } : {}),
      input: { ...(itemId ? { itemId } : {}), ...(grantRoot ? { grantRoot } : {}) },
      detail,
    });
  }

  private handleLegacyExecApproval(rawParams: unknown, rpcId: JsonRpcId): Promise<unknown> {
    const params = asRecord(rawParams);
    const command = normalizeCommandExecutionCommand(params?.command) ?? "";
    const cwd = str(params?.cwd) ?? this.deps.cwd;
    const reason = str(params?.reason);
    return this.requestPermission("legacy-exec", rpcId, {
      name: "shell",
      title: command ? `运行命令：${command}` : "运行命令",
      ...(reason ? { description: reason } : {}),
      input: { command, cwd },
      detail: { type: "shell", command, cwd },
    });
  }

  private handleLegacyPatchApproval(rawParams: unknown, rpcId: JsonRpcId): Promise<unknown> {
    const params = asRecord(rawParams);
    const callId = str(pick(params, "callId", "call_id")) ?? randomUUID();
    const mapped = mapCodexToolCallFromThreadItem(
      { type: "fileChange", id: callId, status: "inProgress", changes: pick(params, "fileChanges", "file_changes") },
      { cwd: this.deps.cwd },
    );
    const reason = str(params?.reason);
    const detail: ToolCallDetail = mapped?.detail ?? { type: "unknown", input: params, output: null };
    const filePath = detail.type === "edit" || detail.type === "write" ? detail.filePath : undefined;
    return this.requestPermission("legacy-patch", rpcId, {
      name: "apply_patch",
      title: filePath ? `修改文件：${filePath}` : "修改文件",
      ...(reason ? { description: reason } : {}),
      input: { callId },
      detail,
    });
  }

  private handleElicitation(rawParams: unknown, rpcId: JsonRpcId): Promise<unknown> {
    const params = asRecord(rawParams);
    const serverName = str(pick(params, "serverName", "server_name")) ?? "mcp";
    const message = str(params?.message) ?? "";
    const url = str(params?.url);
    return this.requestPermission("elicitation", rpcId, {
      name: `mcp:${serverName}`,
      title: `MCP 服务 ${serverName} 请求确认`,
      ...(message ? { description: message } : {}),
      input: { serverName, ...(url ? { url } : {}) },
      detail: { type: "plain_text", label: serverName, text: url ? `${message}\n${url}` : message },
    });
  }

  // -------------------------------------------------------------------------

  private emitTimeline(
    turn: ActiveTurn,
    item: Extract<AgentStreamEvent, { type: "timeline" }>["item"],
  ): void {
    this.emit({ type: "timeline", turnId: turn.turnId, item });
  }

  private emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.deps.logger.warn("[codex] 事件监听器抛出异常：%s", errorMessage(error));
      }
    }
  }
}

/** codexErrorInfo 可能是字符串枚举或 `{ variant: {...} }` 对象 */
function codexErrorCode(info: unknown): string | undefined {
  if (typeof info === "string" && info.length > 0) {
    return info;
  }
  const record = asRecord(info);
  if (record) {
    const key = Object.keys(record)[0];
    return key && key.length > 0 ? key : undefined;
  }
  return undefined;
}
