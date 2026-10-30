// 会话互通 MCP 端点（design.md 4.26）：鉴权、tools/list、各工具成功与安全约束失败路径、worktree 委派
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AgentPermissionRequest,
  AgentStreamEnvelope,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentSnapshot,
  AgentStreamEvent,
} from "@agentdeck/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, test, vi } from "vitest";

import { AgentManager } from "../src/agent/agent-manager.js";
import type { AgentClient, AgentSession, AgentSessionConfig } from "../src/agent/types.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { InteropService } from "../src/server/interop-service.js";
import {
  buildReadTranscript,
  clampTimeoutSec,
  INTEROP_INSTRUCTIONS,
  INTEROP_MAX_RUNNING_CHILDREN,
  lastAssistantText,
  McpInteropEndpoint,
} from "../src/server/mcp-interop.js";
import { RpcServer } from "../src/server/rpc-server.js";
import { SettingsStore } from "../src/settings/sidecar-settings.js";
import { locateGit } from "../src/snapshots/git.js";

const hasGit = (await locateGit()) !== null;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 脚本化会话：prompt 以 `hold:` 开头时只发 turn_started（运行中，由测试调用 finish 结束）；
 * 以 `fail:` 开头时 turn_failed；其它回显 `回答:<prompt>` 并 turn_completed。
 */
class ScriptedSession implements AgentSession {
  readonly provider = "fake";
  readonly prompts: string[] = [];
  private listeners = new Set<(event: AgentStreamEvent) => void>();
  private turnCounter = 0;
  private heldTurnId: string | null = null;
  interrupts = 0;

  constructor(
    public id: string | null,
    readonly cfg: AgentSessionConfig,
  ) {}

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    const text = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
    this.prompts.push(text);
    this.turnCounter += 1;
    const turnId = `t${this.turnCounter}`;
    if (!this.id) {
      this.id = `native-${Math.random().toString(16).slice(2)}`;
      this.emit({ type: "thread_started", sessionId: this.id });
    }
    this.emit({ type: "turn_started", turnId });
    if (text.startsWith("hold:")) {
      this.heldTurnId = turnId;
    } else if (text.startsWith("fail:")) {
      this.emit({ type: "turn_failed", turnId, error: "脚本化失败" });
    } else {
      this.emit({
        type: "timeline",
        turnId,
        item: { type: "assistant_message", text: `回答:${text}`, messageId: `m${this.turnCounter}` },
      });
      this.emit({ type: "turn_completed", turnId });
    }
    return { turnId };
  }

  /** 结束被 hold 的回合，并带一条助手消息 */
  finish(reply: string): void {
    const turnId = this.heldTurnId;
    if (!turnId) return;
    this.heldTurnId = null;
    this.emit({
      type: "timeline",
      turnId,
      item: { type: "assistant_message", text: reply, messageId: `m${this.turnCounter}` },
    });
    this.emit({ type: "turn_completed", turnId });
  }

  subscribe(cb: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(event: AgentStreamEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return [];
  }
  async respondToPermission(): Promise<void> {}
  async interrupt(): Promise<void> {
    this.interrupts += 1;
    const turnId = this.heldTurnId;
    if (turnId) {
      this.heldTurnId = null;
      this.emit({ type: "turn_canceled", turnId, reason: "interrupt" });
    }
  }
  async close(): Promise<void> {}
  describePersistence(): AgentPersistenceHandle | null {
    return this.id ? { provider: "fake", sessionId: this.id } : null;
  }
}

