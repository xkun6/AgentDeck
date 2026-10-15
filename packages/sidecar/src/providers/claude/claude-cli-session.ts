// 直接驱动用户本机 claude 可执行文件的 stream-json 会话（AgentDeck 原创实现）。
// 一个实例对应一个长生命周期 claude 子进程：
// - stdin 每行写一个 JSON（用户消息 / 控制请求 / 对 CLI 控制请求的应答）；stdout 逐行解析；
// - 我们发出的控制请求（initialize / interrupt / set_model / set_permission_mode / mcp_status / mcp_reconnect / stop_task）
//   按 request_id 关联应答，带超时；
// - CLI 发来的 can_use_tool 交给 canUseTool 回调、elicitation（MCP 表单 / url）交给 onElicitation 回调，应答回写 stdin；
//   control_cancel_request 触发对应 AbortSignal；
// - close 时结束 stdin 并 tree-kill 整棵进程树；进程意外退出时消息迭代以错误结束，绝不抛到 sidecar 进程级。
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

import type { Logger } from "../../logger.js";
import { spawnProcess } from "../../utils/spawn.js";
import { terminateWithTreeKill, type ProcessTerminator } from "../../utils/tree-kill.js";
import { isJavaScriptEntry } from "./claude-executable.js";
import { claudeThinkingArgs } from "./thinking-options.js";
import type {
  ClaudeCanUseTool,
  ClaudeCanUseToolRequest,
  ClaudeControlResponseOut,
  ClaudeElicitationRequest,
  ClaudeInitializeResponse,
  ClaudeContextUsageResponse,
  ClaudeMcpStatusResponse,
  ClaudeOnElicitation,
  ClaudeOutgoingControl,
  ClaudeOutputMessage,
  ClaudePermissionMode,
  ClaudeUserInput,
} from "./stream-json-types.js";

const DEFAULT_CONTROL_TIMEOUT_MS = 30_000;
/** 重连 MCP 服务器可能要重新拉起服务进程，放宽到 60 秒 */
const MCP_RECONNECT_TIMEOUT_MS = 60_000;
const KILL_GRACEFUL_TIMEOUT_MS = 1_500;
const KILL_FORCE_TIMEOUT_MS = 1_500;
/** 进程 exit 后等 stdout / stderr 读完的上限（孙进程可能继承管道导致 close 迟迟不来） */
const STDOUT_DRAIN_TIMEOUT_MS = 500;
const STDERR_TAIL_LIMIT = 4_096;

const OUTPUT_MESSAGE_TYPES = new Set(["system", "stream_event", "assistant", "user", "result", "rate_limit_event"]);

export interface ClaudeCliOptions {
  /** 真实可执行文件（.exe / 原生二进制）；.js/.cjs/.mjs 入口用当前 node 执行 */
  executablePath: string;
  cwd: string;
  /** 已清洗的子进程环境 */
  env: Record<string, string>;
  /** 追加到参数末尾（自定义中转 provider 的 --settings / --disallowedTools） */
  extraArgs?: readonly string[];
  /** null 表示不传 --model，沿用 CLI 默认 / 用户配置 */
  model: string | null;
  /** null 表示不传 --permission-mode，沿用用户设置的默认模式 */
  permissionMode: ClaudePermissionMode | null;
  /** 思考强度（design.md 4.10）：off → --thinking disabled，其它 → --effort；null / 缺省不传 */
  thinkingOptionId?: string | null;
  resumeSessionId: string | null;
  /** 配合 resumeSessionId：以 --fork-session 派生新会话（design.md 4.23），不改动原会话 */
  forkSession?: boolean;
  /** 配合 forkSession：只保留到该 assistant 消息 uuid（隐藏参数 --resume-session-at，2.1.296 实测可用） */
  resumeSessionAt?: string;
  canUseTool: ClaudeCanUseTool;
  /** MCP elicitation（表单 / url）；缺省时一律应答 cancel（与以前回 error 的效果相同：CLI 视为取消） */
  onElicitation?: ClaudeOnElicitation;
  logger: Logger;
  onStderr?: (text: string) => void;
  terminateProcess?: ProcessTerminator;
  controlTimeoutMs?: number;
}

