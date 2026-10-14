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
  type RemoteStatus,
} from "@agentdeck/protocol";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";

import type { AgentManager } from "../agent/agent-manager.js";
import { AgentInvalidParamsError, AgentRpcError } from "../agent/errors.js";
import { createSilentLogger, type Logger } from "../logger.js";
import {
  createProviderProfilesSchema,
  providerProfileSchema,
  toProviderProfile,
} from "../providers/custom/schema.js";
import { testProviderProfile } from "../providers/custom/test-connection.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { PresenceTracker } from "../remote/presence.js";
import { SettingsStore, settingsPatchSchema } from "../settings/sidecar-settings.js";
import type { SnapshotService } from "../snapshots/snapshot-service.js";
import type { BoardService } from "../kanban/board-service.js";
import type { GroupService } from "../groups/group-service.js";
import { groupCreateSchema } from "../groups/schema.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import { scheduleDraftSchema } from "../scheduler/schema.js";
import { UsageLedger } from "../usage/ledger.js";
import { summarizeUsage } from "../usage/summary.js";
import type { RpcClientConnection } from "./client-connection.js";
import { MCP_PATH } from "./interop-service.js";
import type { McpInteropEndpoint } from "./mcp-interop.js";

export const RPC_PATH = "/rpc";

/**
 * 远程客户端（手机）不可调用的方法，一律按「方法不存在」处理（design.md 4.31）：
 * `remote.*`、`settings.set`，以及会把自定义 provider 明文密钥交出去的 `provider.config.get` / `provider.config.set`
 */
function isRemoteForbiddenMethod(method: string): boolean {
  return (
    method.startsWith("remote.") ||
    method === "settings.set" ||
    method === "provider.config.get" ||
    method === "provider.config.set"
  );
}

/** `remote.*` RPC 的实现（remote/service.ts 的 RemoteService） */
export interface RemoteController {
  status(): RemoteStatus;
  /** 网关未监听 / 没有可用地址时抛 NOT_SUPPORTED */
  createPairing(): { offerUrl: string; expiresAt: number };
  /** 吊销并断开该设备的全部连接；设备不存在抛 AgentInvalidParamsError */
  revokeDevice(deviceId: string): Promise<void>;
  /** 状态变化（启停、配对、吊销、连接、断开）；返回取消订阅函数 */
  subscribe(listener: (status: RemoteStatus) => void): () => void;
  /** 等待排队中的网关启停完成：settings.set 返回前等待，使紧随其后的 remote.status 准确 */
  settled?(): Promise<void>;
}

/** `attachConnection` 的返回值：连接侧据此交付收到的 JSON 文本、在断开时解除注册 */
export interface RpcConnectionHandle {
  receive(text: string): Promise<void>;
  detach(): void;
}

/** 方法处理器的调用上下文：发起调用的连接（client.presence 需要） */
interface RpcCallContext {
  connection: RpcClientConnection;
}

/** 没有 RemoteController 时 remote.status 的默认返回 */
const REMOTE_DISABLED_STATUS: RemoteStatus = {
  enabled: false,
  port: 47_631,
  listening: false,
  addresses: [],
  devices: [],
};

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
  /** 用量账本（design.md 4.20）；不传时 usage.summary 返回空统计 */
  usage?: UsageLedger;
  /** sidecar 设置（design.md 4.24）；不传时用内存默认值 */
  settings?: SettingsStore;
  /** 按回合文件快照（design.md 4.24）；不传时 snapshot.* 返回 NOT_SUPPORTED（list / storage 返回空） */
  snapshots?: SnapshotService;
  /** 调度器（design.md 4.25）；不传时 schedule.* 返回 NOT_SUPPORTED */
  scheduler?: Scheduler;
  /** 看板式任务分派（design.md 4.28）；不传时 board.* 返回 NOT_SUPPORTED */
  board?: BoardService;
  /** 并行协作组（design.md 4.27）；不传时 group.* 返回 NOT_SUPPORTED */
  groups?: GroupService;
  /** 会话互通 MCP 端点（design.md 4.26）；不传时 /mcp 返回 404 */
  mcp?: McpInteropEndpoint;
  /** 远程网关（design.md 4.31）；不传时 remote.status 返回关闭状态，pairing / revoke 返回 NOT_SUPPORTED */
  remote?: RemoteController;
  /** 客户端在线状态（client.presence）；与 AttentionService 共用同一个实例 */
  presence?: PresenceTracker;
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// 参数校验（zod）
// ---------------------------------------------------------------------------