interface Harness {
  manager: AgentManager;
  interop: InteropService;
  settings: SettingsStore;
  server: RpcServer;
  sessions: ScriptedSession[];
  dataDir: string;
  port: number;
  url: string;
  /** 以用户身份建会话（origin 缺省），返回 agentId 与它的互通 token */
  createCaller(opts?: {
    cwd?: string;
    parentAgentId?: string;
    modeId?: string;
    origin?: "schedule" | "kanban" | "group";
  }): Promise<{ id: string; token: string }>;
  /** 用某会话的 token 连上 MCP 端点 */
  connect(token: string): Promise<Client>;
  /** 按 agentId 取它的脚本化会话（用互通 token 对应） */
  sessionOf(agentId: string): ScriptedSession | undefined;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function createHarness(opts: { kind?: AgentClient["kind"] } = {}): Promise<Harness> {
  const sessions: ScriptedSession[] = [];
  const fakeClient: AgentClient = {
    provider: "fake",
    kind: opts.kind ?? "mock",
    label: "Fake",
    isAvailable: async () => ({ available: true }),
    fetchCatalog: async () => ({
      models: [
        {
          provider: "fake",
          id: "fast",
          label: "快",
          isDefault: true,
          thinkingOptions: [{ id: "high", label: "高" }],
          defaultThinkingOptionId: "high",
        },
      ],
      modes: [
        { id: "default", label: "默认" },
        { id: "auto", label: "自动" },
        { id: "plan", label: "计划" },
        { id: "danger", label: "危险", dangerous: true },
      ],
    }),
    createSession: async (cfg) => {
      const session = new ScriptedSession(null, cfg);
      sessions.push(session);
      return session;
    },
  };
  const downClient: AgentClient = {
    provider: "down",
    kind: "mock",
    label: "Down",
    isAvailable: async () => ({ available: false, reason: "未安装" }),
    fetchCatalog: async () => ({ models: [], modes: [] }),
    createSession: async () => {
      throw new Error("不可用");
    },
  };
  const registry = new ProviderRegistry([fakeClient, downClient]);
  const dataDir = mkdtempSync(path.join(tmpdir(), "agentdeck-interop-"));
  const settings = new SettingsStore();
  const interop = new InteropService({ settings: () => settings.get().interop });
  const manager = new AgentManager({ registry, interop });
  const mcp = new McpInteropEndpoint({ manager, registry, interop, dataDir, reportSettleMs: 10 });
  const server = new RpcServer({ token: "rpc-token", version: "test", manager, registry, settings, mcp });
  const port = await server.listen(0, "127.0.0.1");
  interop.setPort(port);
  cleanups.push(async () => {
    mcp.stop();
    await server.close();
    await manager.shutdown();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const url = `http://127.0.0.1:${port}/mcp`;
  return {
    manager,
    interop,
    settings,
    server,
    sessions,
    dataDir,
    port,
    url,
    async createCaller(opts = {}) {
      const agent = await manager.createAgent({
        provider: "fake",
        cwd: opts.cwd ?? dataDir,
        ...(opts.parentAgentId ? { parentAgentId: opts.parentAgentId } : {}),
        ...(opts.modeId ? { modeId: opts.modeId } : {}),
        ...(opts.origin ? { origin: opts.origin } : {}),
      });
      const endpoint = interop.endpointFor(agent.id);
      return { id: agent.id, token: endpoint!.token };
    },
    sessionOf(agentId) {
      const token = interop.endpointFor(agentId)?.token;
      return sessions.find((session) => session.cfg.interop?.token === token);
    },
    async connect(token) {
      const client = new Client({ name: "test", version: "0.0.1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(url), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      cleanups.push(() => client.close());
      return client;
    },
  };
}

interface ToolOutcome {
  isError: boolean;
  text: string;
  json: Record<string, unknown> | unknown[] | null;
}

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  const text = content.map((part) => part.text).join("");
  let json: ToolOutcome["json"] = null;
  try {
    json = JSON.parse(text) as ToolOutcome["json"];
  } catch {
    // 非 JSON 文本
  }
  return { isError: result.isError === true, text, json };
}

async function postMcp(
  url: string,
  headers: Record<string, string>,
  body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list" },
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /mcp 鉴权", () => {
  test("token 缺失或错误 → 401；正确 token → 200；GET → 405", async () => {
    const h = await createHarness();
    const caller = await h.createCaller();
    expect((await postMcp(h.url, {})).status).toBe(401);
    expect((await postMcp(h.url, { authorization: "Bearer adi_nope" })).status).toBe(401);
    expect((await postMcp(h.url, { authorization: "Bearer rpc-token" })).status).toBe(401);
    const ok = await postMcp(h.url, { authorization: `Bearer ${caller.token}` });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.length).toBe(8);
    const get = await fetch(h.url, { headers: { authorization: `Bearer ${caller.token}` } });
    expect(get.status).toBe(405);
  });

  test("settings.interop.enabled 为 false → 404 且不再注入 token", async () => {
    const h = await createHarness();
    const caller = await h.createCaller();
    await h.settings.set({ interop: { enabled: false } });
    expect((await postMcp(h.url, { authorization: `Bearer ${caller.token}` })).status).toBe(404);
    expect(h.interop.endpointFor(caller.id)).toBeUndefined();
    const created = await h.manager.createAgent({ provider: "fake", cwd: h.dataDir });
    expect(h.sessions.at(-1)!.cfg.interop).toBeUndefined();
    expect(created.id).toBeTruthy();
    await h.settings.set({ interop: { enabled: true } });
    expect((await postMcp(h.url, { authorization: `Bearer ${caller.token}` })).status).toBe(200);
  });

  test("会话删除后 token 作废（forget）", async () => {
    const h = await createHarness();
    const caller = await h.createCaller();
    h.interop.forget(caller.id);
    expect((await postMcp(h.url, { authorization: `Bearer ${caller.token}` })).status).toBe(401);
  });

  test("新建会话时注入端点：url 指向本端口 /mcp，token 带 adi_ 前缀", async () => {
    const h = await createHarness();
    await h.createCaller();
    const endpoint = h.sessions[0]!.cfg.interop!;
    expect(endpoint.url).toBe(`http://127.0.0.1:${h.port}/mcp`);
    expect(endpoint.token).toMatch(/^adi_[0-9a-f]{48}$/);
  });
});

describe("工具：tools/list 与只读工具", () => {
  test("tools/list 返回 8 个工具；initialize 带 instructions", async () => {
    const h = await createHarness();
    const caller = await h.createCaller();
    const client = await h.connect(caller.token);
    expect(client.getInstructions()).toBe(INTEROP_INSTRUCTIONS);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        "cancel_agent",
        "delegate",
        "list_agents",
        "list_providers",
        "read_agent",
        "report_to_dispatcher",
        "send_to_agent",
        "wait_agent",
      ],
    );
  });

  test("list_providers / list_agents（含归档过滤）/ read_agent", async () => {
    const h = await createHarness();
    const caller = await h.createCaller();
    const client = await h.connect(caller.token);

    const providers = (await callTool(client, "list_providers")).json as Array<Record<string, unknown>>;
    expect(providers.map((p) => [p.id, p.available])).toEqual([
      ["fake", true],
      ["down", false],
    ]);

    const other = await h.manager.createAgent({ provider: "fake", cwd: h.dataDir, title: "另一个" });
    await h.manager.updateAgent(other.id, { archived: true });
    const visible = (await callTool(client, "list_agents")).json as Array<{ id: string }>;
    expect(visible.map((a) => a.id)).toEqual([caller.id]);
    const all = (await callTool(client, "list_agents", { includeArchived: true })).json as Array<{
      id: string;
      title: string | null;
    }>;
    expect(all.map((a) => a.id).sort()).toEqual([caller.id, other.id].sort());
    expect(all.find((a) => a.id === other.id)?.title).toBe("另一个");

    await h.manager.sendPrompt(other.id, "你好");
    const read = await callTool(client, "read_agent", { agentId: other.id });
    expect(read.isError).toBe(false);
    expect(read.text).toContain("用户：你好");
    expect(read.text).toContain("助手：回答:你好");

    const missing = await callTool(client, "read_agent", { agentId: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("找不到会话");
  });

  test("buildReadTranscript 只取最近 N 条用户 / 助手消息，lastAssistantText 按 messageId 拼接", () => {
    const entry = (seq: number, event: AgentStreamEvent) => ({
      agentId: "a",
      seq,
      epoch: "e",
      timestamp: seq,
      event,
    });
    const entries = [
      entry(1, { type: "timeline", item: { type: "user_message", text: "Q1" } }),
      entry(2, { type: "timeline", item: { type: "assistant_message", text: "A1", messageId: "m1" } }),
      entry(3, { type: "timeline", item: { type: "user_message", text: "Q2" } }),
      entry(4, { type: "timeline", item: { type: "assistant_message", text: "A2-", messageId: "m2" } }),
      entry(5, {
        type: "timeline",
        item: {
          type: "tool_call",
          callId: "c1",
          name: "Bash",
          status: "completed",
          detail: { type: "unknown", input: null, output: null },
        },
      }),
      entry(6, { type: "timeline", item: { type: "assistant_message", text: "尾", messageId: "m2" } }),
    ];
    const text = buildReadTranscript(entries, 3);
    expect(text).not.toContain("Q1");
    expect(text).toContain("用户：Q2");
    expect(text).toContain("[工具 Bash · completed]");
    expect(lastAssistantText(entries)).toBe("A2-尾");
    expect(lastAssistantText([])).toBeUndefined();
  });
});

describe("delegate", () => {
  test("wait 默认 true：新建子会话（parentAgentId / origin）、返回最后一条助手消息，并向子会话注入互通端点", async () => {
    const h = await createHarness();
    const caller = await h.createCaller({ cwd: h.dataDir });
    const client = await h.connect(caller.token);
    const result = await callTool(client, "delegate", { provider: "fake", prompt: "做点事", title: "子任务" });
    expect(result.isError).toBe(false);
    const json = result.json as { agentId: string; status: string; reply: string };
    expect(json.status).toBe("completed");
    expect(json.reply).toBe("回答:做点事");
    const child = h.manager.getAgent(json.agentId);
    expect(child).toMatchObject({
      parentAgentId: caller.id,
      origin: "delegate",
      title: "子任务",
      cwd: h.dataDir,
      status: "idle",
    });
    // 子会话自己的 token 是另一把
    const childEndpoint = h.interop.endpointFor(child.id)!;
    expect(childEndpoint.token).not.toBe(caller.token);
    expect(h.sessions.at(-1)!.cfg.interop?.token).toBe(childEndpoint.token);
  });

  test("子会话回合失败 → status failed 并带 error", async () => {
    const h = await createHarness();
    const caller = await h.createCaller();
    const client = await h.connect(caller.token);
    const json = (await callTool(client, "delegate", { provider: "fake", prompt: "fail:x" })).json as {
      status: string;
      error: string;
    };
    expect(json.status).toBe("failed");
    expect(json.error).toBe("脚本化失败");
  });

  test("wait 超时返回 status=running，之后 wait_agent 拿到最后一条助手消息", async () => {
    const h = await createHarness();
    const caller = await h.createCaller();
    const client = await h.connect(caller.token);
    const started = Date.now();
    const first = (await callTool(client, "delegate", { provider: "fake", prompt: "hold:长任务", timeoutSec: 1 }))
      .json as { agentId: string; status: string; note: string };
    expect(first.status).toBe("running");
    expect(first.note).toContain("等待超时");
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);

    const waiting = callTool(client, "wait_agent", { agentId: first.agentId, timeoutSec: 30 });
    setTimeout(() => h.sessions.at(-1)!.finish("最终结论"), 100);
    const done = (await waiting).json as { status: string; reply: string };
    expect(done).toMatchObject({ status: "completed", reply: "最终结论" });
  });

  test("wait=false 立即返回 running", async () => {
    const h = await createHarness();
    const caller = await h.createCaller();
    const client = await h.connect(caller.token);
    const json = (await callTool(client, "delegate", { provider: "fake", prompt: "hold:后台", wait: false }))
      .json as { agentId: string; status: string };
    expect(json.status).toBe("running");
    expect(h.manager.getAgent(json.agentId).status).toBe("running");
  });

  test("cwd 缺省继承调用方；相对路径相对调用方 cwd 解析；目录不存在报错", async () => {
    const h = await createHarness();
    const sub = path.join(h.dataDir, "sub");
    mkdirSync(sub);
    const caller = await h.createCaller({ cwd: h.dataDir });
    const client = await h.connect(caller.token);
    const rel = (await callTool(client, "delegate", { provider: "fake", prompt: "x", cwd: "sub" })).json as {
      agentId: string;
    };
    expect(h.manager.getAgent(rel.agentId).cwd).toBe(sub);
    const bad = await callTool(client, "delegate", { provider: "fake", prompt: "x", cwd: "不存在" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("工作目录不存在");
  });

  test("未知 / 不可用 provider 返回工具错误", async () => {
    const h = await createHarness();
    const caller = await h.createCaller();
    const client = await h.connect(caller.token);
    const unknown = await callTool(client, "delegate", { provider: "nope", prompt: "x" });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("未知的 provider");
    const down = await callTool(client, "delegate", { provider: "down", prompt: "x" });
    expect(down.isError).toBe(true);
    expect(down.text).toContain("未安装");
  });

  test("危险模式一律拒绝；目录里没有的模式也拒绝；普通模式放行", async () => {
    const h = await createHarness();
    const caller = await h.createCaller();
    const client = await h.connect(caller.token);
    const danger = await callTool(client, "delegate", { provider: "fake", prompt: "x", modeId: "danger" });
    expect(danger.isError).toBe(true);
    expect(danger.text).toContain("危险模式");
    const pattern = await callTool(client, "delegate", { provider: "fake", prompt: "x", modeId: "bypassPermissions" });
    expect(pattern.isError).toBe(true);
    expect(pattern.text).toContain("危险模式");
    const unknownMode = await callTool(client, "delegate", { provider: "fake", prompt: "x", modeId: "weird" });
    expect(unknownMode.isError).toBe(true);
    expect(unknownMode.text).toContain("不支持模式");
    const ok = await callTool(client, "delegate", { provider: "fake", prompt: "x", modeId: "default" });
    expect(ok.isError).toBe(false);
    expect(h.sessions.every((s) => s.cfg.modeId !== "danger")).toBe(true);
  });

  test("委派深度上限 3：第 3 层可以再委派一层，第 4 层被拒", async () => {
    const h = await createHarness();
    const root = await h.createCaller();
    const l1 = await h.createCaller({ parentAgentId: root.id });
    const l2 = await h.createCaller({ parentAgentId: l1.id });
    const l3 = await h.createCaller({ parentAgentId: l2.id });

    const fromL2 = await callTool(await h.connect(l2.token), "delegate", { provider: "fake", prompt: "x" });
    expect(fromL2.isError).toBe(false); // 子会话深度 = 3

    const fromL3 = await callTool(await h.connect(l3.token), "delegate", { provider: "fake", prompt: "x" });
    expect(fromL3.isError).toBe(true);
    expect(fromL3.text).toContain("委派深度已达上限");
  });

  test(`单会话同时运行的子会话上限 ${INTEROP_MAX_RUNNING_CHILDREN}`, async () => {
    const h = await createHarness();
    const caller = await h.createCaller();
    const client = await h.connect(caller.token);
    for (let i = 0; i < INTEROP_MAX_RUNNING_CHILDREN; i += 1) {
      const json = (await callTool(client, "delegate", { provider: "fake", prompt: `hold:${i}`, wait: false })).json as {
        status: string;
      };
      expect(json.status).toBe("running");
    }
    const over = await callTool(client, "delegate", { provider: "fake", prompt: "x" });
    expect(over.isError).toBe(true);
    expect(over.text).toContain("同时运行的子会话已达上限");
    // 完成一个后又能委派
    h.sessions.find((s) => s.prompts[0]?.startsWith("hold:"))!.finish("done");
    await vi.waitUntil(() =>
      h.manager.listAgents().some((a) => a.parentAgentId === caller.id && a.status === "idle"),
    );
    const again = await callTool(client, "delegate", { provider: "fake", prompt: "x" });
    expect(again.isError).toBe(false);
  });

  test("所有子会话都写 parentAgentId；independent 只让 wait 默认 false，不再有单独的限制", async () => {
    const h = await createHarness();
    const caller = await h.createCaller();
    const client = await h.connect(caller.token);
    const json = (
      await callTool(client, "delegate", { provider: "fake", prompt: "hold:任务", independent: true, report: false })
    ).json as { agentId: string; status: string };
    expect(json.status).toBe("running");
    expect(h.manager.getAgent(json.agentId)).toMatchObject({ parentAgentId: caller.id, origin: "delegate" });
    expect(h.manager.getAgent(json.agentId).reportToAgentId).toBeUndefined();

    // 子会话可以再派单，也可以被派单方继续发消息
    const nested = await h.connect(h.interop.endpointFor(json.agentId)!.token);
    expect((await callTool(nested, "delegate", { provider: "fake", prompt: "x", independent: true, wait: true })).isError).toBe(false);
    h.sessionOf(json.agentId)!.finish("完成");
    await vi.waitUntil(() => h.manager.getAgent(json.agentId).status === "idle");
    expect((await callTool(client, "send_to_agent", { agentId: json.agentId, message: "继续" })).isError).toBe(false);
  });
});

describe("派单回传", () => {
  const reportsOf = (h: Harness, agentId: string) =>
    (h.sessionOf(agentId)?.prompts ?? []).filter((prompt) => prompt.includes("派单回传"));

  test("wait=false：子任务结束后自动发回派单会话", async () => {
    const h = await createHarness();
    const caller = await h.createCaller();
    const client = await h.connect(caller.token);
    const json = (
      await callTool(client, "delegate", { provider: "fake", prompt: "hold:并行", title: "任务A", independent: true })
    ).json as { agentId: string };
    const child = h.manager.getAgent(json.agentId);
    expect(child.parentAgentId).toBe(caller.id);
    expect(child.reportToAgentId).toBe(caller.id);

    h.sessionOf(json.agentId)!.finish("A 做完了");
    await vi.waitUntil(() => reportsOf(h, caller.id).length === 1, { timeout: 3000 });
    const report = reportsOf(h, caller.id)[0]!;
    expect(report).toContain("任务A");
    expect(report).toContain("completed");
    expect(report).toContain("A 做完了");
  });

  test("派单会话忙时排队，空闲后多个结果合并成一条", async () => {
    const h = await createHarness();
    const caller = await h.createCaller();
    const client = await h.connect(caller.token);
    const a = (await callTool(client, "delegate", { provider: "fake", prompt: "hold:a", wait: false })).json as {
      agentId: string;
    };
    const b = (await callTool(client, "delegate", { provider: "fake", prompt: "hold:b", wait: false })).json as {
      agentId: string;
    };
    await h.manager.sendPrompt(caller.id, "hold:派单方在忙");
    h.sessionOf(a.agentId)!.finish("A 结果");
    h.sessionOf(b.agentId)!.finish("B 结果");
    await sleep(100);
    expect(reportsOf(h, caller.id)).toEqual([]);

    h.sessionOf(caller.id)!.finish("忙完");
    await vi.waitUntil(() => reportsOf(h, caller.id).length > 0, { timeout: 3000 });
    expect(reportsOf(h, caller.id)).toHaveLength(1);
    expect(reportsOf(h, caller.id)[0]).toContain("A 结果");
    expect(reportsOf(h, caller.id)[0]).toContain("B 结果");
  });

  test("派单方等到了结果就不回传；等待超时后结束的回合仍回传", async () => {
    const h = await createHarness();
    const caller = await h.createCaller();
    const client = await h.connect(caller.token);
    const waited = await callTool(client, "delegate", { provider: "fake", prompt: "做点事" });
    expect(waited.isError).toBe(false);

    const held = (await callTool(client, "delegate", { provider: "fake", prompt: "hold:长", wait: false })).json as {
      agentId: string;
    };
    const finishing = callTool(client, "wait_agent", { agentId: held.agentId });
    await sleep(30);
    h.sessionOf(held.agentId)!.finish("等到了");
    expect(((await finishing).json as { reply: string }).reply).toBe("等到了");
    await sleep(80);
    expect(reportsOf(h, caller.id)).toEqual([]);

    const timedOut = (await callTool(client, "delegate", { provider: "fake", prompt: "hold:超时", timeoutSec: 1 }))
      .json as { agentId: string; status: string };
    expect(timedOut.status).toBe("running");
    h.sessionOf(timedOut.agentId)!.finish("超时后完成");
    await vi.waitUntil(() => reportsOf(h, caller.id).length === 1, { timeout: 3000 });
    expect(reportsOf(h, caller.id)[0]).toContain("超时后完成");
  });

  test("只回传派单方发出的回合：用户手动发的不回传，派单方 send_to_agent 的回传，自己中断的不回传", async () => {
    const h = await createHarness();
    const caller = await h.createCaller();
    const client = await h.connect(caller.token);
    const { agentId } = (await callTool(client, "delegate", { provider: "fake", prompt: "第一步", independent: true, wait: true }))
      .json as { agentId: string };

    await h.manager.sendPrompt(agentId, "用户直接问的");
    await sleep(80);
    expect(reportsOf(h, caller.id)).toEqual([]);

    const sent = await callTool(client, "send_to_agent", { agentId, message: "第二步", wait: false });
    expect(sent.isError).toBe(false);
    await vi.waitUntil(() => reportsOf(h, caller.id).length === 1, { timeout: 3000 });
    expect(reportsOf(h, caller.id)[0]).toContain("回答:第二步");
    await vi.waitUntil(() => h.manager.getAgent(caller.id).status === "idle");

    await callTool(client, "send_to_agent", { agentId, message: "hold:第三步", wait: false });
    await callTool(client, "cancel_agent", { agentId });
    await sleep(80);
    expect(reportsOf(h, caller.id)).toHaveLength(1);
  });

  test("report_to_dispatcher：转发给派单会话；没有派单会话时报错", async () => {
    const h = await createHarness();
    const caller = await h.createCaller();
    const client = await h.connect(caller.token);
    const { agentId } = (await callTool(client, "delegate", { provider: "fake", prompt: "x", independent: true, wait: true }))
      .json as { agentId: string };
    const child = await h.connect(h.interop.endpointFor(agentId)!.token);
    const queued = await callTool(child, "report_to_dispatcher", { message: "用户让我转告" });
    expect(queued.json).toMatchObject({ status: "queued", reportToAgentId: caller.id });
    await vi.waitUntil(() => reportsOf(h, caller.id).length === 1, { timeout: 3000 });
    expect(reportsOf(h, caller.id)[0]).toContain("用户让我转告");

    const none = await callTool(client, "report_to_dispatcher", { message: "x" });
    expect(none.isError).toBe(true);
    expect(none.text).toContain("没有派单会话");
  });

  test("派单会话已归档或已删除：放弃回传，不把它唤醒", async () => {
    const h = await createHarness();
    const caller = await h.createCaller();
    const client = await h.connect(caller.token);
    const { agentId } = (await callTool(client, "delegate", { provider: "fake", prompt: "hold:x", wait: false })).json as {
      agentId: string;
    };
    await h.manager.updateAgent(caller.id, { archived: true });
    h.sessionOf(agentId)!.finish("完成");
    await sleep(80);
    expect(reportsOf(h, caller.id)).toEqual([]);
    expect(h.manager.getAgent(caller.id).archived).toBe(true);
  });

  test.skipIf(!hasGit)("worktree 任务：回传带分支与未提交改动", async () => {
    const h = await createHarness();
    const repo = path.join(h.dataDir, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, windowsHide: true });
    git("init", "-q");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    const caller = await h.createCaller({ cwd: repo });
    const client = await h.connect(caller.token);
    const json = (
      await callTool(client, "delegate", { provider: "fake", prompt: "hold:改代码", worktree: true, wait: false })
    ).json as { agentId: string; worktree: { path: string; branch: string } };
    writeFileSync(path.join(json.worktree.path, "new.txt"), "x");
    h.sessionOf(json.agentId)!.finish("改好了");
    await vi.waitUntil(() => reportsOf(h, caller.id).length === 1, { timeout: 3000 });
    const report = reportsOf(h, caller.id)[0]!;
    expect(report).toContain(`分支：${json.worktree.branch}`);
    expect(report).toContain("未提交改动");
    expect(report).toContain("new.txt");
  });
});

describe("派单时自动开启保活", () => {
  test("Claude 类：首次派单开启保活、不改置顶；用户关掉后再派单不会重新打开", async () => {
    const h = await createHarness({ kind: "claude" });
    const caller = await h.createCaller();
    const client = await h.connect(caller.token);
    await callTool(client, "delegate", { provider: "fake", prompt: "hold:一", wait: false });
    expect(h.manager.getAgent(caller.id).cacheKeepAlive).toBe(true);
    expect(h.manager.getAgent(caller.id).pinned).toBeUndefined();

    await h.manager.updateAgent(caller.id, { cacheKeepAlive: false });
    await callTool(client, "delegate", { provider: "fake", prompt: "hold:二", wait: false });
    expect(h.manager.getAgent(caller.id).cacheKeepAlive).toBe(false);
  });

  test("非 Claude 类不开保活；report=false 不算派单", async () => {
    const h = await createHarness();
    const caller = await h.createCaller();
    await callTool(await h.connect(caller.token), "delegate", { provider: "fake", prompt: "x" });
    expect(h.manager.getAgent(caller.id).cacheKeepAlive).toBeUndefined();
    expect(h.manager.getAgent(caller.id).pinned).toBeUndefined();

    const claude = await createHarness({ kind: "claude" });
    const silent = await claude.createCaller();
    await callTool(await claude.connect(silent.token), "delegate", { provider: "fake", prompt: "x", report: false });
    expect(claude.manager.getAgent(silent.id).cacheKeepAlive).toBeUndefined();
  });

  test("干活的会话：Claude 类建好即开保活、不置顶；非 Claude 类和 report=false 都不开", async () => {
    const h = await createHarness({ kind: "claude" });
    const caller = await h.createCaller();
    const client = await h.connect(caller.token);
    const worker = (await callTool(client, "delegate", { provider: "fake", prompt: "hold:干活", wait: false })).json as {
      agentId: string;
    };
    expect(h.manager.getAgent(worker.agentId).cacheKeepAlive).toBe(true);
    expect(h.manager.getAgent(worker.agentId).pinned).toBeUndefined();
    const silent = (await callTool(client, "delegate", { provider: "fake", prompt: "x", report: false })).json as {
      agentId: string;
    };
    expect(h.manager.getAgent(silent.agentId).cacheKeepAlive).toBeUndefined();

    const other = await createHarness();
    const otherCaller = await other.createCaller();
    const otherWorker = (
      await callTool(await other.connect(otherCaller.token), "delegate", { provider: "fake", prompt: "x" })
    ).json as { agentId: string };
    expect(other.manager.getAgent(otherWorker.agentId).cacheKeepAlive).toBeUndefined();
  });

  test("定时、看板、协作组的会话派单：不写回传关系、不唤醒、不开保活", async () => {
    const h = await createHarness({ kind: "claude" });
    for (const origin of ["schedule", "kanban", "group"] as const) {
      const caller = await h.createCaller({ origin });
      const { agentId } = (
        await callTool(await h.connect(caller.token), "delegate", { provider: "fake", prompt: "hold:任务", wait: false })
      ).json as { agentId: string };
      expect(h.manager.getAgent(agentId).reportToAgentId).toBeUndefined();
      expect(h.manager.getAgent(agentId).cacheKeepAlive).toBeUndefined();
      expect(h.manager.getAgent(caller.id).cacheKeepAlive).toBeUndefined();
      h.sessionOf(agentId)!.finish("完成");
      await sleep(60);
      expect(h.sessionOf(caller.id)!.prompts).toEqual([]);
    }
  });

  test("结果不取缓存保活回合的内容", async () => {
    const h = await createHarness();
    const caller = await h.createCaller();
    const client = await h.connect(caller.token);
    const { agentId } = (await callTool(client, "delegate", { provider: "fake", prompt: "hold:任务", wait: false })).json as {
      agentId: string;
    };
    h.sessionOf(agentId)!.finish("真实结果");
    await vi.waitUntil(() => h.manager.getAgent(agentId).status === "idle");
    await h.manager.sendPrompt(agentId, "保活", undefined, { internal: true, keepAlive: true });
    const waited = (await callTool(client, "wait_agent", { agentId })).json as { reply: string };
    expect(waited.reply).toBe("真实结果");
  });

  test("干活的会话再派单并结束回合：子任务回传、它处理完后才向上回传最终结果", async () => {
    const h = await createHarness();
    const top = await h.createCaller();
    const topClient = await h.connect(top.token);
    const worker = (await callTool(topClient, "delegate", { provider: "fake", prompt: "hold:总任务", wait: false })).json as {
      agentId: string;
    };
    const workerClient = await h.connect(h.interop.endpointFor(worker.agentId)!.token);
    const sub = (await callTool(workerClient, "delegate", { provider: "fake", prompt: "hold:子任务", wait: false })).json as {
      agentId: string;
    };
    const topReports = () => h.sessionOf(top.id)!.prompts.filter((prompt) => prompt.includes("派单回传"));

    h.sessionOf(worker.agentId)!.finish("先派出去了");
    await sleep(80);
    expect(topReports()).toEqual([]);

    h.sessionOf(sub.agentId)!.finish("子任务结果");
    await vi.waitUntil(() => topReports().length === 1, { timeout: 3000 });
    expect(h.sessionOf(worker.agentId)!.prompts.at(-1)).toContain("子任务结果");
    expect(topReports()[0]).toContain("回答:");
    expect(topReports()[0]).not.toContain("先派出去了");
  });

  test("被派单的会话再派单：只开保活，不置顶", async () => {
    const h = await createHarness({ kind: "claude" });
    const root = await h.createCaller();
    const rootClient = await h.connect(root.token);
    const { agentId } = (await callTool(rootClient, "delegate", { provider: "fake", prompt: "x" })).json as {
      agentId: string;
    };
    await callTool(await h.connect(h.interop.endpointFor(agentId)!.token), "delegate", { provider: "fake", prompt: "y" });
    const child = h.manager.getAgent(agentId);
    expect(child.cacheKeepAlive).toBe(true);
    expect(child.pinned).toBeUndefined();
  });
});

describe("read_agent 审查子会话", () => {
  const seedTranscript = async (h: Harness, agentId: string, count: number) => {
    for (let index = 1; index <= count; index += 1) {
      await h.manager.sendPrompt(agentId, `问${index}`);
      await vi.waitUntil(() => h.manager.getAgent(agentId).status === "idle");
    }
  };

  test("offset 向前翻页，文末提示下一页；翻到头后说明", async () => {
    const h = await createHarness();
    const caller = await h.createCaller();
    const client = await h.connect(caller.token);
    const target = await h.manager.createAgent({ provider: "fake", cwd: h.dataDir });
    await seedTranscript(h, target.id, 3); // 共 6 条

    const first = (await callTool(client, "read_agent", { agentId: target.id, lastMessages: 2 })).text;
    expect(first).toContain("问3");
    expect(first).not.toContain("问2");
    expect(first).toContain("offset=2");

    const second = (await callTool(client, "read_agent", { agentId: target.id, lastMessages: 2, offset: 2 })).text;
    expect(second).toContain("问2");
    expect(second).not.toContain("问3");
    expect(second).toContain("offset=4");

    const last = (await callTool(client, "read_agent", { agentId: target.id, lastMessages: 2, offset: 4 })).text;
    expect(last).toContain("问1");
    expect(last).not.toContain("offset=");
    expect((await callTool(client, "read_agent", { agentId: target.id, offset: 6 })).text).toContain("没有更早的消息");
  });

  test("buildReadTranscript：tools 附工具入参与输出，过长截断", () => {
    const entries = [
      {
        agentId: "a",
        seq: 1,
        timestamp: 1,
        event: {
          type: "timeline",
          item: {
            type: "tool_call",
            callId: "c1",
            name: "Bash",
            status: "completed",
            detail: { type: "shell", command: "pnpm test", output: "x".repeat(5000), exitCode: 1 },
          },
        },
      },
    ] as unknown as AgentStreamEnvelope[];
    expect(buildReadTranscript(entries, 10)).toBe("[工具 Bash · completed]");
    const text = buildReadTranscript(entries, 10, { tools: true });
    expect(text).toContain("$ pnpm test");
    expect(text).toContain("已截断");
    expect(text.length).toBeLessThan(4200);
  });

  describe("buildReadTranscript 翻页", () => {
    const user = (text: string) =>
      ({ agentId: "a", seq: 1, event: { type: "timeline", item: { type: "user_message", text } } }) as unknown as AgentStreamEnvelope;
    const assistant = (text: string) =>
      ({ agentId: "a", seq: 1, event: { type: "timeline", item: { type: "assistant_message", text } } }) as unknown as AgentStreamEnvelope;
    const tool = (callId: string) =>
      ({
        agentId: "a",
        seq: 1,
        event: {
          type: "timeline",
          item: { type: "tool_call", callId, name: callId, status: "completed", detail: { type: "plain_text", text: "x".repeat(3900) } },
        },
      }) as unknown as AgentStreamEnvelope;
    /** 按文末提示一直翻到头，返回每页文本 */
    const walk = (entries: AgentStreamEnvelope[], lastMessages: number) => {
      const pages: string[] = [];
      let offset = 0;
      for (let guard = 0; guard < 50; guard += 1) {
        const page = buildReadTranscript(entries, lastMessages, { offset, tools: true });
        pages.push(page);
        const next = /传 offset=(\d+) 继续读/.exec(page);
        if (!next) return pages;
        expect(Number(next[1])).toBeGreaterThan(offset);
        offset = Number(next[1]);
      }
      throw new Error("翻页没有结束");
    };
    const countOf = (pages: string[], marker: string) => pages.join("\n").split(marker).length - 1;

    test("工具比消息多：用户消息和每个工具都读到且只读到一次", () => {
      const tools = Array.from({ length: 30 }, (_, index) => tool(`T${index}_`));
      for (const entries of [
        [user("问题"), ...tools, assistant("答案")],
        [user("问题"), ...tools.slice(0, 15)],
        [user("更早"), assistant("更早的答"), user("问题"), ...tools.slice(0, 20), assistant("答案")],
      ]) {
        const pages = walk(entries, 10);
        expect(pages.length).toBeGreaterThan(1);
        for (const entry of entries) {
          const item = (entry.event as unknown as { item: { type: string; callId?: string; text?: string } }).item;
          const marker = item.type === "tool_call" ? `[工具 ${item.callId} ` : `：${item.text!}\n`;
          expect(countOf(pages.map((page) => `${page}\n`), marker)).toBe(1);
        }
      }
    });

    test("消息过长时一页放不下的留给下一页；单条超限也能往前走", () => {
      const big = "x".repeat(25_000);
      const entries = [user(`a${big}`), user(`b${big}`), user(`c${big}`), user("最新")];
      const first = buildReadTranscript(entries, 4, {});
      expect(first).toContain("用户：c");
      expect(first).not.toContain("用户：b");
      expect(first).toContain("更早还有 2 条记录，传 offset=2");
      const second = buildReadTranscript(entries, 4, { offset: 2 });
      expect(second).toContain("用户：b");
      expect(second).toContain("更早还有 1 条记录，传 offset=3");
      expect(buildReadTranscript(entries, 4, { offset: 3 })).toContain("用户：a");

      const huge = [user("旧"), user("y".repeat(50_000))];
      const clipped = buildReadTranscript(huge, 2, {});
      expect(clipped).toContain("这一条过长");
      expect(clipped).toContain("更早还有 1 条记录，传 offset=1");
      expect(buildReadTranscript(huge, 2, { offset: 1 })).toContain("用户：旧");
    });

    test("撤回后工具状态仍更新在原位，不会多出一条", () => {
      const toolWith = (status: string) =>
        ({ agentId: "a", seq: 1, event: { type: "timeline", item: { type: "tool_call", callId: "c1", name: "T1", status } } }) as unknown as AgentStreamEnvelope;
      const retract = { agentId: "a", seq: 1, event: { type: "user_message_retracted", clientMessageId: "m" } } as unknown as AgentStreamEnvelope;
      const asked = { agentId: "a", seq: 1, event: { type: "timeline", item: { type: "user_message", text: "撤回的", clientMessageId: "m" } } } as unknown as AgentStreamEnvelope;
      const text = buildReadTranscript([user("前"), toolWith("running"), asked, retract, toolWith("completed")], 10, {});
      expect(text).toContain("[工具 T1 · completed]");
      expect(text).not.toContain("running");
      expect(text).not.toContain("撤回的");
    });

    test("放得下时按 lastMessages 取；翻到头没有提示", () => {
      const small = [user("一"), user("二"), user("三")];
      expect(buildReadTranscript(small, 2, {})).toContain("更早还有 1 条记录，传 offset=2");
      expect(buildReadTranscript(small, 3, {})).not.toContain("更早还有");
      expect(buildReadTranscript([], 3, {})).toBe("");
    });

    test("token 跨截断边界也被脱敏", () => {
      const secret = `adi_${"ab".repeat(20)}`;
      const text = `${secret}${"z".repeat(40_000 - 20)}`;
      const clipped = buildReadTranscript([user(text)], 1, {});
      expect(clipped).not.toContain("abab");
    });
  });

  test("read_agent：结果里的互通 token 被脱敏", async () => {
    const h = await createHarness();
    const caller = await h.createCaller({ cwd: h.dataDir });
    const client = await h.connect(caller.token);
    const other = await h.manager.createAgent({ provider: "fake", cwd: h.dataDir, title: "另一个" });
    const secret = `adi_${"ab".repeat(16)}`;
    await h.manager.sendPrompt(other.id, `看到 ${secret}`);
    await vi.waitFor(() => expect(h.manager.getAgent(other.id).status).not.toBe("running"));
    const text = (await callTool(client, "read_agent", { agentId: other.id, includeTools: true })).text;
    expect(text).toContain("adi_***");
    expect(text).not.toContain(secret);
  });

  test.skipIf(!hasGit)("includeDiff：附相对派单会话的提交、未提交改动与未跟踪文件；不是仓库时说明", async () => {
    const h = await createHarness();
    const repo = path.join(h.dataDir, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, windowsHide: true, stdio: "ignore" });
    git("init", "-q");
    writeFileSync(path.join(repo, "a.txt"), "1\n");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
    const caller = await h.createCaller({ cwd: repo });
    const client = await h.connect(caller.token);
    const { agentId, worktree } = (
      await callTool(client, "delegate", { provider: "fake", prompt: "改", worktree: true })
    ).json as { agentId: string; worktree: { path: string } };
    const inWorktree = (...args: string[]) =>
      execFileSync("git", args, { cwd: worktree.path, windowsHide: true, stdio: "ignore" });
    writeFileSync(path.join(worktree.path, "b.txt"), "2\n");
    inWorktree("add", "-A");
    inWorktree("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "加了b");
    writeFileSync(path.join(worktree.path, "a.txt"), "改过\n");
    writeFileSync(path.join(worktree.path, "c.txt"), "3\n");

    const text = (await callTool(client, "read_agent", { agentId, includeDiff: true })).text;
    expect(text).toContain("回答:改");
    expect(text).toContain("加了b");
    expect(text).toContain("c.txt");
    expect(text).toContain("改过");

    const plain = await h.createCaller({ cwd: h.dataDir });
    const none = (await callTool(client, "read_agent", { agentId: plain.id, includeDiff: true })).text;
    expect(none).toContain("读取改动失败");
  });

  test.skipIf(!hasGit)("includeDiff：子目录与基线同仓库、基线不是仓库时，已提交的改动不会被说成「没有改动」", async () => {
    const h = await createHarness();
    const repo = path.join(h.dataDir, "repo");
    const sub = path.join(repo, "sub");
    mkdirSync(sub, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, windowsHide: true, stdio: "ignore" });
    git("init", "-q");
    writeFileSync(path.join(sub, "a.txt"), "1\n");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");

    const inRepo = await h.createCaller({ cwd: repo });
    const repoClient = await h.connect(inRepo.token);
    const child = (await callTool(repoClient, "delegate", { provider: "fake", prompt: "改", cwd: sub })).json as {
      agentId: string;
    };
    writeFileSync(path.join(sub, "b.txt"), "2\n");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "子会话的提交");
    const sameRepo = (await callTool(repoClient, "read_agent", { agentId: child.agentId, includeDiff: true })).text;
    expect(sameRepo).toContain("同一工作区");
    expect(sameRepo).not.toContain("没有改动");

    const outside = await h.createCaller({ cwd: h.dataDir });
    const outsideClient = await h.connect(outside.token);
    const other = (await callTool(outsideClient, "delegate", { provider: "fake", prompt: "改", cwd: repo })).json as {
      agentId: string;
    };
    const noBase = (await callTool(outsideClient, "read_agent", { agentId: other.agentId, includeDiff: true })).text;
    expect(noBase).toContain("不在同一个仓库");
    expect(noBase).not.toContain("没有改动");
  });

  test.skipIf(!hasGit)("includeDiff：同一工作区时如实说明，不说「没有改动」；中文文件名不转义", async () => {
    const h = await createHarness();
    const repo = path.join(h.dataDir, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, windowsHide: true, stdio: "ignore" });
    git("init", "-q");
    writeFileSync(path.join(repo, "a.txt"), "1\n");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
    const caller = await h.createCaller({ cwd: repo });
    const client = await h.connect(caller.token);
    const { agentId } = (await callTool(client, "delegate", { provider: "fake", prompt: "改" })).json as {
      agentId: string;
    };

    const clean = (await callTool(client, "read_agent", { agentId, includeDiff: true })).text;
    expect(clean).toContain("同一工作区");
    expect(clean).not.toContain("没有改动");

    writeFileSync(path.join(repo, "中文.txt"), "3\n");
    const dirty = (await callTool(client, "read_agent", { agentId, includeDiff: true })).text;
    expect(dirty).toContain("同一工作区");
    expect(dirty).toContain("中文.txt");
  });