/** provider 依赖的会话句柄（测试可注入假实现） */
export interface ClaudeCliHandle extends AsyncIterable<ClaudeOutputMessage> {
  /** 启动时自动发送的 initialize 请求的应答 */
  readonly initialized: Promise<ClaudeInitializeResponse>;
  sendUserMessage(message: ClaudeUserInput): void;
  interrupt(): Promise<void>;
  setModel(model: string | null): Promise<void>;
  /** 一般为 ClaudePermissionMode；切回基础模式时也可能是用户设置里的其它 CLI 模式 */
  setPermissionMode(mode: string): Promise<void>;
  /** MCP 服务器状态（design.md 4.14） */
  mcpStatus(): Promise<ClaudeMcpStatusResponse>;
  /** 重连单个 MCP 服务器；失败时 reject */
  mcpReconnect(serverName: string): Promise<void>;
  /** 停止单个后台任务（design.md 4.15）；任务的终态由随后的 task_updated / task_notification 带回 */
  stopTask(taskId: string): Promise<void>;
  /** 当前上下文用量与上限（design.md 4.13）；失败时 reject */
  getContextUsage(): Promise<ClaudeContextUsageResponse>;
  close(): Promise<void>;
}

export type ClaudeCliFactory = (options: ClaudeCliOptions) => ClaudeCliHandle;

export function buildClaudeCliArgs(
  options: Pick<
    ClaudeCliOptions,
    | "model"
    | "permissionMode"
    | "resumeSessionId"
    | "forkSession"
    | "resumeSessionAt"
    | "extraArgs"
    | "thinkingOptionId"
  >,
): string[] {
  const args = [
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--include-partial-messages",
    // 工具权限请求以 control_request(can_use_tool) 发到 stdout，由我们应答
    "--permission-prompt-tool",
    "stdio",
    "--setting-sources",
    "user,project,local",
    // null 时不传：沿用用户设置的默认权限模式
    ...(options.permissionMode ? ["--permission-mode", options.permissionMode] : []),
    // 只是允许会话中途切到 bypassPermissions，不改变当前模式
    "--allow-dangerously-skip-permissions",
  ];
  if (options.model) {
    args.push("--model", options.model);
  }
  args.push(...claudeThinkingArgs(options.thinkingOptionId ?? null));
  if (options.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
    if (options.forkSession) {
      args.push("--fork-session");
      if (options.resumeSessionAt) {
        args.push("--resume-session-at", options.resumeSessionAt);
      }
    }
  }
  if (options.extraArgs) {
    args.push(...options.extraArgs);
  }
  return args;
}

