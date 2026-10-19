// 会话互通 MCP 端点（design.md 4.26）：鉴权、tools/list、各工具成功与安全约束失败路径、worktree 委派
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AgentPermissionRequest,
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
  INTEROP_MAX_RUNNING_CHILDREN,
  lastAssistantText,
  McpInteropEndpoint,
} from "../src/server/mcp-interop.js";
import { RpcServer } from "../src/server/rpc-server.js";
import { SettingsStore } from "../src/settings/sidecar-settings.js";
import { locateGit } from "../src/snapshots/git.js";

const hasGit = (await locateGit()) !== null;

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
  createCaller(opts?: { cwd?: string; parentAgentId?: string }): Promise<{ id: string; token: string }>;
  /** 用某会话的 token 连上 MCP 端点 */
  connect(token: string): Promise<Client>;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function createHarness(): Promise<Harness> {
  const sessions: ScriptedSession[] = [];
  const fakeClient: AgentClient = {
    provider: "fake",
    kind: "mock",
    label: "Fake",
    isAvailable: async () => ({ available: true }),
    fetchCatalog: async () => ({
      models: [],
      modes: [
        { id: "default", label: "默认" },
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
  const mcp = new McpInteropEndpoint({ manager, registry, interop, dataDir });
  const server = new RpcServer({ token: "rpc-token", version: "test", manager, registry, settings, mcp });
  const port = await server.listen(0, "127.0.0.1");
  interop.setPort(port);
  cleanups.push(async () => {
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
      });
      const endpoint = interop.endpointFor(agent.id);
      return { id: agent.id, token: endpoint!.token };
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
    expect(body.result.tools.length).toBe(7);
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
  test("tools/list 返回 7 个工具", async () => {
    const h = await createHarness();
    const caller = await h.createCaller();
    const client = await h.connect(caller.token);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      ["cancel_agent", "delegate", "list_agents", "list_providers", "read_agent", "send_to_agent", "wait_agent"],
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