  test.skipIf(!hasGit)("includeDiff：已合并的提交不说成「没有改动」；子目录不漏根目录的未跟踪文件；没有提交的仓库照常列出；非仓库不带 git 用法全文", async () => {
    const h = await createHarness();
    const repo = path.join(h.dataDir, "repo");
    mkdirSync(path.join(repo, "sub"), { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, windowsHide: true, stdio: "ignore" });
    git("init", "-q");
    writeFileSync(path.join(repo, "sub", "a.txt"), "1\n");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
    const caller = await h.createCaller({ cwd: repo });
    const client = await h.connect(caller.token);

    const { agentId, worktree } = (
      await callTool(client, "delegate", { provider: "fake", prompt: "改", worktree: true })
    ).json as { agentId: string; worktree: { path: string; branch: string } };
    const inWorktree = (...args: string[]) =>
      execFileSync("git", args, { cwd: worktree.path, windowsHide: true, stdio: "ignore" });
    writeFileSync(path.join(worktree.path, "b.txt"), "2\n");
    inWorktree("add", "-A");
    inWorktree("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "加了b");
    git("-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-ff", "-m", "合并", worktree.branch);
    const merged = (await callTool(client, "read_agent", { agentId, includeDiff: true })).text;
    expect(merged).toContain("没有未合并的改动");
    expect(merged).toContain("已合并");

    const subDir = path.join(worktree.path, "sub");
    writeFileSync(path.join(worktree.path, "根目录新文件.txt"), "3\n");
    const inSub = (await callTool(client, "delegate", { provider: "fake", prompt: "看", cwd: subDir })).json as {
      agentId: string;
    };
    const subText = (await callTool(client, "read_agent", { agentId: inSub.agentId, includeDiff: true })).text;
    expect(subText).toContain("根目录新文件.txt");

    const empty = path.join(h.dataDir, "empty");
    mkdirSync(empty);
    execFileSync("git", ["init", "-q"], { cwd: empty, windowsHide: true, stdio: "ignore" });
    writeFileSync(path.join(empty, "新.txt"), "1\n");
    const inEmpty = (await callTool(client, "delegate", { provider: "fake", prompt: "看", cwd: empty })).json as {
      agentId: string;
    };
    const emptyText = (await callTool(client, "read_agent", { agentId: inEmpty.agentId, includeDiff: true })).text;
    expect(emptyText).toContain("新.txt");
    expect(emptyText).not.toContain("读取改动失败");

    const plain = await h.createCaller({ cwd: h.dataDir });
    const notRepo = (await callTool(client, "read_agent", { agentId: plain.id, includeDiff: true })).text;
    expect(notRepo).toContain("不是 git 仓库");
    expect(notRepo).not.toContain("usage:");
  });

  test.skipIf(!hasGit)("includeDiff：派单会话已删除时以调用方为基线，提交不丢", async () => {
    const h = await createHarness();
    const repo = path.join(h.dataDir, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, windowsHide: true, stdio: "ignore" });
    git("init", "-q");
    writeFileSync(path.join(repo, "a.txt"), "1\n");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
    const dispatcher = await h.createCaller({ cwd: repo });
    const dispatcherClient = await h.connect(dispatcher.token);
    const { agentId, worktree } = (
      await callTool(dispatcherClient, "delegate", { provider: "fake", prompt: "改", worktree: true })
    ).json as { agentId: string; worktree: { path: string } };
    const inWorktree = (...args: string[]) =>
      execFileSync("git", args, { cwd: worktree.path, windowsHide: true, stdio: "ignore" });
    writeFileSync(path.join(worktree.path, "b.txt"), "2\n");
    inWorktree("add", "-A");
    inWorktree("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "加了b");

    const reviewer = await h.createCaller({ cwd: repo });
    const reviewerClient = await h.connect(reviewer.token);
    await h.manager.deleteAgent(dispatcher.id);
    const text = (await callTool(reviewerClient, "read_agent", { agentId, includeDiff: true })).text;
    expect(text).toContain("加了b");
    expect(text).not.toContain("同一工作区");
  });
});

