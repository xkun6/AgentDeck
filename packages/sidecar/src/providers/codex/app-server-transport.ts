// Derived from paseo packages/server/src/server/agent/providers/codex/app-server-transport.ts (Apache-2.0); modified for AgentDeck
// 改动：日志改用 sidecar Logger；去掉 thread/fork、thread/rollback 与 trace；
// server→client 请求的 id 兼容 string | number；未注册的请求方法回 JSON-RPC -32601 错误（paseo 回空结果）；
// 处理器可返回 JsonRpcHandlerError 指定错误码。
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

import type { Logger } from "../../logger.js";
import { terminateWithTreeKill } from "../../utils/tree-kill.js";

const DEFAULT_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;
const APP_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 2_000;
const APP_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;
const STDERR_BUFFER_LIMIT = 8192;

export type JsonRpcId = string | number;

interface JsonRpcErrorObject {
  message?: string;
  code?: string | number;
  data?: unknown;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class CodexAppServerRpcError extends Error {
  constructor(
    message: string,
    readonly code: string | number | undefined,
    readonly data: unknown,
  ) {
    super(message);
    this.name = "CodexAppServerRpcError";
  }
}

/** 请求处理器抛出它时，按指定 code 回 JSON-RPC 错误 */
export class JsonRpcHandlerError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = "JsonRpcHandlerError";
  }
}

export type RequestHandler = (params: unknown, requestId: JsonRpcId) => unknown;
type NotificationHandler = (method: string, params: unknown) => void;
type UnexpectedTerminationHandler = (error: Error) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "number" || typeof value === "string";
}

export class CodexAppServerClient {
  private readonly rl: readline.Interface;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private notificationHandler: NotificationHandler | null = null;
  private unexpectedTerminationHandler: UnexpectedTerminationHandler | null = null;
  private nextId = 1;
  private disposed = false;
  private stderrBuffer = "";

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly logger: Logger,
  ) {
    this.rl = readline.createInterface({ input: child.stdout });
    this.rl.on("line", (line) => {
      void this.handleLine(line).catch((error) => {
        this.logger.warn("处理 Codex app-server 输出行失败：%s", String(error));
      });
    });

    child.stderr.on("data", (chunk) => {
      this.stderrBuffer += chunk.toString();
      if (this.stderrBuffer.length > STDERR_BUFFER_LIMIT) {
        this.stderrBuffer = this.stderrBuffer.slice(-STDERR_BUFFER_LIMIT);
      }
    });

    // stdin 写入出错（子进程已退出）时由 exit 事件统一处理，这里只吞掉避免未处理异常
    child.stdin.on("error", (error) => {
      this.logger.debug("Codex app-server stdin 错误：%s", String(error));
    });

    child.on("error", (err) => {
      this.logger.error("Codex app-server 子进程错误：%s", String(err));
      this.handleUnexpectedTermination(err);
    });

    child.on("exit", (code, signal) => {
      const message =
        code === 0 && !signal
          ? "Codex app-server 已退出"
          : `Codex app-server 已退出（code=${code ?? "null"}，signal=${signal ?? "null"}）`;
      const error = new Error(`${message}\n${this.stderrBuffer}`.trim());
      this.handleUnexpectedTermination(error);
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get isClosed(): boolean {
    return this.disposed;
  }

  /** 最近的 stderr 输出（截断到 8KB） */
  get stderrTail(): string {
    return this.stderrBuffer;
  }

  setUnexpectedTerminationHandler(handler: UnexpectedTerminationHandler): void {
    this.unexpectedTerminationHandler = handler;
  }

  setNotificationHandler(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  setRequestHandler(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  request(method: string, params?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new Error("Codex app-server 连接已关闭"));
    }
    const id = this.nextId++;
    const payload = { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server 请求 ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.writeLine(payload);
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.disposed) {
      return;
    }
    this.writeLine({ method, params });
  }

  async dispose(): Promise<void> {
    const alreadyDisposed = this.disposed;
    this.disposed = true;
    this.unexpectedTerminationHandler = null;
    if (!alreadyDisposed) {
      this.rl.close();
      this.rejectPending(new Error("Codex app-server 连接已关闭"));
    }
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    const result = await terminateWithTreeKill(this.child, {
      gracefulTimeoutMs: APP_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      forceTimeoutMs: APP_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS,
      onForceSignal: () => {
        this.logger.warn(
          "Codex app-server 在 %dms 内未退出，强制结束进程树",
          APP_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
        );
      },
    });
    if (result === "kill-timeout") {
      throw new Error("强制结束后仍未收到 Codex app-server 退出事件");
    }
  }

  private writeLine(payload: unknown): void {
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      return;
    }
    try {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      this.logger.debug("写入 Codex app-server stdin 失败：%s", String(error));
    }
  }

  private handleUnexpectedTermination(error: Error): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.rl.close();
    this.rejectPending(error);
    const handler = this.unexpectedTerminationHandler;
    this.unexpectedTerminationHandler = null;
    if (!handler) {
      return;
    }
    try {
      handler(error);
    } catch (handlerError) {
      this.logger.warn("Codex app-server 退出处理器抛出异常：%s", String(handlerError));
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private writeResponse(id: JsonRpcId, body: { result: unknown } | { error: JsonRpcErrorObject }): void {
    if (this.disposed) {
      return;
    }
    this.writeLine({ id, ...body });
  }

  private async handleLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.logger.warn("忽略 Codex app-server 的非 JSON 输出：%s", line.slice(0, 200));
      return;
    }

    if (!isRecord(raw)) {
      this.logger.warn("Codex app-server 输出不是 JSON 对象：%s", line.slice(0, 200));
      return;
    }

    const hasId = isJsonRpcId(raw.id);
    const method = typeof raw.method === "string" ? raw.method : null;

    // 响应：带 id、无 method
    if (hasId && method === null) {
      const id = raw.id as JsonRpcId;
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (isRecord(raw.error)) {
        const err = raw.error as JsonRpcErrorObject;
        pending.reject(
          new CodexAppServerRpcError(err.message ?? "未知错误", err.code, err.data),
        );
      } else {
        pending.resolve(raw.result);
      }
      return;
    }

    // server → client 请求：带 id 与 method
    if (hasId && method !== null) {
      const id = raw.id as JsonRpcId;
      const handler = this.requestHandlers.get(method);
      if (!handler) {
        this.logger.warn("未支持的 Codex app-server 请求：%s", method);
        this.writeResponse(id, {
          error: { code: -32601, message: `AgentDeck 不支持该请求：${method}` },
        });
        return;
      }
      try {
        const result = await handler(raw.params, id);
        this.writeResponse(id, { result: result ?? {} });
      } catch (error) {
        this.writeResponse(id, {
          error: {
            code: error instanceof JsonRpcHandlerError ? error.code : -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
      return;
    }

    // 通知
    if (method !== null) {
      this.notificationHandler?.(method, raw.params);
    }
  }
}
