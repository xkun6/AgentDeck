// 会话互通 MCP 服务端（design.md 4.26）：在 sidecar 的 HTTP 服务上提供无状态 Streamable HTTP 端点 `POST /mcp`，
// 让运行中的 Agent 经 `mcp__agentdeck__*` 工具委派、读取、转发消息给其它会话。所有操作都经 AgentManager 公共方法完成。
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type {
  AgentSnapshot,
  AgentStreamEnvelope,
  ProviderInfo,
} from "@agentdeck/protocol";
import { z } from "zod";

import type { AgentManager } from "../agent/agent-manager.js";
import { AgentRpcError } from "../agent/errors.js";
import { addWorktree, removeWorktree } from "../git/worktree.js";
import { createSilentLogger, type Logger } from "../logger.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { redactInteropTokens } from "../utils/redact-interop.js";
import { MCP_PATH, type InteropService } from "./interop-service.js";

/** 委派深度（parent 链长度）上限 */
export const INTEROP_MAX_DEPTH = 3;
/** 单个会话同时运行的子会话上限 */
export const INTEROP_MAX_RUNNING_CHILDREN = 8;
export const INTEROP_REPLY_MAX_CHARS = 40_000;
export const INTEROP_READ_DEFAULT_MESSAGES = 10;
export const INTEROP_READ_MAX_MESSAGES = 50;
export const INTEROP_DEFAULT_TIMEOUT_SEC = 600;
export const INTEROP_MAX_TIMEOUT_SEC = 3600;
const REQUEST_BODY_MAX_BYTES = 1024 * 1024;
/** 即使目录里查不到，这些 modeId 也一律视为危险（跳过权限确认类） */
const DANGEROUS_MODE_PATTERN = /bypass|full-access|dangerous|yolo/i;

export interface McpInteropOptions {
  manager: AgentManager;
  registry: Pick<ProviderRegistry, "get" | "listProviderInfo">;
  interop: InteropService;
  /** AGENTDECK_DATA_DIR：worktree 放在 `<dataDir>/worktrees/` 下 */
  dataDir?: string;
  logger?: Logger;
}

/** 工具内的可预期失败：message 原样（中文）返回给调用方 Agent */
class ToolError extends Error {}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function textResult(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

function errorResult(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: redactInteropTokens(message) }] };
}

function clampTimeoutSec(value: number | undefined): number {
  const raw = value ?? INTEROP_DEFAULT_TIMEOUT_SEC;
  return Math.min(Math.max(Math.floor(raw), 1), INTEROP_MAX_TIMEOUT_SEC);
}

function truncateReply(text: string): string {
  return text.length > INTEROP_REPLY_MAX_CHARS
    ? `${text.slice(0, INTEROP_REPLY_MAX_CHARS)}\n…（已截断，超过 ${INTEROP_REPLY_MAX_CHARS} 字）`
    : text;
}

function isBusy(snapshot: AgentSnapshot): boolean {
  return snapshot.status === "running" || snapshot.status === "starting" || Boolean(snapshot.activeTurnId);
}

/** 最后一条助手消息：按 messageId 拼接增量 chunk；没有 messageId 时取末尾连续的一段 */
export function lastAssistantText(entries: AgentStreamEnvelope[]): string | undefined {
  let lastId: string | undefined;
  let found = false;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const event = entries[index]!.event;
    if (event.type === "timeline" && event.item.type === "assistant_message") {
      lastId = event.item.messageId;
      found = true;
      break;
    }
  }
  if (!found) {
    return undefined;
  }
  const chunks: string[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const event = entries[index]!.event;
    if (event.type === "timeline" && event.item.type === "assistant_message") {
      if (event.item.messageId !== lastId) {
        break;
      }
      chunks.unshift(event.item.text);
    } else if (lastId === undefined && event.type === "timeline" && event.item.type !== "reasoning") {
      break;
    }
  }
  const text = chunks.join("");
  return text.trim() ? text : undefined;
}

/** 最近一个回合的结局（取 entries 中最后一个回合结束事件） */
function lastOutcome(
  entries: AgentStreamEnvelope[],
): { status: "completed" | "failed" | "canceled"; error?: string } | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const event = entries[index]!.event;
    if (event.type === "turn_completed") {
      return { status: "completed" };
    }
    if (event.type === "turn_failed") {
      return { status: "failed", error: event.error };
    }
    if (event.type === "turn_canceled") {
      return { status: "canceled" };
    }
  }
  return undefined;
}