describe("delegate 的模型与设置", () => {
  test("list_providers 传 provider 时返回模型与模式目录；未知 provider 报错", async () => {
    const h = await createHarness();
    const caller = await h.createCaller();
    const client = await h.connect(caller.token);
    const json = (await callTool(client, "list_providers", { provider: "fake" })).json as {
      id: string;
      models: Array<Record<string, unknown>>;
      modes: Array<Record<string, unknown>>;
    };
    expect(json.id).toBe("fake");
    expect(json.models[0]).toEqual({
      id: "fast",
      label: "快",
      isDefault: true,
      thinkingOptions: ["high"],
      defaultThinkingOptionId: "high",
    });
    expect(json.modes.find((mode) => mode.id === "danger")).toMatchObject({ dangerous: true });
    expect((await callTool(client, "list_providers", { provider: "nope" })).isError).toBe(true);
  });

  test("model / thinkingOptionId 传给新会话", async () => {
    const h = await createHarness();
    const caller = await h.createCaller();
    const client = await h.connect(caller.token);
    const { agentId } = (
      await callTool(client, "delegate", { provider: "fake", prompt: "x", model: "fast", thinkingOptionId: "high" })
    ).json as { agentId: string };
    expect(h.manager.getAgent(agentId)).toMatchObject({ model: "fast", thinkingOptionId: "high" });
    expect(h.sessionOf(agentId)!.cfg).toMatchObject({ model: "fast", thinkingOptionId: "high" });
  });

  test("权限模式：同 provider 继承，plan 不继承，显式传的优先", async () => {
    const h = await createHarness();
    const auto = await h.createCaller({ modeId: "auto" });
    const autoClient = await h.connect(auto.token);
    const inherited = (await callTool(autoClient, "delegate", { provider: "fake", prompt: "x" })).json as { agentId: string };
    expect(h.manager.getAgent(inherited.agentId).modeId).toBe("auto");
    const explicit = (await callTool(autoClient, "delegate", { provider: "fake", prompt: "x", modeId: "default" })).json as {
      agentId: string;
    };
    expect(h.manager.getAgent(explicit.agentId).modeId).toBe("default");

    const plan = await h.createCaller({ modeId: "plan" });
    const planChild = (await callTool(await h.connect(plan.token), "delegate", { provider: "fake", prompt: "x" })).json as {
      agentId: string;
    };
    expect(h.manager.getAgent(planChild.agentId).modeId).toBeNull();
  });

  test("不越权：只有调用方在危险模式时子会话才能用危险模式", async () => {
    const h = await createHarness();
    const normal = await h.createCaller({ modeId: "auto" });
    const denied = await callTool(await h.connect(normal.token), "delegate", {
      provider: "fake",
      prompt: "x",
      modeId: "danger",
    });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("不允许委派使用危险模式");

    const danger = await h.createCaller({ modeId: "danger" });
    const dangerClient = await h.connect(danger.token);
    const inherited = (await callTool(dangerClient, "delegate", { provider: "fake", prompt: "x" })).json as { agentId: string };
    expect(h.manager.getAgent(inherited.agentId).modeId).toBe("danger");
    const explicit = await callTool(dangerClient, "delegate", { provider: "fake", prompt: "x", modeId: "danger" });
    expect(explicit.isError).toBe(false);
  });
});