interface PendingControl {
  subtype: string;
  resolve: (response: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class ClaudeCliSession implements ClaudeCliHandle {
  readonly initialized: Promise<ClaudeInitializeResponse>;

  private readonly logger: Logger;
  private readonly canUseTool: ClaudeCanUseTool;
  private readonly onElicitation: ClaudeOnElicitation | undefined;
  private readonly onStderr: ((text: string) => void) | undefined;
  private readonly terminateProcess: ProcessTerminator;
  private readonly controlTimeoutMs: number;
  private readonly child: ChildProcess;

  private readonly queue: ClaudeOutputMessage[] = [];
  private waiter: {
    resolve: (result: IteratorResult<ClaudeOutputMessage, void>) => void;
    reject: (error: Error) => void;
  } | null = null;
  private ended = false;
  private failure: Error | null = null;
  private closePromise: Promise<void> | null = null;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private openStreams = 2; // stdout + stderr
  private drainTimer: NodeJS.Timeout | null = null;
  private stderrTail = "";

  private readonly pendingControls = new Map<string, PendingControl>();
  private readonly permissionAborts = new Map<string, AbortController>();

  constructor(options: ClaudeCliOptions) {
    this.logger = options.logger;
    this.canUseTool = options.canUseTool;
    this.onElicitation = options.onElicitation;
    this.onStderr = options.onStderr;
    this.terminateProcess = options.terminateProcess ?? terminateWithTreeKill;
    this.controlTimeoutMs = options.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;

    const args = buildClaudeCliArgs(options);
    const js = isJavaScriptEntry(options.executablePath);
    // shell:false 直接执行真实可执行文件，参数绝不经过 cmd.exe
    this.child = spawnProcess(
      js ? process.execPath : options.executablePath,
      js ? [options.executablePath, ...args] : args,
      {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      },
    );
    const { stdin, stdout, stderr } = this.child;
    if (!stdin || !stdout || !stderr) {
      throw new Error("Claude Code 进程缺少 stdio 管道");
    }

    this.child.on("error", (error) => {
      this.finish(new Error(`无法运行 Claude Code：${error.message}`));
    });
    this.child.once("exit", (code, signal) => {
      this.exitInfo = { code, signal };
      if (this.openStreams === 0) {
        this.finishFromExit();
      } else {
        this.drainTimer = setTimeout(() => this.finishFromExit(), STDOUT_DRAIN_TIMEOUT_MS);
      }
    });
    stdin.on("error", (error) => {
      this.logger.debug("写入 Claude Code stdin 出错：%s", error.message);
    });
    stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_LIMIT);
      this.onStderr?.(text);
    });
    stderr.on("close", () => this.onStreamClosed());
    const lines = readline.createInterface({ input: stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));
    lines.on("close", () => this.onStreamClosed());

    // forwardSubagentText：CLI 才会转发子代理（sidechain）的完整 assistant 消息（design.md 4.11）；
    // perTaskStopAffordance：用户中止本轮时 CLI 不再连带杀掉后台任务，交给逐个停止（design.md 4.15）
    this.initialized = this.request({
      subtype: "initialize",
      forwardSubagentText: true,
      perTaskStopAffordance: true,
    }) as Promise<ClaudeInitializeResponse>;
    // 调用方可以不关心 initialize 结果；失败只在等待它的地方体现
    this.initialized.catch(() => undefined);
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  sendUserMessage(message: ClaudeUserInput): void {
    this.write(message);
  }

  async interrupt(): Promise<void> {
    await this.request({ subtype: "interrupt" });
  }

  async setModel(model: string | null): Promise<void> {
    await this.request(model ? { subtype: "set_model", model } : { subtype: "set_model" });
  }

  async setPermissionMode(mode: string): Promise<void> {
    await this.request({ subtype: "set_permission_mode", mode });
  }

  async mcpStatus(): Promise<ClaudeMcpStatusResponse> {
    return (await this.request({ subtype: "mcp_status" })) as ClaudeMcpStatusResponse;
  }

  async mcpReconnect(serverName: string): Promise<void> {
    await this.request({ subtype: "mcp_reconnect", serverName }, MCP_RECONNECT_TIMEOUT_MS);
  }

  async stopTask(taskId: string): Promise<void> {
    await this.request({ subtype: "stop_task", task_id: taskId });
  }

