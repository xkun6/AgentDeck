// Computer Use 代理（design.md 4.37）：sidecar 作为 MCP client 拉起 `cua-driver mcp`，在 `POST /mcp/cua` 上把驱动的
// 工具原样转发给 CLI；转发时做防自指检查（self-guard.ts）与审批（CLI 不审批的模式由 sidecar 发审批）。
import type { ChildProcess } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createInterface } from "node:readline";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  type CallToolResult,
  type JSONRPCMessage,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  AgentPermissionAction,
  AgentPermissionRequest,
  AgentPermissionResponse,
  ComputerUseStatus,
  SidecarSettings,
} from "@agentdeck/protocol";

import { createSilentLogger, type Logger } from "../logger.js";
import { COMPUTER_USE_POLICY_DENIED, COMPUTER_USE_SERVER_NAME } from "../providers/shared/interop.js";
import { readJsonBody, sendJson } from "../server/mcp-interop.js";
import { COMPUTER_USE_MCP_PATH } from "../server/interop-service.js";
import { spawnProcess } from "../utils/spawn.js";
import { terminateWithTreeKill } from "../utils/tree-kill.js";
import { COMPUTER_USE_SUPPORTED, probeDriver, type DriverProbe } from "./driver.js";
import {
  KEYBOARD_REFUSAL,
  WINDOWS_UNKNOWN_REFUSAL,
  desktopPoints,
  isUntargetedKeyboardCall,
  mentionsWindowId,
  parseWindows,
  refuseSelfRegionCall,
  refuseSelfTargetedCall,
  stripSelfFromText,
  stripSelfFromValue,
  type DriverWindow,
} from "./self-guard.js";

/** tools/list 与未指定超时的转发调用的超时；tools/call 用设置里的 callTimeoutSec */
const CALL_TIMEOUT_MS = 120_000;
/** 防自指用的窗口列表缓存：一次 GUI 操作里可能反复问到，几百毫秒内复用不会让判断失真 */
const WINDOWS_TTL_MS = 400;

const HOST_APPROVAL_ACTIONS: AgentPermissionAction[] = [
  { id: "allow", label: "允许一次", behavior: "allow" },
  { id: "deny", label: "拒绝", behavior: "deny" },
];

/** 驱动连接（测试可注入假实现） */
export interface DriverToolClient {
  readonly running: boolean;
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number): Promise<CallToolResult>;
  stop(): Promise<void>;
}

export interface ComputerUseApprovals {
  cliApprovesMcpTools(agentId: string): boolean;
  requestHostPermission(
    agentId: string,
    request: Omit<AgentPermissionRequest, "id" | "provider">,
    signal?: AbortSignal,
  ): Promise<AgentPermissionResponse>;
}

export interface ComputerUseProxyOptions {
  settings: () => SidecarSettings["computerUse"];
  /** 由会话 token 识别调用方 agentId（与会话互通共用，design.md 4.26） */
  agentIdForToken: (token: string) => string | null;
  approvals: ComputerUseApprovals;
  /** AGENTDECK_PARENT_PID：Tauri 主进程，AgentDeck 的窗口归它 */
  hostPid?: number;
  version: string;
  logger?: Logger;
  /** 测试注入；缺省为拉起本机 cua-driver */
  driver?: DriverToolClient;
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

export class ComputerUseProxy {
  private readonly driver: DriverToolClient;
  private readonly logger: Logger;
  private readonly selfPids: ReadonlySet<number>;
  private windowsCache: { at: number; windows: DriverWindow[] } | null = null;
  /** 最近一次 get_desktop_state 的「原图宽 / 截图宽」：截图被缩放时，桌面坐标可能是缩放后的 */
  private desktopScale = 1;

  constructor(private readonly options: ComputerUseProxyOptions) {
    this.logger = options.logger ?? createSilentLogger();
    this.driver = options.driver ?? new CuaDriverConnection(options.version, this.logger);
    this.selfPids = new Set([process.pid, ...(options.hostPid !== undefined ? [options.hostPid] : [])]);
  }

  private get enabled(): boolean {
    return COMPUTER_USE_SUPPORTED && this.options.settings().enabled;
  }

  async status(): Promise<ComputerUseStatus> {
    if (!COMPUTER_USE_SUPPORTED) {
      return { supported: false, installed: false, running: false };
    }
    const probe = await probeDriver();
    return {
      supported: true,
      installed: probe.installed,
      ...(probe.path ? { path: probe.path } : {}),
      ...(probe.version ? { version: probe.version } : {}),
      ...(probe.error ? { error: probe.error } : {}),
      running: this.driver.running,
    };
  }

  /** 设置变化：关闭时结束驱动进程 */
  onSettingsChanged(): void {
    if (!this.enabled && this.driver.running) {
      void this.driver.stop();
    }
  }

  async stop(): Promise<void> {
    await this.driver.stop();
  }