describe("send_to_agent / wait_agent / cancel_agent 的安全约束", () => {
  test("不能对自己调用；非子孙且未标记 interopTarget 的会话被拒；标记后放行", async () => {
    const h = await createHarness();
    const caller = await h.createCaller();
    const stranger = await h.createCaller();
    const client = await h.connect(caller.token);

    const self = await callTool(client, "send_to_agent", { agentId: caller.id, message: "x" });
    expect(self.isError).toBe(true);
    expect(self.text).toContain("不能向自己发送消息");
    expect((await callTool(client, "wait_agent", { agentId: caller.id })).text).toContain("不能等待自己");
    expect((await callTool(client, "cancel_agent", { agentId: caller.id })).text).toContain("不能中断自己");

    const denied = await callTool(client, "send_to_agent", { agentId: stranger.id, message: "你好" });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("允许被其它会话调用");
    expect((await callTool(client, "cancel_agent", { agentId: stranger.id })).isError).toBe(true);
    type Listed = { id: string; interopTarget: boolean; callable: boolean; updatedAt: string };
    const before = (await callTool(client, "list_agents")).json as Listed[];
    expect(before.find((a) => a.id === stranger.id)).toMatchObject({ interopTarget: false, callable: false });
    expect(before.find((a) => a.id === caller.id)?.callable).toBe(false);
    expect(Number.isNaN(Date.parse(before[0]!.updatedAt))).toBe(false);
    expect((await callTool(client, "list_agents", { callableOnly: true })).json).toEqual([]);

    await h.manager.updateAgent(stranger.id, { interopTarget: true });
    const callable = (await callTool(client, "list_agents", { callableOnly: true })).json as Listed[];
    expect(callable.map((a) => [a.id, a.interopTarget, a.callable])).toEqual([[stranger.id, true, true]]);
    const allowed = await callTool(client, "send_to_agent", { agentId: stranger.id, message: "你好" });
    expect(allowed.isError).toBe(false);
    expect((allowed.json as { reply: string }).reply).toBe("回答:你好");
  });

  test("向自己的子孙发消息：目标忙时返回「目标会话正在运行」，空闲时返回回复", async () => {
    const h = await createHarness();
    const caller = await h.createCaller();
    const client = await h.connect(caller.token);
    const child = (await callTool(client, "delegate", { provider: "fake", prompt: "hold:先忙着", wait: false }))
      .json as { agentId: string };

    const busy = await callTool(client, "send_to_agent", { agentId: child.agentId, message: "插一句" });
    expect(busy.isError).toBe(true);
    expect(busy.text).toContain("目标会话正在运行");

    h.sessions.at(-1)!.finish("忙完了");
    await h.manager.waitForIdle(child.agentId, 1000);
    const ok = (await callTool(client, "send_to_agent", { agentId: child.agentId, message: "第二句" })).json as {
      status: string;
      reply: string;
    };
    expect(ok).toMatchObject({ status: "completed", reply: "回答:第二句" });
  });

  test("孙会话（子孙）同样允许；等待上级会话被拒", async () => {
    const h = await createHarness();
    const root = await h.createCaller();
    const child = await h.createCaller({ parentAgentId: root.id });
    const grandchild = await h.createCaller({ parentAgentId: child.id });
    const rootClient = await h.connect(root.token);
    const viaRoot = await callTool(rootClient, "send_to_agent", { agentId: grandchild.id, message: "hi" });
    expect(viaRoot.isError).toBe(false);

    const grandClient = await h.connect(grandchild.token);
    const waitAncestor = await callTool(grandClient, "wait_agent", { agentId: root.id });
    expect(waitAncestor.isError).toBe(true);
    expect(waitAncestor.text).toContain("上级会话");
  });

  test("cancel_agent 中断子孙当前回合", async () => {
    const h = await createHarness();
    const caller = await h.createCaller();
    const client = await h.connect(caller.token);
    const child = (await callTool(client, "delegate", { provider: "fake", prompt: "hold:长任务", wait: false }))
      .json as { agentId: string };
    const callable = (await callTool(client, "list_agents", { callableOnly: true })).json as Array<{ id: string }>;
    expect(callable.map((a) => a.id)).toEqual([child.agentId]);
    const result = await callTool(client, "cancel_agent", { agentId: child.agentId });
    expect(result.isError).toBe(false);
    expect(h.sessions.at(-1)!.interrupts).toBe(1);
    expect(h.manager.getAgent(child.agentId).status).toBe("idle");
  });

  test("工具结果不含 token", async () => {
    const h = await createHarness();
    const caller = await h.createCaller();
    const client = await h.connect(caller.token);
    const outputs = [
      await callTool(client, "list_agents", { includeArchived: true }),
      await callTool(client, "list_providers"),
      await callTool(client, "delegate", { provider: "fake", prompt: "x" }),
      await callTool(client, "read_agent", { agentId: caller.id }),
    ];
    for (const output of outputs) {
      expect(output.text).not.toMatch(/adi_[0-9a-f]{16,}/);
    }
  });
});

