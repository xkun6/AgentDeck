import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import {
  AGENT_RPC_ERROR_CODES,
  AGENT_RPC_METHODS,
  AGENT_RPC_NOTIFICATIONS,
  type AgentRpcErrorObject,
  type AgentRpcId,
  type AgentRpcMethodName,
  type AgentRpcNotificationName,
  type AgentRpcNotifications,
  type AgentRpcResult,
  type ProviderInfo,
  type ProviderProfile,
  type ProviderTestResult,
} from "@agentdeck/protocol";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";

import type { AgentManager } from "../agent/agent-manager.js";
import { AgentRpcError } from "../agent/errors.js";
import { createSilentLogger, type Logger } from "../logger.js";
import {
  createProviderProfilesSchema,
  providerProfileSchema,
  toProviderProfile,
} from "../providers/custom/schema.js";
import { testProviderProfile } from "../providers/custom/test-connection.js";
import type { ProviderRegistry } from "../providers/registry.js";

export const RPC_PATH = "/rpc";

/** provider.config.* / provider.test 的实现（providers/custom 的 CustomProviderService） */
export interface ProviderConfigHandler {
  /** 与内置 provider 冲突的 profile id */
  reservedIds(): ReadonlySet<string>;
  getConfig(): { providers: ProviderProfile[]; path: string | null };
  /** 入参已通过整表校验 */
  setConfig(profiles: ProviderProfile[]): Promise<ProviderInfo[]>;
  test(profile: ProviderProfile): Promise<ProviderTestResult>;
}

export interface RpcServerOptions {
  token: string;
  version: string;
  manager: AgentManager;
  registry: Pick<ProviderRegistry, "get" | "listProviderInfo">;
  /** 不传时 provider.config.get 返回空表、set 返回 NOT_SUPPORTED，provider.test 仍可用 */
  providerConfig?: ProviderConfigHandler;
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// 参数校验（zod）
// ---------------------------------------------------------------------------

const emptyParams = z.object({}).optional();
const agentIdParams = z.object({ agentId: z.string().min(1) });

const promptSchema = z.union([
  z.string(),
  z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
    ]),
  ),
]);

const permissionResponseSchema = z.discriminatedUnion("behavior", [
  z.object({
    behavior: z.literal("allow"),
    selectedActionId: z.string().optional(),
    updatedInput: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    behavior: z.literal("deny"),
    selectedActionId: z.string().optional(),
    message: z.string().optional(),
    interrupt: z.boolean().optional(),
  }),
]);

interface RegisteredMethod {
  schema: z.ZodType;
  handle: (params: unknown) => Promise<unknown>;
}

function defineMethod<M extends AgentRpcMethodName, S extends z.ZodType>(
  name: M,
  schema: S,
  handle: (params: z.output<S>) => Promise<AgentRpcResult<M>> | AgentRpcResult<M>,
): [string, RegisteredMethod] {
  return [
    name,
    {
      schema,
      handle: async (params) => handle(params as z.output<S>),
    },
  ];
}

// ---------------------------------------------------------------------------
// JSON-RPC 帮助函数
// ---------------------------------------------------------------------------

class RpcProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidId(value: unknown): value is AgentRpcId | null {
  return value === null || typeof value === "string" || typeof value === "number";
}

function toErrorObject(error: unknown): AgentRpcErrorObject {
  if (error instanceof RpcProtocolError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.data ? { data: error.data } : {}),
    };
  }
  if (error instanceof AgentRpcError) {
    return {
      code: AGENT_RPC_ERROR_CODES.BUSINESS_ERROR,
      message: error.message,
      data: { ...error.data, code: error.code },
    };
  }
  return {
    code: AGENT_RPC_ERROR_CODES.BUSINESS_ERROR,
    message: error instanceof Error ? error.message : String(error),
    data: { code: "INTERNAL_ERROR" },
  };
}

function tokenDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

/**
 * HTTP + WebSocket JSON-RPC 2.0 服务（design.md 第 4 节）。
 * - `GET /health`：无需 token
 * - `ws://127.0.0.1:<port>/rpc?token=<token>`：token 不匹配以 HTTP 401 拒绝升级
 */
export class RpcServer {
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<WebSocket>();
  private readonly methods: Map<string, RegisteredMethod>;
  private readonly logger: Logger;
  private readonly tokenHash: Buffer;
  private readonly unsubscribeManager: () => void;