  async getContextUsage(): Promise<ClaudeContextUsageResponse> {
    return (await this.request({ subtype: "get_context_usage" })) as ClaudeContextUsageResponse;
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = this.doClose();
    }
    return this.closePromise;
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeOutputMessage, void> {
    return {
      next: () => {
        const message = this.queue.shift();
        if (message) {
          return Promise.resolve({ value: message, done: false });
        }
        if (this.ended) {
          if (this.failure) {
            const failure = this.failure;
            this.failure = null;
            return Promise.reject(failure);
          }
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve, reject) => {
          this.waiter = { resolve, reject };
        });
      },
    };
  }

  // -------------------------------------------------------------------------

  private async doClose(): Promise<void> {
    try {
      this.child.stdin?.end();
    } catch {
      // stdin 已关闭
    }
    // 先标记结束，避免把我们主动结束进程当成异常退出
    this.finish(null);
    await this.terminateProcess(this.child, {
      gracefulTimeoutMs: KILL_GRACEFUL_TIMEOUT_MS,
      forceTimeoutMs: KILL_FORCE_TIMEOUT_MS,
    }).catch((error: unknown) => {
      this.logger.warn("结束 Claude Code 进程树失败：%s", errorMessage(error));
    });
  }

  private write(payload: unknown): void {
    const stdin = this.child.stdin;
    if (this.ended || !stdin || stdin.destroyed || !stdin.writable) {
      throw new Error("Claude Code 进程已退出");
    }
    stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private request(
    body: ClaudeOutgoingControl,
    timeoutMs = this.controlTimeoutMs,
  ): Promise<Record<string, unknown>> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControls.delete(requestId);
        reject(new Error(`Claude Code 控制请求超时：${body.subtype}`));
      }, timeoutMs);
      this.pendingControls.set(requestId, { subtype: body.subtype, resolve, reject, timer });
      try {
        this.write({ type: "control_request", request_id: requestId, request: body });
      } catch (error) {
        clearTimeout(timer);
        this.pendingControls.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleLine(line: string): void {
    const text = line.trim();
    if (!text) {
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      this.logger.warn("无法解析 Claude Code 输出行：%s", text.slice(0, 200));
      return;
    }
    if (!isRecord(message) || typeof message.type !== "string") {
      return;
    }
    switch (message.type) {
      case "control_response":
        this.handleControlResponse(message.response);
        return;
      case "control_request":
        void this.handleControlRequest(message.request_id, message.request);
        return;
      case "control_cancel_request":
        if (typeof message.request_id === "string") {
          this.permissionAborts.get(message.request_id)?.abort();
        }
        return;
      default:
        if (OUTPUT_MESSAGE_TYPES.has(message.type)) {
          this.push(message as unknown as ClaudeOutputMessage);
        }
        return;
    }
  }

  private handleControlResponse(response: unknown): void {
    if (!isRecord(response) || typeof response.request_id !== "string") {
      return;
    }
    const pending = this.pendingControls.get(response.request_id);
    if (!pending) {
      return;
    }
    this.pendingControls.delete(response.request_id);
    clearTimeout(pending.timer);
    if (response.subtype === "success") {
      pending.resolve(isRecord(response.response) ? response.response : {});
      return;
    }
    const error = typeof response.error === "string" && response.error ? response.error : "未知错误";
    pending.reject(new Error(`Claude Code 控制请求失败（${pending.subtype}）：${error}`));
  }

  private async handleControlRequest(requestId: unknown, request: unknown): Promise<void> {
    if (typeof requestId !== "string") {
      return;
    }
    if (isRecord(request) && request.subtype === "elicitation") {
      await this.handleElicitationRequest(requestId, request as unknown as ClaudeElicitationRequest);
      return;
    }
    if (!isRecord(request) || request.subtype !== "can_use_tool") {
      const subtype = isRecord(request) ? String(request.subtype) : "unknown";
      this.respond({
        type: "control_response",
        response: { subtype: "error", request_id: requestId, error: `不支持的控制请求：${subtype}` },
      });
      return;
    }
    const permission = request as unknown as ClaudeCanUseToolRequest;
    const controller = new AbortController();
    this.permissionAborts.set(requestId, controller);
    try {
      const result = await this.canUseTool(
        permission.tool_name,
        isRecord(permission.input) ? permission.input : {},
        {
          signal: controller.signal,
          ...optionalString("toolUseId", permission.tool_use_id),
          ...optionalString("title", permission.title),
          ...optionalString("displayName", permission.display_name),
          ...optionalString("description", permission.description),
          ...optionalString("decisionReason", permission.decision_reason),
          ...optionalString("blockedPath", permission.blocked_path),
          ...(permission.permission_suggestions !== undefined
            ? { suggestions: permission.permission_suggestions }
            : {}),
          ...(permission.suppress_always_allow_rule === true ? { suppressAlwaysAllowRule: true } : {}),
          ...(permission.default_to_no === true ? { defaultToNo: true } : {}),
        },
      );
      this.respond({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: requestId,
          response: {
            ...result,
            ...(permission.tool_use_id ? { toolUseID: permission.tool_use_id } : {}),
          },
        },
      });
    } catch (error) {
      this.respond({
        type: "control_response",
        response: { subtype: "error", request_id: requestId, error: errorMessage(error) },
      });
    } finally {
      this.permissionAborts.delete(requestId);
    }
  }

  /** MCP elicitation：交给 onElicitation，应答 {action, content?}（不拼 toolUseID）；异常 / 无回调按 cancel */
  private async handleElicitationRequest(requestId: string, request: ClaudeElicitationRequest): Promise<void> {
    const controller = new AbortController();
    this.permissionAborts.set(requestId, controller);
    try {
      const result = this.onElicitation
        ? await this.onElicitation({
            signal: controller.signal,
            mode: request.mode === "url" ? "url" : "form",
            mcpServerName: typeof request.mcp_server_name === "string" ? request.mcp_server_name : "",
            message: typeof request.message === "string" ? request.message : "",
            ...optionalString("url", request.url),
            ...optionalString("elicitationId", request.elicitation_id),
            ...optionalString("title", request.title),
            ...optionalString("displayName", request.display_name),
            ...optionalString("description", request.description),
            ...(isRecord(request.requested_schema) ? { requestedSchema: request.requested_schema } : {}),
            ...(Array.isArray(request.property_order)
              ? { propertyOrder: request.property_order.filter((key): key is string => typeof key === "string") }
              : {}),
          })
        : { action: "cancel" as const };
      this.respond({
        type: "control_response",
        response: { subtype: "success", request_id: requestId, response: { ...result } },
      });
    } catch (error) {
      this.logger.debug("处理 MCP elicitation 失败，按取消应答：%s", errorMessage(error));
      this.respond({
        type: "control_response",
        response: { subtype: "success", request_id: requestId, response: { action: "cancel" } },
      });
    } finally {
      this.permissionAborts.delete(requestId);
    }
  }

  private respond(payload: ClaudeControlResponseOut): void {
    if (this.ended) {
      return;
    }
    try {
      this.write(payload);
    } catch (error) {
      this.logger.debug("回写 Claude Code 控制应答失败：%s", errorMessage(error));
    }
  }

  private push(message: ClaudeOutputMessage): void {
    if (this.ended) {
      return;
    }
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter.resolve({ value: message, done: false });
      return;
    }
    this.queue.push(message);
  }

  private onStreamClosed(): void {
    this.openStreams -= 1;
    if (this.openStreams === 0 && this.exitInfo) {
      this.finishFromExit();
    }
  }

  private finishFromExit(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    const info = this.exitInfo;
    if (!info || (info.code === 0 && !info.signal)) {
      this.finish(null);
      return;
    }
    const detail = lastLine(this.stderrTail);
    this.finish(
      new Error(
        `Claude Code 进程退出（code=${info.code ?? "null"}, signal=${info.signal ?? "null"}）` +
          (detail ? `：${detail}` : ""),
      ),
    );
  }

  /** 结束消息流：挂起的控制请求全部失败、挂起的权限请求全部 abort */
  private finish(error: Error | null): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    const reason = error ?? new Error("Claude Code 进程已退出");
    for (const [requestId, pending] of this.pendingControls) {
      this.pendingControls.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    for (const controller of this.permissionAborts.values()) {
      controller.abort();
    }
    this.permissionAborts.clear();

    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) {
      // 队列里还有消息时 waiter 不会存在，可以直接结束
      if (error) {
        waiter.reject(error);
      } else {
        waiter.resolve({ value: undefined, done: true });
      }
      return;
    }
    this.failure = error;
  }
}

export const createClaudeCliSession: ClaudeCliFactory = (options) => new ClaudeCliSession(options);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString<K extends string>(key: K, value: unknown): { [P in K]?: string } {
  return (typeof value === "string" && value ? { [key]: value } : {}) as { [P in K]?: string };
}

function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1)?.slice(0, 500) ?? "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