describe.skipIf(!hasGit)("delegate worktree:true", () => {
  function initRepo(dir: string): void {
    const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    run("init");
    run("config", "user.email", "t@example.com");
    run("config", "user.name", "t");
    writeFileSync(path.join(dir, "a.txt"), "x\n");
    run("add", ".");
    run("commit", "-m", "init");
  }

  test("在 <dataDir>/worktrees 下建 worktree 与 agentdeck/delegate-<前 8 位> 分支，子会话 cwd 指向它", async () => {
    const h = await createHarness();
    const repo = path.join(h.dataDir, "repo");
    mkdirSync(repo);
    initRepo(repo);
    const caller = await h.createCaller({ cwd: repo });
    const client = await h.connect(caller.token);
    const json = (await callTool(client, "delegate", { provider: "fake", prompt: "改点东西", worktree: true }))
      .json as { agentId: string; status: string; worktree: { path: string; branch: string } };
    expect(json.status).toBe("completed");
    const short = json.agentId.slice(0, 8);
    expect(json.worktree.branch).toBe(`agentdeck/delegate-${short}`);
    expect(json.worktree.path).toBe(path.join(h.dataDir, "worktrees", `delegate-${short}`));
    expect(h.manager.getAgent(json.agentId).cwd).toBe(json.worktree.path);
    const branches = execFileSync("git", ["branch", "--list", json.worktree.branch], { cwd: repo }).toString();
    expect(branches).toContain(json.worktree.branch);
  });

  test("cwd 不在 git 仓库内 → 工具错误，且不创建子会话", async () => {
    const h = await createHarness();
    const plain = path.join(h.dataDir, "plain");
    mkdirSync(plain);
    const caller = await h.createCaller({ cwd: plain });
    const client = await h.connect(caller.token);
    const before = h.manager.listAgents().length;
    const result = await callTool(client, "delegate", { provider: "fake", prompt: "x", worktree: true });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("不在 git 仓库内");
    expect(h.manager.listAgents().length).toBe(before);
  });
});