  /** 处理 HTTP 请求；路径不是 /mcp/cua 时返回 false（交给上层） */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== COMPUTER_USE_MCP_PATH) {
      return false;
    }
    if (!this.enabled) {
      sendJson(res, 404, { ok: false, error: "Computer Use 未启用" });
      return true;
    }
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
    const callerId = match ? this.options.agentIdForToken(match[1]!) : null;
    if (!callerId) {
      this.logger.warn("拒绝 Computer Use 请求：token 不匹配");
      sendJson(res, 401, { ok: false, error: "unauthorized" }, { "www-authenticate": "Bearer" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "只支持 POST" }, id: null }, { allow: "POST" });
      return true;
    }
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "请求体不是合法 JSON 或过大" }, id: null });
      return true;
    }
    const server = this.createServer(callerId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      this.logger.error("处理 Computer Use 请求出错：%s", error instanceof Error ? error.message : String(error));
      if (!res.headersSent) {
        sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "内部错误" }, id: null });
      }
    }
    return true;
  }

  private createServer(callerId: string): Server {
    const server = new Server(
      { name: COMPUTER_USE_SERVER_NAME, version: this.options.version },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await this.driver.listTools() }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      try {
        return await this.callTool(callerId, request.params.name, request.params.arguments ?? {}, extra.signal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn("Computer Use 工具 %s 出错：%s", request.params.name, message);
        return errorResult(`Computer Use 调用失败：${message}`);
      }
    });
    return server;
  }

  /** 审批策略 → 防自指 → 审批（询问且 CLI 不审批时）→ 审批后再检查一次 → 转发 → 过滤出参 */
  async callTool(
    callerId: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const { approval, callTimeoutSec } = this.options.settings();
    if (approval === "deny") {
      return errorResult(COMPUTER_USE_POLICY_DENIED);
    }
    const refusal = await this.checkSelf(name, args);
    if (refusal) {
      return errorResult(refusal);
    }
    if (approval === "ask" && !this.options.approvals.cliApprovesMcpTools(callerId)) {
      const response = await this.options.approvals.requestHostPermission(
        callerId,
        {
          name: `${COMPUTER_USE_SERVER_NAME}.${name}`,
          kind: "tool",
          title: `允许 Computer Use：${name}？`,
          description: "Agent 请求操作本机桌面。当前模式下 CLI 不会审批 Computer Use 工具，由 AgentDeck 逐次确认。",
          input: args,
          actions: HOST_APPROVAL_ACTIONS.map((action) => ({ ...action })),
        },
        signal,
      );
      if (response.behavior === "deny") {
        return errorResult(`用户拒绝了这次 Computer Use 操作${response.message ? `：${response.message}` : ""}`);
      }
      // 等待审批期间窗口可能已移动：再检查一次
      const again = await this.checkSelf(name, args);
      if (again) {
        return errorResult(again);
      }
    }
    const result = await this.driver.callTool(name, args, signal, callTimeoutSec * 1000);
    return this.filterResult(name, result);
  }

  private async checkSelf(name: string, args: Record<string, unknown>): Promise<string | null> {
    if (this.options.settings().allowSelfTargeting) {
      return null;
    }
    const points = desktopPoints(args);
    let windows: DriverWindow[] = [];
    if (points.length > 0 || mentionsWindowId(args)) {
      const listed = await this.listWindows();
      if (!listed) {
        return WINDOWS_UNKNOWN_REFUSAL;
      }
      windows = listed;
    }
    const windowIds = new Set(
      windows.filter((window) => window.pid !== null && this.selfPids.has(window.pid)).map((window) => window.window_id),
    );
    const targeted = refuseSelfTargetedCall(args, { pids: this.selfPids, windowIds });
    if (targeted) {
      return targeted;
    }
    if (isUntargetedKeyboardCall(name, args)) {
      return KEYBOARD_REFUSAL;
    }
    return points.length > 0 ? refuseSelfRegionCall(points, windows, this.selfPids, this.desktopScale) : null;
  }

  /** 驱动的完整窗口列表（不经防自指与出参过滤）；读取失败返回 null */
  private async listWindows(): Promise<DriverWindow[] | null> {
    const cached = this.windowsCache;
    if (cached && Date.now() - cached.at <= WINDOWS_TTL_MS) {
      return cached.windows;
    }
    try {
      const result = await this.driver.callTool("list_windows", {});
      const windows =
        parseWindows(result.structuredContent) ??
        result.content
          .map((block) => (block.type === "text" ? parseWindowsText(block.text) : null))
          .find((parsed) => parsed !== null) ??
        null;
      if (windows) {
        this.windowsCache = { at: Date.now(), windows };
      }
      return windows;
    } catch (error) {
      this.logger.warn("读取窗口列表失败：%s", error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  private filterResult(name: string, result: CallToolResult): CallToolResult {
    if (name === "get_desktop_state") {
      this.desktopScale = desktopScaleOf(result.structuredContent);
    }
    if (this.options.settings().allowSelfTargeting) {
      return result;
    }
    const structured =
      result.structuredContent !== undefined ? stripSelfFromValue(result.structuredContent, this.selfPids) : undefined;
    return {
      ...result,
      content: result.content.map((block) =>
        block.type === "text" ? { ...block, text: stripSelfFromText(block.text, this.selfPids) } : block,
      ),
      ...(structured !== undefined ? { structuredContent: structured as Record<string, unknown> } : {}),
    };
  }
}

function parseWindowsText(text: string): DriverWindow[] | null {
  const start = text.indexOf("{");
  if (start < 0) {
    return null;
  }
  try {
    return parseWindows(JSON.parse(text.slice(start)));
  } catch {
    return null;
  }
}

/** `screenshot_original_width / screenshot_width`；没有缩放或字段缺失时为 1 */
export function desktopScaleOf(structured: unknown): number {
  const record = structured && typeof structured === "object" ? (structured as Record<string, unknown>) : {};
  const original = record.screenshot_original_width;
  const shown = record.screenshot_width;
  return typeof original === "number" && typeof shown === "number" && shown > 0 && original > shown
    ? original / shown
    : 1;
}

// ---------------------------------------------------------------------------
// 驱动连接
// ---------------------------------------------------------------------------

/** stdio transport：经 spawnProcess 拉起（windowsHide、shell:false、剔除 AGENTDECK_* 环境变量），关闭时 tree-kill */
class DriverStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child: ChildProcess | null = null;
  private readonly buffer = new ReadBuffer();

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    const child = spawnProcess(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"], shell: false });
    this.child = child;
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    child.on("error", (error) => this.onerror?.(error));
    child.once("close", () => {
      this.child = null;
      this.onclose?.();
    });
    child.stdin?.on("error", (error) => this.onerror?.(error));
    child.stdout?.on("data", (chunk: Buffer) => {
      this.buffer.append(chunk);
      for (;;) {
        let message: JSONRPCMessage | null;
        try {
          message = this.buffer.readMessage();
        } catch (error) {
          // 坏行已被消费，继续读后面的
          this.onerror?.(error instanceof Error ? error : new Error(String(error)));
          continue;
        }
        if (!message) {
          break;
        }
        this.onmessage?.(message);
      }
    });
    if (child.stderr) {
      createInterface({ input: child.stderr }).on("line", (line) => this.logger.info("[cua-driver] %s", line));
    }
  }

  send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin) {
      return Promise.reject(new Error("驱动进程未运行"));
    }
    return new Promise((resolve) => {
      if (stdin.write(serializeMessage(message))) {
        resolve();
      } else {
        stdin.once("drain", () => resolve());
      }
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (child) {
      await terminateWithTreeKill(child, { gracefulTimeoutMs: 2000, forceTimeoutMs: 2000 });
    }
  }
}

/** 整个 sidecar 共享一个驱动进程：首次使用时懒启动，退出后下次调用重新拉起 */
export class CuaDriverConnection implements DriverToolClient {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private tools: Tool[] | null = null;

  constructor(
    private readonly version: string,
    private readonly logger: Logger,
    /** 测试注入：定位驱动与 MCP 启动方式 */
    private readonly probe: () => Promise<DriverProbe> = probeDriver,
  ) {}

  get running(): boolean {
    return this.client !== null;
  }

  private connect(): Promise<Client> {
    if (this.client) {
      return Promise.resolve(this.client);
    }
    this.connecting ??= (async () => {
      const probe = await this.probe();
      if (!probe.installed || !probe.command) {
        throw new Error("未找到 cua-driver，请先在「设置 → Computer Use」安装驱动");
      }
      const client = new Client({ name: "agentdeck", version: this.version }, { capabilities: {} });
      client.onclose = () => {
        if (this.client === client) {
          this.client = null;
          this.tools = null;
          this.logger.info("cua-driver 已退出");
        }
      };
      await client.connect(new DriverStdioTransport(probe.command, probe.args ?? ["mcp"], this.logger));
      this.logger.info("cua-driver 已启动：%s %s", probe.command, (probe.args ?? []).join(" "));
      this.client = client;
      return client;
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async listTools(): Promise<Tool[]> {
    if (this.tools && this.client) {
      return this.tools;
    }
    const client = await this.connect();
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      // 直接发请求而不用 client.listTools()：后者会为每个 outputSchema 编译校验器，驱动的 schema 不必经过它
      const page = await client.request(
        { method: "tools/list", params: cursor ? { cursor } : {} },
        ListToolsResultSchema,
        { timeout: CALL_TIMEOUT_MS },
      );
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    if (this.client === client) {
      this.tools = tools;
    }
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<CallToolResult> {
    const client = await this.connect();
    return client.request({ method: "tools/call", params: { name, arguments: args } }, CallToolResultSchema, {
      timeout: timeoutMs,
      ...(signal ? { signal } : {}),
    });
  }

  async stop(): Promise<void> {
    const client = this.client ?? (await this.connecting?.catch(() => null)) ?? null;
    this.client = null;
    this.tools = null;
    await client?.close();
  }
}