/** read_agent 的对话文本：用户 / 助手消息，工具调用一行摘要；只取最近 N 条用户 / 助手消息 */
export function buildReadTranscript(entries: AgentStreamEnvelope[], lastMessages: number): string {
  type Part = { kind: "user" | "assistant" | "tool"; text: string; clientMessageId?: string };
  const parts: Part[] = [];
  const toolIndex = new Map<string, number>();
  for (const { event } of entries) {
    if (event.type === "user_message_retracted") {
      const index = event.clientMessageId
        ? parts.findIndex((part) => part.kind === "user" && part.clientMessageId === event.clientMessageId)
        : parts.map((part) => part.kind).lastIndexOf("user");
      if (index >= 0) {
        parts.splice(index, 1);
        toolIndex.clear();
      }
      continue;
    }
    if (event.type !== "timeline") {
      continue;
    }
    const item = event.item;
    if (item.type === "user_message") {
      parts.push({
        kind: "user",
        text: item.text,
        ...(item.clientMessageId !== undefined ? { clientMessageId: item.clientMessageId } : {}),
      });
    } else if (item.type === "assistant_message") {
      const last = parts[parts.length - 1];
      if (last?.kind === "assistant") {
        last.text += item.text;
      } else {
        parts.push({ kind: "assistant", text: item.text });
      }
    } else if (item.type === "tool_call") {
      const text = `[工具 ${item.name} · ${item.status}]`;
      const existing = toolIndex.get(item.callId);
      if (existing !== undefined && parts[existing]) {
        parts[existing]!.text = text;
      } else {
        toolIndex.set(item.callId, parts.length);
        parts.push({ kind: "tool", text });
      }
    }
  }
  const visible = parts.filter((part) => part.text.trim() !== "");
  // 从倒数第 N 条用户 / 助手消息开始截取（其间的工具摘要一并保留）
  let seen = 0;
  let start = 0;
  for (let index = visible.length - 1; index >= 0; index -= 1) {
    if (visible[index]!.kind !== "tool") {
      seen += 1;
      if (seen === lastMessages) {
        start = index;
        break;
      }
    }
  }
  const text = visible
    .slice(start)
    .map((part) =>
      part.kind === "user" ? `用户：${part.text}` : part.kind === "assistant" ? `助手：${part.text}` : part.text,
    )
    .join("\n\n");
  return text.length > INTEROP_REPLY_MAX_CHARS
    ? `…（已截断，只保留最后 ${INTEROP_REPLY_MAX_CHARS} 字）\n${text.slice(-INTEROP_REPLY_MAX_CHARS)}`
    : text;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > REQUEST_BODY_MAX_BYTES) {
      throw new Error("请求体过大");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

/**
 * `POST /mcp` 端点与工具实现。每个请求新建一个无状态 McpServer（工具闭包绑定调用方 agentId）。
 */
export class McpInteropEndpoint {
  private readonly manager: AgentManager;
  private readonly registry: McpInteropOptions["registry"];
  private readonly interop: InteropService;
  private readonly dataDir: string | undefined;
  private readonly logger: Logger;

  constructor(options: McpInteropOptions) {
    this.manager = options.manager;
    this.registry = options.registry;
    this.interop = options.interop;
    this.dataDir = options.dataDir;
    this.logger = options.logger ?? createSilentLogger();
  }

  /** 处理 HTTP 请求；路径不是 /mcp 时返回 false（交给上层） */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== MCP_PATH) {
      return false;
    }
    if (!this.interop.enabled) {
      sendJson(res, 404, { ok: false, error: "会话互通未启用" });
      return true;
    }
    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    const callerId = match ? this.interop.agentIdForToken(match[1]!) : null;
    if (!callerId) {
      this.logger.warn("拒绝 MCP 请求：token 不匹配");
      sendJson(res, 401, { ok: false, error: "unauthorized" }, { "www-authenticate": "Bearer" });
      return true;
    }
    if (req.method !== "POST") {
      // 无状态模式不提供 SSE 通道（GET）与会话终止（DELETE）
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
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      this.logger.error("处理 MCP 请求出错：%s", error instanceof Error ? error.message : String(error));
      if (!res.headersSent) {
        sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "内部错误" }, id: null });
      }
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // 工具
  // -------------------------------------------------------------------------

  private createServer(callerId: string): McpServer {
    const server = new McpServer({ name: "agentdeck", version: "1.0.0" });
    const register = <S extends z.ZodRawShape>(
      name: string,
      description: string,
      shape: S,
      run: (args: z.infer<z.ZodObject<S>>, signal: AbortSignal | undefined) => Promise<ToolResult>,
    ) => {
      // 参数由 SDK 按 zod shape 校验后传入；回调类型与 SDK 的泛型推导对不上，这里统一收口
      const callback = async (args: unknown, extra: { signal?: AbortSignal }): Promise<ToolResult> => {
        try {
          return await run(args as z.infer<z.ZodObject<S>>, extra.signal);
        } catch (error) {
          if (error instanceof ToolError || error instanceof AgentRpcError) {
            return errorResult(error.message);
          }
          this.logger.error(
            "互通工具 %s 出错：%s",
            name,
            error instanceof Error ? (error.stack ?? error.message) : String(error),
          );
          return errorResult(`内部错误：${error instanceof Error ? error.message : String(error)}`);
        }
      };
      server.registerTool(name, { description, inputSchema: shape }, callback as never);
    };

    register("list_providers", "列出 AgentDeck 里可用的 Agent（provider）：id、名称、类型与可用性。", {}, async () => {
      const providers = await this.registry.listProviderInfo();
      return textResult(providers.map(summarizeProvider));
    });

    register(
      "list_agents",
      "列出 AgentDeck 里的会话：id、标题、provider、工作目录、状态、模型、父会话 id。",
      { includeArchived: z.boolean().optional().describe("是否包含已归档会话，默认 false") },
      async (args) => {
        const agents = this.manager
          .listAgents()
          .filter((agent) => args.includeArchived === true || !agent.archived)
          .map((agent) => ({
            id: agent.id,
            title: agent.title ?? agent.preview ?? null,
            provider: agent.provider,
            cwd: agent.cwd,
            status: agent.status,
            model: agent.model ?? null,
            parentAgentId: agent.parentAgentId ?? null,
          }));
        return textResult(agents);
      },
    );

    register(
      "read_agent",
      "读取某个会话最近的用户 / 助手消息（工具调用只显示一行摘要）。",
      {
        agentId: z.string().min(1),
        lastMessages: z
          .number()
          .int()
          .min(1)
          .max(INTEROP_READ_MAX_MESSAGES)
          .optional()
          .describe(`默认 ${INTEROP_READ_DEFAULT_MESSAGES}，上限 ${INTEROP_READ_MAX_MESSAGES}`),
      },
      async (args) => {
        const target = this.requireTarget(args.agentId);
        const { entries } = await this.manager.timeline(target.id);
        const transcript = buildReadTranscript(entries, args.lastMessages ?? INTEROP_READ_DEFAULT_MESSAGES);
        return textResult(transcript || "（该会话还没有消息）");
      },
    );

    register(
      "delegate",
      "新建一个子会话（由指定 provider 的 Agent 执行）并发送任务。wait 为 true（默认）时等回合结束并返回最后一条助手消息，超时返回 status=running，之后可用 wait_agent 继续等待。" +
        " modeId 不能是跳过权限确认的危险模式；子会话的权限请求由用户在 AgentDeck 界面审批。",
      {
        provider: z.string().min(1).describe("provider id，见 list_providers，如 claude / codex"),
        prompt: z.string().min(1).describe("交给子会话的任务描述"),
        cwd: z.string().optional().describe("工作目录，默认与当前会话相同"),
        model: z.string().optional(),
        modeId: z.string().optional().describe("权限模式；缺省用 provider 默认模式"),
        title: z.string().max(200).optional(),
        worktree: z.boolean().optional().describe("为 true 时在独立 git worktree（新分支）中工作，要求 cwd 在 git 仓库内"),
        wait: z.boolean().optional().describe("是否等待回合结束，默认 true"),
        timeoutSec: z.number().positive().optional().describe(`等待超时秒数，默认 ${INTEROP_DEFAULT_TIMEOUT_SEC}，上限 ${INTEROP_MAX_TIMEOUT_SEC}`),
      },
      (args, signal) => this.delegate(callerId, args, signal),
    );

    register(
      "send_to_agent",
      "向另一个会话发送消息（只能发给自己委派出的子孙会话，或用户标记为「允许被其它会话调用」的会话）。目标正在运行时返回错误。",
      {
        agentId: z.string().min(1),
        message: z.string().min(1),
        wait: z.boolean().optional().describe("是否等待回合结束，默认 true"),
        timeoutSec: z.number().positive().optional(),
      },
      (args, signal) => this.sendToAgent(callerId, args, signal),
    );

    register(
      "wait_agent",
      "等待某个会话当前回合结束，返回最后一条助手消息；超时返回 status=running。",
      { agentId: z.string().min(1), timeoutSec: z.number().positive().optional() },
      (args, signal) => this.waitAgent(callerId, args, signal),
    );

    register(
      "cancel_agent",
      "中断某个会话当前回合（只能中断自己委派出的子孙会话，或被标记为「允许被其它会话调用」的会话）。",
      { agentId: z.string().min(1) },
      (args) => this.cancelAgent(callerId, args),
    );

    return server;
  }

  private requireTarget(agentId: string): AgentSnapshot {
    try {
      return this.manager.getAgent(agentId);
    } catch {
      throw new ToolError(`找不到会话：${agentId}`);
    }
  }

  /** 祖先会话 id 链（不含自己），带环保护 */
  private ancestorsOf(agentId: string): string[] {
    const chain: string[] = [];
    const seen = new Set<string>([agentId]);
    let current = agentId;
    for (;;) {
      let parent: string | undefined;
      try {
        parent = this.manager.getAgent(current).parentAgentId;
      } catch {
        break;
      }
      if (!parent || seen.has(parent)) {
        break;
      }
      chain.push(parent);
      seen.add(parent);
      current = parent;
    }
    return chain;
  }

  /** 目标是否是调用方的子孙，或被用户标记为允许被其它会话调用 */
  private canOperate(callerId: string, target: AgentSnapshot): boolean {
    return target.interopTarget === true || this.ancestorsOf(target.id).includes(callerId);
  }

  private async assertModeAllowed(provider: string, cwd: string, modeId: string): Promise<void> {
    if (DANGEROUS_MODE_PATTERN.test(modeId)) {
      throw new ToolError(`不允许委派使用危险模式：${modeId}`);
    }
    const client = this.registry.get(provider);
    if (!client) {
      return; // 未知 provider 交给 createAgent 报错
    }
    const catalog = await client.fetchCatalog({ cwd }).catch(() => null);
    const mode = catalog?.modes.find((entry) => entry.id === modeId);
    if (mode?.dangerous) {
      throw new ToolError(`不允许委派使用危险模式：${modeId}`);
    }
    if (catalog && catalog.modes.length > 0 && !mode) {
      throw new ToolError(
        `provider ${provider} 不支持模式 ${modeId}，可用：${catalog.modes.map((entry) => entry.id).join("、")}`,
      );
    }
  }

  private async delegate(
    callerId: string,
    args: {
      provider: string;
      prompt: string;
      cwd?: string | undefined;
      model?: string | undefined;
      modeId?: string | undefined;
      title?: string | undefined;
      worktree?: boolean | undefined;
      wait?: boolean | undefined;
      timeoutSec?: number | undefined;
    },
    signal: AbortSignal | undefined,
  ): Promise<ToolResult> {
    const caller = this.requireTarget(callerId);
    const depth = this.ancestorsOf(callerId).length + 1;
    if (depth > INTEROP_MAX_DEPTH) {
      throw new ToolError(`委派深度已达上限（${INTEROP_MAX_DEPTH} 层），不能继续向下委派`);
    }
    const running = this.manager
      .listAgents()
      .filter((agent) => agent.parentAgentId === callerId && isBusy(agent)).length;
    if (running >= INTEROP_MAX_RUNNING_CHILDREN) {
      throw new ToolError(`同时运行的子会话已达上限（${INTEROP_MAX_RUNNING_CHILDREN} 个），请等待部分完成后再委派`);
    }

    const cwd = args.cwd ? path.resolve(caller.cwd, args.cwd) : caller.cwd;
    if (args.modeId !== undefined) {
      await this.assertModeAllowed(args.provider, cwd, args.modeId);
    }
    const isDir = await stat(cwd).then(
      (info) => info.isDirectory(),
      () => false,
    );
    if (!isDir) {
      throw new ToolError(`工作目录不存在：${cwd}`);
    }

    const id = randomUUID();
    let worktree: { path: string; branch: string } | undefined;
    if (args.worktree === true) {
      if (!this.dataDir) {
        throw new ToolError("未设置数据目录，无法创建 worktree");
      }
      const short = id.slice(0, 8);
      try {
        worktree = await addWorktree({
          repoCwd: cwd,
          path: path.join(this.dataDir, "worktrees", `delegate-${short}`),
          branch: `agentdeck/delegate-${short}`,
        });
      } catch (error) {
        throw new ToolError(error instanceof Error ? error.message : String(error));
      }
    }

    try {
      await this.manager.createAgent({
        id,
        provider: args.provider,
        cwd: worktree?.path ?? cwd,
        parentAgentId: callerId,
        origin: "delegate",
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.modeId !== undefined ? { modeId: args.modeId } : {}),
        ...(args.title !== undefined ? { title: args.title } : {}),
      });
    } catch (error) {
      if (worktree) {
        await removeWorktree({
          repoCwd: cwd,
          path: worktree.path,
          branch: worktree.branch,
          deleteBranch: true,
        }).catch((cleanupError: unknown) =>
          this.logger.warn("清理委派 worktree 失败：%s", cleanupError instanceof Error ? cleanupError.message : String(cleanupError)),
        );
      }
      throw error;
    }

    try {
      await this.manager.sendPrompt(id, args.prompt);
    } catch (error) {
      throw new ToolError(
        `子会话 ${id} 已创建，但发送任务失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return this.finish(id, 0, args.wait !== false, clampTimeoutSec(args.timeoutSec), signal, worktree);
  }

  private async sendToAgent(
    callerId: string,
    args: { agentId: string; message: string; wait?: boolean | undefined; timeoutSec?: number | undefined },
    signal: AbortSignal | undefined,
  ): Promise<ToolResult> {
    if (args.agentId === callerId) {
      throw new ToolError("不能向自己发送消息");
    }
    const target = this.requireTarget(args.agentId);
    if (!this.canOperate(callerId, target)) {
      throw new ToolError("只能向自己委派出的子孙会话，或被用户标记为「允许被其它会话调用」的会话发送消息");
    }
    if (isBusy(target)) {
      throw new ToolError("目标会话正在运行，请稍后再试（可先用 wait_agent 等待）");
    }
    const sinceSeq = target.lastSeq;
    try {
      await this.manager.sendPrompt(target.id, args.message);
    } catch (error) {
      if (error instanceof AgentRpcError && error.code === "TURN_IN_PROGRESS") {
        throw new ToolError("目标会话正在运行，请稍后再试（可先用 wait_agent 等待）");
      }
      throw error;
    }
    return this.finish(target.id, sinceSeq, args.wait !== false, clampTimeoutSec(args.timeoutSec), signal);
  }

  private async waitAgent(
    callerId: string,
    args: { agentId: string; timeoutSec?: number | undefined },
    signal: AbortSignal | undefined,
  ): Promise<ToolResult> {
    if (args.agentId === callerId) {
      throw new ToolError("不能等待自己");
    }
    const target = this.requireTarget(args.agentId);
    if (this.ancestorsOf(callerId).includes(target.id)) {
      throw new ToolError("不能等待自己的上级会话（会互相等待）");
    }
    return this.finish(target.id, 0, true, clampTimeoutSec(args.timeoutSec), signal);
  }

  private async cancelAgent(callerId: string, args: { agentId: string }): Promise<ToolResult> {
    if (args.agentId === callerId) {
      throw new ToolError("不能中断自己");
    }
    const target = this.requireTarget(args.agentId);
    if (!this.canOperate(callerId, target)) {
      throw new ToolError("只能中断自己委派出的子孙会话，或被用户标记为「允许被其它会话调用」的会话");
    }
    await this.manager.cancel(target.id);
    return textResult({ agentId: target.id, status: this.manager.getAgent(target.id).status });
  }

  /** 按需等待回合结束，组装 `{ agentId, status, reply?, error?, note? }` */
  private async finish(
    agentId: string,
    sinceSeq: number,
    wait: boolean,
    timeoutSec: number,
    signal: AbortSignal | undefined,
    worktree?: { path: string; branch: string },
  ): Promise<ToolResult> {
    const idle = wait ? await this.manager.waitForIdle(agentId, timeoutSec * 1000, signal) : false;
    const snapshot = this.manager.getAgent(agentId);
    const result: Record<string, unknown> = { agentId };
    if (worktree) {
      result.worktree = worktree;
    }
    if (!idle) {
      result.status = "running";
      if (snapshot.pendingPermissions.length > 0) {
        result.note = `该会话有 ${snapshot.pendingPermissions.length} 个待审批的权限请求，需用户在 AgentDeck 界面处理`;
      } else if (wait) {
        result.note = `等待超时（${timeoutSec} 秒），会话仍在运行，可用 wait_agent 继续等待`;
      }
      return textResult(result);
    }
    const { entries } = await this.manager.timeline(agentId, sinceSeq);
    const outcome = lastOutcome(entries);
    result.status = outcome?.status ?? "completed";
    if (outcome?.error) {
      result.error = outcome.error;
    }
    const reply = lastAssistantText(entries);
    if (reply !== undefined) {
      result.reply = truncateReply(reply);
    }
    return textResult(result);
  }
}

function summarizeProvider(info: ProviderInfo): Record<string, unknown> {
  return {
    id: info.id,
    label: info.label,
    kind: info.kind,
    available: info.available,
    ...(info.unavailableReason ? { unavailableReason: info.unavailableReason } : {}),
  };
}