describe("agent.update interopTarget 与持久化字段", () => {
  test("updateAgent 设置 interopTarget；origin / parentAgentId 写入快照", async () => {
    const h = await createHarness();
    const parent = await h.createCaller();
    const child = await h.manager.createAgent({
      provider: "fake",
      cwd: h.dataDir,
      parentAgentId: parent.id,
      origin: "delegate",
    });
    expect(child).toMatchObject({ parentAgentId: parent.id, origin: "delegate" });
    const updated = await h.manager.updateAgent(child.id, { interopTarget: true });
    expect(updated.interopTarget).toBe(true);
    expect(h.manager.getAgent(child.id).interopTarget).toBe(true);
  });
});

describe("等待上限", () => {
  test("缺省 600、上限 3600；调用方开启缓存保活时上限 3000（design.md 4.36）", () => {
    const plain = { cacheKeepAlive: false } as AgentSnapshot;
    const keepAlive = { cacheKeepAlive: true } as AgentSnapshot;
    expect(clampTimeoutSec(undefined, plain)).toBe(600);
    expect(clampTimeoutSec(undefined, keepAlive)).toBe(600);
    expect(clampTimeoutSec(5000, plain)).toBe(3600);
    expect(clampTimeoutSec(5000, undefined)).toBe(3600);
    expect(clampTimeoutSec(3600, keepAlive)).toBe(3000);
    expect(clampTimeoutSec(1200.7, keepAlive)).toBe(1200);
    expect(clampTimeoutSec(0.2, keepAlive)).toBe(1);
  });
});