const AGENT_TITLE_MAX_LENGTH = 200;
const SEARCH_QUERY_MAX_LENGTH = 200;
const SEARCH_LIMIT_DEFAULT = 100;
const SEARCH_LIMIT_MAX = 500;

const emptyParams = z.object({}).optional();
const agentIdParams = z.object({ agentId: z.string().min(1) });

const projectPathSchema = z.string().trim().min(1);
const projectParams = z.object({ projectPath: projectPathSchema });
const boardStatusSchema = z.enum(["todo", "running", "review", "done", "blocked"]);
const boardAssigneeSchema = z.object({
  provider: z.string().min(1),
  model: z.string().nullable().optional(),
  modeId: z.string().nullable().optional(),
});
const boardSettingsPatchSchema = z.object({
  worktreePerTask: z.boolean().optional(),
  autoDispatch: z.boolean().optional(),
  maxConcurrent: z.number().int().min(1).max(16).optional(),
  defaultAssignee: boardAssigneeSchema.optional(),
});
const boardTaskDraftSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).optional(),
  assignee: boardAssigneeSchema.nullable().optional(),
  dependsOn: z.array(z.string().min(1)).max(100).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
});

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
  handle: (params: unknown, context: RpcCallContext) => Promise<unknown>;
}

function defineMethod<M extends AgentRpcMethodName, S extends z.ZodType>(
  name: M,
  schema: S,
  handle: (params: z.output<S>, context: RpcCallContext) => Promise<AgentRpcResult<M>> | AgentRpcResult<M>,
): [string, RegisteredMethod] {
  return [
    name,
    {
      schema,
      handle: async (params, context) => handle(params as z.output<S>, context),
    },
  ];
}

/** 本机 `/rpc` 的 WebSocket 连接（文本帧） */
class LocalWsConnection implements RpcClientConnection {
  readonly kind = "local" as const;

  constructor(private readonly ws: WebSocket) {}

