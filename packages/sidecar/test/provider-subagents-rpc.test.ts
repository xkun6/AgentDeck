// agent.subagents.list / agent.subagents.timeline / agent.subagents.update 与会话关闭时的清理（design.md 4.11）
import type { ProviderSubagentUpdate } from "@agentdeck/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { AgentManager } from "../src/agent/agent-manager.js";
import type {
  AgentSession,
  AgentSessionConfig,
  AgentSessionEvent,
  ProviderSubagentInputEvent,
} from "../src/agent/types.js";
import { MockAgentClient } from "../src/providers/mock/index.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { RpcServer } from "../src/server/rpc-server.js";
import { RpcCallError, TestRpcClient } from "./rpc-test-client.js";

const TOKEN = "test-token-0123456789abcdef";

/** 包一层 mock 会话：测试可直接推送 provider_subagent 内部事件 */
class SubagentTestClient extends MockAgentClient {
  readonly pushers: Array<(event: ProviderSubagentInputEvent) => void> = [];

  override async createSession(cfg: AgentSessionConfig): Promise<AgentSession> {
    const session = await super.createSession(cfg);
    const listeners = new Set<(event: AgentSessionEvent) => void>();
    const subscribe = session.subscribe.bind(session);
    session.subscribe = (cb) => {
      listeners.add(cb);
      const off = subscribe(cb);
      return () => {
        listeners.delete(cb);
        off();
      };
    };
    this.pushers.push((event) => {
      for (const listener of listeners) listener({ type: "provider_subagent", event });
    });
    return session;
  }
}

let server: RpcServer;
let manager: AgentManager;
let client: TestRpcClient;
let provider: SubagentTestClient;

function subagentUpdates(): ProviderSubagentUpdate[] {
  return client.notifications
    .filter((n) => n.method === "agent.subagents.update")
    .map((n) => n.params as ProviderSubagentUpdate);
}

beforeEach(async () => {
  provider = new SubagentTestClient();
  const registry = new ProviderRegistry([provider]);
  manager = new AgentManager({ registry });
  server = new RpcServer({ token: TOKEN, version: "9.9.9-test", manager, registry });
  const port = await server.listen(0);
  client = await TestRpcClient.connect(`ws://127.0.0.1:${port}/rpc?token=${TOKEN}`);
});

afterEach(async () => {
  await client.close();
  await manager.shutdown();
  await server.close();
});

describe("provider 子代理 RPC", () => {
  test("upsert / timeline 广播 agent.subagents.update；list 与 timeline 分页读取", async () => {
    const { agent } = await client.call("agent.create", { provider: "mock", cwd: process.cwd() });
    const push = provider.pushers[0]!;
    push({ type: "upsert", id: "sub-1", title: "Explore", toolCallId: "toolu_1" });
    for (let i = 1; i <= 3; i += 1) {
      push({ type: "timeline", id: "sub-1", item: { type: "assistant_message", text: `第${i}段` } });
    }
    push({ type: "upsert", id: "sub-1", status: "completed" });

    await client.waitFor(() => subagentUpdates().length === 5);
    const updates = subagentUpdates();
    expect(updates[0]).toMatchObject({
      kind: "upsert",
      agentId: agent.id,
      subagent: { id: "sub-1", parentAgentId: agent.id, provider: "mock", title: "Explore", status: "running" },
    });
    expect(updates[1]).toMatchObject({ kind: "timeline", agentId: agent.id, subagentId: "sub-1", row: { seq: 1 } });
    // 只带 status 的 upsert 保留标题
    expect(updates[4]).toMatchObject({ kind: "upsert", subagent: { title: "Explore", status: "completed" } });

    const { subagents } = await client.call("agent.subagents.list", { agentId: agent.id });
    expect(subagents.map((s) => [s.id, s.status, s.toolCallId])).toEqual([["sub-1", "completed", "toolu_1"]]);

    const tail = await client.call("agent.subagents.timeline", { agentId: agent.id, subagentId: "sub-1", limit: 2 });
    expect(tail.rows.map((r) => r.seq)).toEqual([2, 3]);
    expect(tail).toMatchObject({ hasOlder: true, hasNewer: false });
    const older = await client.call("agent.subagents.timeline", {
      agentId: agent.id,
      subagentId: "sub-1",
      direction: "before",
      cursorSeq: 2,
    });
    expect(older.rows.map((r) => r.item)).toEqual([{ type: "assistant_message", text: "第1段" }]);
    expect(older.hasOlder).toBe(false);
  });

  test("参数校验与未知会话报错", async () => {
    await expect(client.call("agent.subagents.list", { agentId: "nope" })).rejects.toBeInstanceOf(RpcCallError);
    const { agent } = await client.call("agent.create", { provider: "mock", cwd: process.cwd() });
    const bad = await client.request("agent.subagents.timeline", {
      agentId: agent.id,
      subagentId: "x",
      direction: "sideways",
    });
    expect(bad.error).toBeTruthy();
    const empty = await client.call("agent.subagents.timeline", { agentId: agent.id, subagentId: "x" });
    expect(empty).toEqual({ rows: [], hasOlder: false, hasNewer: false });
  });

  test("关闭会话清空其子代理并广播 remove", async () => {
    const { agent } = await client.call("agent.create", { provider: "mock", cwd: process.cwd() });
    provider.pushers[0]!({ type: "upsert", id: "sub-1" });
    provider.pushers[0]!({ type: "upsert", id: "sub-2", parentSubagentId: "sub-1" });
    await client.waitFor(() => subagentUpdates().length === 2);

    await client.call("agent.close", { agentId: agent.id });
    await client.waitFor(() => subagentUpdates().filter((u) => u.kind === "remove").length === 2);
    expect(
      subagentUpdates()
        .filter((u) => u.kind === "remove")
        .map((u) => (u.kind === "remove" ? u.subagentId : ""))
        .sort(),
    ).toEqual(["sub-1", "sub-2"]);
    expect(manager.listSubagents(agent.id)).toEqual([]);
  });
});