  constructor(private readonly options: RpcServerOptions) {
    this.logger = options.logger ?? createSilentLogger();
    this.tokenHash = tokenDigest(options.token);
    this.methods = new Map(this.createMethods());

    this.http = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.http.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
    this.wss.on("connection", (ws) => this.handleConnection(ws));

    this.unsubscribeManager = options.manager.subscribe({
      onStream: (envelope) => this.broadcast(AGENT_RPC_NOTIFICATIONS.agentStream, envelope),
      onState: (agent) => this.broadcast(AGENT_RPC_NOTIFICATIONS.agentState, { agent }),
      onRemoved: (agentId) => this.broadcast(AGENT_RPC_NOTIFICATIONS.agentRemoved, { agentId }),
      onSubagent: (update) => this.broadcast(AGENT_RPC_NOTIFICATIONS.agentSubagentsUpdate, update),
      onTasks: (agentId, tasks) =>
        this.broadcast(AGENT_RPC_NOTIFICATIONS.agentTasksUpdate, { agentId, tasks }),
    });
  }

  /** 监听并返回实际端口 */
  listen(port: number, host = "127.0.0.1"): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.http.once("error", onError);
      this.http.listen(port, host, () => {
        this.http.off("error", onError);
        resolve((this.http.address() as AddressInfo).port);
      });
    });
  }

  get connectionCount(): number {
    return this.clients.size;
  }

  async close(): Promise<void> {
    this.unsubscribeManager();
    for (const ws of this.clients) {
      ws.terminate();
    }
    this.clients.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => {
      this.http.close(() => resolve());
      this.http.closeAllConnections();
    });
  }

  // -------------------------------------------------------------------------

  private createMethods(): Array<[string, RegisteredMethod]> {
    const { manager, registry, version } = this.options;
    const requireClient = (provider: string) => {
      const client = registry.get(provider);
      if (!client) {
        throw new AgentRpcError("PROVIDER_NOT_FOUND", `未知的 provider：${provider}`);
      }
      return client;
    };

    return [
      defineMethod(AGENT_RPC_METHODS.sidecarInfo, emptyParams, () => ({
        version,
        pid: process.pid,
      })),
      defineMethod(AGENT_RPC_METHODS.providerList, emptyParams, () =>
        registry.listProviderInfo(),
      ),
      defineMethod(
        AGENT_RPC_METHODS.providerListModels,
        z.object({ provider: z.string().min(1), cwd: z.string().optional() }),
        async (params) => {
          // 目录里的 commands 只供 agent.commands 使用，不出现在本方法的结果里（design.md 4.14）
          const { models, modes } = await requireClient(params.provider).fetchCatalog(
            params.cwd !== undefined ? { cwd: params.cwd } : undefined,
          );
          return { models, modes };
        },
      ),
      defineMethod(
        AGENT_RPC_METHODS.agentCreate,
        z.object({
          provider: z.string().min(1),
          cwd: z.string().min(1),
          model: z.string().optional(),
          modeId: z.string().optional(),
          thinkingOptionId: z.string().min(1).nullable().optional(),
          title: z.string().optional(),
        }),
        async (params) => ({ agent: await manager.createAgent(params) }),
      ),
      defineMethod(AGENT_RPC_METHODS.agentList, emptyParams, () => ({
        agents: manager.listAgents(),
      })),
      defineMethod(
        AGENT_RPC_METHODS.agentSend,
        z.object({
          agentId: z.string().min(1),
          prompt: promptSchema,
          clientMessageId: z.string().optional(),
        }),
        (params) => manager.sendPrompt(params.agentId, params.prompt, params.clientMessageId),
      ),
      defineMethod(AGENT_RPC_METHODS.agentCancel, agentIdParams, async (params) => {
        await manager.cancel(params.agentId);
        return {};
      }),
      defineMethod(AGENT_RPC_METHODS.agentRetract, agentIdParams, (params) =>
        manager.retract(params.agentId),
      ),
      defineMethod(
        AGENT_RPC_METHODS.agentPermissionRespond,
        z.object({
          agentId: z.string().min(1),
          requestId: z.string().min(1),
          response: permissionResponseSchema,
        }),
        async (params) => {
          await manager.respondToPermission(params.agentId, params.requestId, params.response);
          return {};
        },
      ),
      defineMethod(
        AGENT_RPC_METHODS.agentSetModel,
        z.object({ agentId: z.string().min(1), modelId: z.string().nullable() }),
        async (params) => ({ agent: await manager.setModel(params.agentId, params.modelId) }),
      ),
      defineMethod(
        AGENT_RPC_METHODS.agentSetMode,
        z.object({ agentId: z.string().min(1), modeId: z.string().min(1) }),
        async (params) => ({ agent: await manager.setMode(params.agentId, params.modeId) }),
      ),
      defineMethod(
        AGENT_RPC_METHODS.agentSetThinking,
        z.object({ agentId: z.string().min(1), thinkingOptionId: z.string().min(1).nullable() }),
        (params) => manager.setThinking(params.agentId, params.thinkingOptionId),
      ),
      defineMethod(AGENT_RPC_METHODS.agentClose, agentIdParams, async (params) => {
        await manager.close(params.agentId);
        return {};
      }),
      defineMethod(
        AGENT_RPC_METHODS.agentTimeline,
        z.object({
          agentId: z.string().min(1),
          sinceSeq: z.number().int().nonnegative().optional(),
        }),
        (params) => manager.timeline(params.agentId, params.sinceSeq),
      ),
      defineMethod(AGENT_RPC_METHODS.agentDelete, agentIdParams, async (params) => {
        await manager.deleteAgent(params.agentId);
        return {};
      }),
      defineMethod(AGENT_RPC_METHODS.agentSubagentsList, agentIdParams, (params) => ({
        subagents: manager.listSubagents(params.agentId),
      })),
      defineMethod(
        AGENT_RPC_METHODS.agentSubagentsTimeline,
        z.object({
          agentId: z.string().min(1),
          subagentId: z.string().min(1),
          direction: z.enum(["tail", "before", "after"]).optional(),
          cursorSeq: z.number().int().nonnegative().optional(),
          limit: z.number().int().min(1).max(1000).optional(),
        }),
        (params) =>
          manager.subagentTimeline(params.agentId, params.subagentId, {
            ...(params.direction !== undefined ? { direction: params.direction } : {}),
            ...(params.cursorSeq !== undefined ? { cursorSeq: params.cursorSeq } : {}),
            ...(params.limit !== undefined ? { limit: params.limit } : {}),
          }),
      ),
      defineMethod(AGENT_RPC_METHODS.agentCommands, agentIdParams, async (params) => ({
        commands: await manager.listCommands(params.agentId),
      })),
      defineMethod(AGENT_RPC_METHODS.agentMcpStatus, agentIdParams, (params) =>
        manager.getMcpStatus(params.agentId),
      ),
      defineMethod(AGENT_RPC_METHODS.agentStatus, agentIdParams, (params) =>
        manager.getStatus(params.agentId),
      ),
      defineMethod(
        AGENT_RPC_METHODS.agentMcpReconnect,
        z.object({ agentId: z.string().min(1), serverName: z.string().min(1).optional() }),
        (params) => manager.reconnectMcp(params.agentId, params.serverName),
      ),
      defineMethod(AGENT_RPC_METHODS.agentTasksList, agentIdParams, (params) => ({
        tasks: manager.listBackgroundTasks(params.agentId),
      })),
      defineMethod(
        AGENT_RPC_METHODS.agentTasksStop,
        z.object({ agentId: z.string().min(1), taskId: z.string().min(1) }),
        async (params) => {
          await manager.stopBackgroundTask(params.agentId, params.taskId);
          return {};
        },
      ),
      defineMethod(
        AGENT_RPC_METHODS.agentTasksOutput,
        z.object({
          agentId: z.string().min(1),
          taskId: z.string().min(1),
          maxBytes: z.number().int().positive().optional(),
        }),
        (params) =>
          manager.readBackgroundTaskOutput(params.agentId, params.taskId, params.maxBytes),
      ),
      ...this.createProviderConfigMethods(),
    ];
  }

  /** 4.7：provider.config.get / set、provider.test */
  private createProviderConfigMethods(): Array<[string, RegisteredMethod]> {
    const handler = this.options.providerConfig;
    // 内置 provider 在进程生命周期内不变，冲突 id 在构造时确定即可
    const profilesSchema = createProviderProfilesSchema(handler?.reservedIds() ?? new Set());
    return [
      defineMethod(AGENT_RPC_METHODS.providerConfigGet, emptyParams, () =>
        handler ? handler.getConfig() : { providers: [], path: null },
      ),
      defineMethod(
        AGENT_RPC_METHODS.providerConfigSet,
        z.object({ providers: profilesSchema }),
        async (params) => {
          if (!handler) {
            throw new AgentRpcError("NOT_SUPPORTED", "未启用自定义 provider 配置");
          }
          const providers = await handler.setConfig(params.providers.map(toProviderProfile));
          this.broadcast(AGENT_RPC_NOTIFICATIONS.providerChanged, {});
          return { providers };
        },
      ),
      defineMethod(
        AGENT_RPC_METHODS.providerTest,
        z.object({ profile: providerProfileSchema }),
        (params) => {
          const profile = toProviderProfile(params.profile);
          return handler ? handler.test(profile) : testProviderProfile(profile);
        },
      ),
    ];
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      this.sendJson(res, 200, { ok: true, version: this.options.version });
      return;
    }
    this.sendJson(res, 404, { ok: false, error: "not found" });
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      "cache-control": "no-store",
    });
    res.end(payload);
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== RPC_PATH) {
      this.rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    if (!this.tokenMatches(url.searchParams.get("token"))) {
      this.logger.warn("拒绝 WS 连接：token 不匹配");
      this.rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit("connection", ws, req);
    });
  }

  private rejectUpgrade(socket: Duplex, status: number, reason: string): void {
    try {
      socket.write(
        `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    } finally {
      socket.destroy();
    }
  }

  private tokenMatches(candidate: string | null): boolean {
    if (!candidate) {
      return false;
    }
    return timingSafeEqual(tokenDigest(candidate), this.tokenHash);
  }

  private handleConnection(ws: WebSocket): void {
    this.clients.add(ws);
    this.logger.info("WS 客户端已连接（当前 %d 个）", this.clients.size);
    ws.on("message", (data, isBinary) => {
      void this.handleMessage(ws, data, isBinary);
    });
    ws.on("close", () => {
      this.clients.delete(ws);
      this.logger.info("WS 客户端已断开（当前 %d 个）", this.clients.size);
    });
    ws.on("error", (error) => {
      this.logger.warn("WS 连接错误：%s", error.message);
    });
  }

  private async handleMessage(ws: WebSocket, data: RawData, isBinary: boolean): Promise<void> {
    if (isBinary) {
      this.send(ws, {
        jsonrpc: "2.0",
        id: null,
        error: { code: AGENT_RPC_ERROR_CODES.INVALID_REQUEST, message: "只支持文本帧" },
      });
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(rawDataToString(data));
    } catch {
      this.send(ws, {
        jsonrpc: "2.0",
        id: null,
        error: { code: AGENT_RPC_ERROR_CODES.PARSE_ERROR, message: "JSON 解析失败" },
      });
      return;
    }

    if (
      !isPlainObject(message) ||
      message.jsonrpc !== "2.0" ||
      typeof message.method !== "string" ||
      ("id" in message && !isValidId(message.id))
    ) {
      const id = isPlainObject(message) && isValidId(message.id) ? message.id : null;
      this.send(ws, {
        jsonrpc: "2.0",
        id,
        error: {
          code: AGENT_RPC_ERROR_CODES.INVALID_REQUEST,
          message: Array.isArray(message) ? "不支持批量请求" : "非法的 JSON-RPC 请求",
        },
      });
      return;
    }

    const isNotification = !("id" in message);
    const id = (message.id ?? null) as AgentRpcId | null;
    try {
      const result = await this.dispatch(message.method, message.params);
      if (!isNotification) {
        this.send(ws, { jsonrpc: "2.0", id, result });
      }
    } catch (error) {
      if (!(error instanceof RpcProtocolError) && !(error instanceof AgentRpcError)) {
        this.logger.error("处理 %s 出错：%s", message.method, String(error));
      }
      if (!isNotification) {
        this.send(ws, { jsonrpc: "2.0", id, error: toErrorObject(error) });
      }
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    const registered = this.methods.get(method);
    if (!registered) {
      throw new RpcProtocolError(AGENT_RPC_ERROR_CODES.METHOD_NOT_FOUND, `方法不存在：${method}`);
    }
    const parsed = registered.schema.safeParse(params);
    if (!parsed.success) {
      throw new RpcProtocolError(AGENT_RPC_ERROR_CODES.INVALID_PARAMS, "参数错误", {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
        })),
      });
    }
    return registered.handle(parsed.data);
  }

  private broadcast<N extends AgentRpcNotificationName>(
    method: N,
    params: AgentRpcNotifications[N],
  ): void {
    if (this.clients.size === 0) {
      return;
    }
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  private send(ws: WebSocket, message: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}