  send(payload: string): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
    }
  }

  close(): void {
    this.ws.terminate();
  }
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
  if (error instanceof AgentInvalidParamsError) {
    return { code: AGENT_RPC_ERROR_CODES.INVALID_PARAMS, message: error.message };
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
  private readonly clients = new Set<RpcClientConnection>();
  private readonly presence: PresenceTracker;
  private readonly methods: Map<string, RegisteredMethod>;
  private readonly logger: Logger;
  private readonly tokenHash: Buffer;
  private readonly unsubscribeManager: () => void;
  private readonly unsubscribeSettings: () => void;

  constructor(private readonly options: RpcServerOptions) {
    this.logger = options.logger ?? createSilentLogger();
    this.presence = options.presence ?? new PresenceTracker();
    this.tokenHash = tokenDigest(options.token);
    this.methods = new Map(this.createMethods());

    this.http = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.http.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
    this.wss.on("connection", (ws) => this.handleConnection(ws));

    const unsubscribeManager = options.manager.subscribe({
      onStream: (envelope) => this.broadcast(AGENT_RPC_NOTIFICATIONS.agentStream, envelope),
      onState: (agent) => this.broadcast(AGENT_RPC_NOTIFICATIONS.agentState, { agent }),
      onRemoved: (agentId) => this.broadcast(AGENT_RPC_NOTIFICATIONS.agentRemoved, { agentId }),
      onSubagent: (update) => this.broadcast(AGENT_RPC_NOTIFICATIONS.agentSubagentsUpdate, update),
      onTasks: (agentId, tasks) =>
        this.broadcast(AGENT_RPC_NOTIFICATIONS.agentTasksUpdate, { agentId, tasks }),
    });
    this.unsubscribeSettings =
      options.settings?.subscribe((settings) =>
        this.broadcast(AGENT_RPC_NOTIFICATIONS.settingsChanged, { settings }),
      ) ?? (() => undefined);
    const unsubscribeScheduler = options.scheduler?.subscribe({
      onChanged: (schedules, paused) =>
        this.broadcast(AGENT_RPC_NOTIFICATIONS.scheduleChanged, { schedules, paused }),
      onNotice: (notice) => this.broadcast(AGENT_RPC_NOTIFICATIONS.scheduleNotice, notice),
    });
    const unsubscribeBoard = options.board?.subscribe({
      onChanged: (projectPath, board) =>
        this.broadcast(AGENT_RPC_NOTIFICATIONS.boardChanged, { projectPath, board }),
    });
    const unsubscribeGroups = options.groups?.subscribe({
      onChanged: (group) => this.broadcast(AGENT_RPC_NOTIFICATIONS.groupChanged, { group }),
      onRemoved: (groupId) => this.broadcast(AGENT_RPC_NOTIFICATIONS.groupRemoved, { groupId }),
    });
    // remote.changed 只发给本机客户端（手机无权管理配对）
    const unsubscribeRemote = options.remote?.subscribe((status) =>
      this.broadcast(AGENT_RPC_NOTIFICATIONS.remoteChanged, status, "local"),
    );
    this.unsubscribeManager = () => {
      unsubscribeGroups?.();
      unsubscribeManager();
      unsubscribeScheduler?.();
      unsubscribeBoard?.();
      unsubscribeRemote?.();
    };
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

  /**
   * 注册一个已认证的客户端连接（本机 WS 或远程网关的解密连接）：之后它与本机客户端一样
   * 收到全部广播；连接侧用返回的句柄交付收到的 JSON 文本，断开时调用 detach。
   */
  attachConnection(connection: RpcClientConnection): RpcConnectionHandle {
    this.clients.add(connection);
    this.logger.info("%s客户端已连接（当前 %d 个）", connection.kind === "remote" ? "远程" : "WS ", this.clients.size);
    return {
      receive: (text) => this.handleText(connection, text),
      detach: () => {
        if (this.clients.delete(connection)) {
          this.presence.forget(connection);
          this.logger.info(
            "%s客户端已断开（当前 %d 个）",
            connection.kind === "remote" ? "远程" : "WS ",
            this.clients.size,
          );
        }
      },
    };
  }

  /** 向全部已认证的远程客户端发送通知（client.attention）；返回送达的连接数 */
  sendToRemote<N extends AgentRpcNotificationName>(method: N, params: AgentRpcNotifications[N]): number {
    return this.broadcast(method, params, "remote");
  }

  async close(): Promise<void> {
    this.unsubscribeManager();
    this.unsubscribeSettings();
    for (const connection of this.clients) {
      connection.close();
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
    const usage = this.options.usage ?? new UsageLedger();
    const settings = this.options.settings ?? new SettingsStore();
    const snapshots = this.options.snapshots;
    const requireSnapshots = (): SnapshotService => {
      if (!snapshots) {
        throw new AgentRpcError("NOT_SUPPORTED", "未启用文件快照");
      }
      return snapshots;
    };
    const requireScheduler = (): Scheduler => {
      if (!this.options.scheduler) {
        throw new AgentRpcError("NOT_SUPPORTED", "未启用调度器");
      }
      return this.options.scheduler;
    };
    const requireBoard = (): BoardService => {
      if (!this.options.board) {
        throw new AgentRpcError("NOT_SUPPORTED", "未启用看板");
      }
      return this.options.board;
    };
    const requireGroups = (): GroupService => {
      if (!this.options.groups) {
        throw new AgentRpcError("NOT_SUPPORTED", "未启用并行协作");
      }
      return this.options.groups;
    };
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
      defineMethod(
        AGENT_RPC_METHODS.agentSteer,
        z.object({
          agentId: z.string().min(1),
          prompt: promptSchema,
          clientMessageId: z.string().optional(),
        }),
        async (params) => {
          await manager.steer(params.agentId, params.prompt, params.clientMessageId);
          return {};
        },
      ),
      defineMethod(AGENT_RPC_METHODS.agentCancel, agentIdParams, async (params) => {
        await manager.cancel(params.agentId);
        return {};
      }),
      defineMethod(AGENT_RPC_METHODS.agentRetract, agentIdParams, (params) =>
        manager.retract(params.agentId),
      ),
      defineMethod(
        AGENT_RPC_METHODS.agentFork,
        z.object({
          agentId: z.string().min(1),
          throughSeq: z.number().int().positive().optional(),
          title: z.string().max(AGENT_TITLE_MAX_LENGTH).optional(),
        }),
        async (params) => ({
          agent: await manager.forkAgent(params.agentId, {
            ...(params.throughSeq !== undefined ? { throughSeq: params.throughSeq } : {}),
            ...(params.title !== undefined ? { title: params.title } : {}),
          }),
        }),
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
        z
          .object({
            agentId: z.string().min(1),
            sinceSeq: z.number().int().nonnegative().optional(),
            beforeSeq: z.number().int().positive().optional(),
            limit: z.number().int().min(1).max(2000).optional(),
          })
          .refine(
            (value) => value.sinceSeq === undefined || (value.beforeSeq === undefined && value.limit === undefined),
            { message: "sinceSeq 不能与 beforeSeq / limit 同时给出" },
          )
          .refine((value) => value.beforeSeq === undefined || value.limit !== undefined, {
            message: "beforeSeq 需要同时给出 limit",
          }),
        (params) =>
          manager.timeline(
            params.agentId,
            params.sinceSeq,
            params.limit !== undefined
              ? {
                  limit: params.limit,
                  ...(params.beforeSeq !== undefined ? { beforeSeq: params.beforeSeq } : {}),
                }
              : undefined,
          ),
      ),
      defineMethod(
        AGENT_RPC_METHODS.agentUpdate,
        z
          .object({
            agentId: z.string().min(1),
            title: z
              .string()
              .refine((value) => value.trim().length <= AGENT_TITLE_MAX_LENGTH, {
                message: `title 去除首尾空白后不能超过 ${AGENT_TITLE_MAX_LENGTH} 个字符`,
              })
              .nullable()
              .optional(),
            pinned: z.boolean().optional(),
            archived: z.boolean().optional(),
            interopTarget: z.boolean().optional(),
          })
          .refine(
            (value) =>
              value.title !== undefined ||
              value.pinned !== undefined ||
              value.archived !== undefined ||
              value.interopTarget !== undefined,
            { message: "title / pinned / archived / interopTarget 至少需要提供一个" },
          ),
        async (params) => ({
          agent: await manager.updateAgent(params.agentId, {
            ...(params.title !== undefined ? { title: params.title } : {}),
            ...(params.pinned !== undefined ? { pinned: params.pinned } : {}),
            ...(params.archived !== undefined ? { archived: params.archived } : {}),
            ...(params.interopTarget !== undefined ? { interopTarget: params.interopTarget } : {}),
          }),
        }),
      ),
      defineMethod(
        AGENT_RPC_METHODS.agentSearch,
        z.object({
          query: z
            .string()
            .refine((value) => value.trim().length >= 1 && value.trim().length <= SEARCH_QUERY_MAX_LENGTH, {
              message: `query 去除首尾空白后需为 1–${SEARCH_QUERY_MAX_LENGTH} 个字符`,
            }),
          limit: z.number().int().min(1).max(SEARCH_LIMIT_MAX).optional(),
          agentIds: z.array(z.string().min(1)).optional(),
        }),
        (params) =>
          manager.search(params.query, params.limit ?? SEARCH_LIMIT_DEFAULT, params.agentIds),
      ),
      defineMethod(
        AGENT_RPC_METHODS.usageSummary,
        z
          .object({
            sinceMs: z.number().finite().optional(),
            untilMs: z.number().finite().optional(),
          })
          .optional(),
        async (params) => {
          const labels = new Map(
            (await registry.listProviderInfo()).map((info) => [info.id, info.label]),
          );
          const titles = new Map(
            manager.listAgents().map((agent) => [agent.id, agent.title ?? agent.preview ?? null]),
          );
          return summarizeUsage(
            usage.list(),
            { ...(params?.sinceMs !== undefined ? { sinceMs: params.sinceMs } : {}),
              ...(params?.untilMs !== undefined ? { untilMs: params.untilMs } : {}) },
            {
              now: Date.now(),
              backfilling: usage.backfilling,
              providerLabel: (provider) => labels.get(provider),
              agentTitle: (agentId) => titles.get(agentId),
            },
          );
        },
      ),
      defineMethod(AGENT_RPC_METHODS.settingsGet, emptyParams, () => settings.get()),
      defineMethod(
        AGENT_RPC_METHODS.settingsSet,
        z.object({ patch: settingsPatchSchema }),
        async (params) => {
          const next = await settings.set(params.patch);
          await this.options.remote?.settled?.();
          return next;
        },
      ),
      defineMethod(AGENT_RPC_METHODS.snapshotList, agentIdParams, async (params) => {
        manager.getAgent(params.agentId);
        return { turns: (await snapshots?.list(params.agentId)) ?? [] };
      }),
      defineMethod(
        AGENT_RPC_METHODS.snapshotDiff,
        z.object({
          agentId: z.string().min(1),
          turnId: z.string().min(1),
          path: z.string().min(1).optional(),
          against: z.enum(["after", "current"]).optional(),
        }),
        (params) =>
          requireSnapshots().diff(params.agentId, params.turnId, {
            ...(params.path !== undefined ? { path: params.path } : {}),
            ...(params.against !== undefined ? { against: params.against } : {}),
          }),
      ),
      defineMethod(
        AGENT_RPC_METHODS.snapshotRestore,
        z.object({
          agentId: z.string().min(1),
          turnId: z.string().min(1),
          paths: z.array(z.string().min(1)).max(10_000).optional(),
        }),
        (params) => requireSnapshots().restore(params.agentId, params.turnId, params.paths),
      ),
      defineMethod(AGENT_RPC_METHODS.snapshotStorage, emptyParams, async () => ({
        repos: (await snapshots?.storage()) ?? [],
      })),
      defineMethod(
        AGENT_RPC_METHODS.snapshotPrune,
        z.object({ cwd: z.string().min(1) }),
        async (params) => {
          await requireSnapshots().prune(params.cwd);
          return {};
        },
      ),
      defineMethod(AGENT_RPC_METHODS.scheduleList, emptyParams, () => requireScheduler().list()),
      defineMethod(
        AGENT_RPC_METHODS.scheduleUpsert,
        z.object({ schedule: scheduleDraftSchema }),
        (params) => ({ schedule: requireScheduler().upsert(params.schedule) }),
      ),
      defineMethod(AGENT_RPC_METHODS.scheduleDelete, z.object({ id: z.string().min(1) }), (params) => {
        requireScheduler().delete(params.id);
        return {};
      }),
      defineMethod(AGENT_RPC_METHODS.scheduleRunNow, z.object({ id: z.string().min(1) }), (params) => {
        const scheduler = requireScheduler();
        scheduler.get(params.id);
        // 不等待发送完成（onBusy = wait 最长 30 分钟），结果见运行记录
        void scheduler.runNow(params.id).catch((error: unknown) => {
          this.logger.warn("schedule.runNow %s 失败：%s", params.id, String(error));
        });
        return {};
      }),
      defineMethod(
        AGENT_RPC_METHODS.scheduleRuns,
        z.object({ id: z.string().min(1).optional(), limit: z.number().int().optional() }),
        async (params) => ({ runs: await requireScheduler().runs(params.id, params.limit) }),
      ),
      defineMethod(
        AGENT_RPC_METHODS.scheduleSetPaused,
        z.object({ paused: z.boolean() }),
        (params) => ({ paused: requireScheduler().setPaused(params.paused) }),
      ),
      defineMethod(AGENT_RPC_METHODS.boardGet, projectParams, async (params) => ({
        board: await requireBoard().get(params.projectPath),
      })),
      defineMethod(
        AGENT_RPC_METHODS.boardUpdateSettings,
        z.object({ projectPath: projectPathSchema, settings: boardSettingsPatchSchema }),
        async (params) => ({
          board: await requireBoard().updateSettings(params.projectPath, params.settings),
        }),
      ),
      defineMethod(
        AGENT_RPC_METHODS.boardUpsertTask,
        z.object({ projectPath: projectPathSchema, task: boardTaskDraftSchema }),
        (params) => requireBoard().upsertTask(params.projectPath, params.task),
      ),
      defineMethod(
        AGENT_RPC_METHODS.boardDeleteTask,
        z.object({
          projectPath: projectPathSchema,
          taskId: z.string().min(1),
          removeWorktree: z.boolean().optional(),
        }),
        (params) => requireBoard().deleteTask(params.projectPath, params.taskId, params.removeWorktree),
      ),
      defineMethod(
        AGENT_RPC_METHODS.boardMoveTask,
        z.object({
          projectPath: projectPathSchema,
          taskId: z.string().min(1),
          status: boardStatusSchema,
          order: z.number().finite().optional(),
        }),
        async (params) => ({
          board: await requireBoard().moveTask(params.projectPath, params.taskId, params.status, params.order),
        }),
      ),
      defineMethod(
        AGENT_RPC_METHODS.boardMerge,
        z.object({
          projectPath: projectPathSchema,
          taskId: z.string().min(1),
          removeWorktree: z.boolean(),
        }),
        (params) => requireBoard().merge(params.projectPath, params.taskId, params.removeWorktree),
      ),
      defineMethod(AGENT_RPC_METHODS.groupCreate, groupCreateSchema, async (params) => ({
        group: await requireGroups().create(params),
      })),
      defineMethod(AGENT_RPC_METHODS.groupList, emptyParams, () => ({ groups: requireGroups().list() })),
      defineMethod(AGENT_RPC_METHODS.groupGet, z.object({ id: z.string().min(1) }), (params) => ({
        group: requireGroups().get(params.id),
      })),
      defineMethod(
        AGENT_RPC_METHODS.groupDelete,
        z.object({ id: z.string().min(1), removeWorktrees: z.boolean() }),
        (params) => requireGroups().delete(params.id, params.removeWorktrees),
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
      ...this.createRemoteMethods(),
    ];
  }

  /** 4.31：remote.* 与 client.presence（remote.* 对远程客户端在 dispatch 里统一拦截为 -32601） */
  private createRemoteMethods(): Array<[string, RegisteredMethod]> {
    const remote = this.options.remote;
    const requireRemote = (): RemoteController => {
      if (!remote) {
        throw new AgentRpcError("NOT_SUPPORTED", "未启用远程网关");
      }
      return remote;
    };
    return [
      defineMethod(AGENT_RPC_METHODS.remoteStatus, emptyParams, () =>
        remote ? remote.status() : { ...REMOTE_DISABLED_STATUS },
      ),
      defineMethod(AGENT_RPC_METHODS.remotePairingCreate, emptyParams, () => requireRemote().createPairing()),
      defineMethod(
        AGENT_RPC_METHODS.remoteDevicesRevoke,
        z.object({ deviceId: z.string().min(1) }),
        async (params) => {
          await requireRemote().revokeDevice(params.deviceId);
          return {};
        },
      ),
      defineMethod(
        AGENT_RPC_METHODS.clientPresence,
        z.object({ kind: z.enum(["desktop", "mobile"]), visible: z.boolean() }),
        (params, context) => {
          this.presence.update(context.connection, params.kind, params.visible);
          return {};
        },
      ),
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
    if (this.options.mcp && url.pathname === MCP_PATH) {
      this.options.mcp.handle(req, res).catch((error: unknown) => {
        this.logger.error("MCP 端点异常：%s", error instanceof Error ? error.message : String(error));
        if (!res.headersSent) {
          this.sendJson(res, 500, { ok: false, error: "internal error" });
        }
      });
      return;
    }
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
    const connection = new LocalWsConnection(ws);
    const handle = this.attachConnection(connection);
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        this.send(connection, {
          jsonrpc: "2.0",
          id: null,
          error: { code: AGENT_RPC_ERROR_CODES.INVALID_REQUEST, message: "只支持文本帧" },
        });
        return;
      }
      void handle.receive(rawDataToString(data));
    });
    ws.on("close", () => handle.detach());
    ws.on("error", (error) => {
      this.logger.warn("WS 连接错误：%s", error.message);
    });
  }

  private async handleText(ws: RpcClientConnection, text: string): Promise<void> {
    let message: unknown;
    try {
      message = JSON.parse(text);
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
      const result = await this.dispatch(ws, message.method, message.params);
      if (!isNotification) {
        this.send(ws, { jsonrpc: "2.0", id, result });
      }
    } catch (error) {
      if (
        !(error instanceof RpcProtocolError) &&
        !(error instanceof AgentRpcError) &&
        !(error instanceof AgentInvalidParamsError)
      ) {
        this.logger.error("处理 %s 出错：%s", message.method, String(error));
      }
      if (!isNotification) {
        this.send(ws, { jsonrpc: "2.0", id, error: toErrorObject(error) });
      }
    }
  }

  private async dispatch(
    connection: RpcClientConnection,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    const registered = this.methods.get(method);
    if (!registered || (connection.kind === "remote" && isRemoteForbiddenMethod(method))) {
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
    return registered.handle(parsed.data, { connection });
  }

  /** audience 缺省 = 全部连接；返回送达的连接数 */
  private broadcast<N extends AgentRpcNotificationName>(
    method: N,
    params: AgentRpcNotifications[N],
    audience: "all" | "local" | "remote" = "all",
  ): number {
    if (this.clients.size === 0) {
      return 0;
    }
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
    let delivered = 0;
    for (const connection of this.clients) {
      if (audience === "all" || connection.kind === audience) {
        connection.send(payload);
        delivered += 1;
      }
    }
    return delivered;
  }

  private send(connection: RpcClientConnection, message: unknown): void {
    connection.send(JSON.stringify(message));
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
