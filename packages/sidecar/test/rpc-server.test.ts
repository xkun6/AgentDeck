import type { AgentSnapshot, AgentStreamEvent } from "@agentdeck/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { AgentManager } from "../src/agent/agent-manager.js";
import { MockAgentClient } from "../src/providers/mock/index.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { RpcServer } from "../src/server/rpc-server.js";
import { connectExpectingRejection, RpcCallError, TestRpcClient } from "./rpc-test-client.js";

const TOKEN = "test-token-0123456789abcdef";
const VERSION = "9.9.9-test";

let server: RpcServer;
let manager: AgentManager;
let port: number;
let client: TestRpcClient;

function wsUrl(token: string | null = TOKEN): string {
  const query = token === null ? "" : `?token=${encodeURIComponent(token)}`;
  return `ws://127.0.0.1:${port}/rpc${query}`;
}

async function createAgent(model?: string): Promise<AgentSnapshot> {
  const { agent } = await client.call("agent.create", {
    provider: "mock",
    cwd: process.cwd(),
    ...(model ? { model } : {}),
  });
  return agent;
}

function assistantText(events: AgentStreamEvent[]): string {
  return events
    .map((e) => (e.type === "timeline" && e.item.type === "assistant_message" ? e.item.text : ""))
    .join("");
}

function toolCalls(events: AgentStreamEvent[]) {
  return events.flatMap((e) =>
    e.type === "timeline" && e.item.type === "tool_call" ? [e.item] : [],
  );
}

async function expectRpcError(promise: Promise<unknown>): Promise<RpcCallError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcCallError);
    return error as RpcCallError;
  }
  throw new Error("预期 RPC 调用失败，但成功了");
}

beforeEach(async () => {
  const registry = new ProviderRegistry([new MockAgentClient()]);
  manager = new AgentManager({ registry });
  server = new RpcServer({ token: TOKEN, version: VERSION, manager, registry });
  port = await server.listen(0);
  client = await TestRpcClient.connect(wsUrl());
});

afterEach(async () => {
  await client.close();
  await manager.shutdown();
  await server.close();
});

describe("鉴权与 HTTP", () => {
  test("错误 token 被 401 拒绝", async () => {
    await expect(connectExpectingRejection(wsUrl("wrong-token"))).resolves.toBe(401);
  });

  test("缺少 token 被 401 拒绝", async () => {
    await expect(connectExpectingRejection(wsUrl(null))).resolves.toBe(401);
  });

  test("非 /rpc 路径被 404 拒绝", async () => {
    await expect(
      connectExpectingRejection(`ws://127.0.0.1:${port}/other?token=${TOKEN}`),
    ).resolves.toBe(404);
  });

  test("GET /health 无需 token", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, version: VERSION });
  });
});

describe("基础方法", () => {
  test("sidecar.info 返回版本与 pid", async () => {
    await expect(client.call("sidecar.info")).resolves.toEqual({
      version: VERSION,
      pid: process.pid,
    });
  });

  test("provider.list 含可用的 mock", async () => {
    const providers = await client.call("provider.list");
    expect(providers).toContainEqual({
      id: "mock",
      kind: "mock",
      label: "Mock Agent",
      available: true,
    });
  });

  test("provider.listModels 返回 mock 模型与模式", async () => {
    const catalog = await client.call("provider.listModels", { provider: "mock" });
    expect(catalog.models.map((m) => m.id)).toEqual(["mock-fast", "mock-slow"]);
    expect(catalog.models.find((m) => m.isDefault)?.id).toBe("mock-fast");
    expect(catalog.modes.map((m) => m.id)).toEqual(["default", "plan"]);
  });

  test("未知 provider 返回 PROVIDER_NOT_FOUND", async () => {
    const error = await expectRpcError(
      client.call("agent.create", { provider: "nope", cwd: process.cwd() }),
    );
    expect(error.error.code).toBe(-32000);
    expect(error.error.data?.code).toBe("PROVIDER_NOT_FOUND");
  });
});

describe("mock 会话", () => {
  test("create → send → 收齐 stream 直到 turn_completed", async () => {
    const agent = await createAgent();
    expect(agent).toMatchObject({ provider: "mock", status: "idle", pendingPermissions: [] });
    expect(agent.availableModes?.map((m) => m.id)).toEqual(["default", "plan"]);

    const prompt = "你好，请写一段很长的测试回复以便分成多段";
    const { turnId } = await client.call("agent.send", {
      agentId: agent.id,
      prompt,
      clientMessageId: "c-1",
    });
    const end = await client.waitForTurnEnd(agent.id);
    expect(end).toMatchObject({ type: "turn_completed", turnId });

    const envelopes = client.streams.filter((s) => s.agentId === agent.id);
    expect(envelopes.map((s) => s.seq)).toEqual(envelopes.map((_, i) => i + 1));
    expect(new Set(envelopes.map((s) => s.epoch))).toEqual(new Set([manager.epoch]));

    const events = envelopes.map((s) => s.event);
    expect(events[0]).toEqual({
      type: "timeline",
      item: { type: "user_message", text: prompt, clientMessageId: "c-1" },
    });
    const types = events.map((e) => e.type);
    expect(types.indexOf("thread_started")).toBeLessThan(types.indexOf("turn_started"));
    expect(types.at(-1)).toBe("turn_completed");
    expect(types).toContain("usage_updated");
    expect(assistantText(events)).toBe(`Mock 回复：${prompt}`);
    expect(
      events.some((e) => e.type === "timeline" && e.item.type === "reasoning"),
    ).toBe(true);

    const tools = toolCalls(events);
    expect(tools.at(-1)).toMatchObject({
      name: "shell",
      status: "completed",
      detail: { type: "shell", command: `echo ${Array.from(prompt).slice(0, 20).join("")}` },
    });

    // agent.state：running → idle
    const statuses = client.states.filter((s) => s.id === agent.id).map((s) => s.status);
    expect(statuses).toContain("running");
    await client.waitFor(
      () => client.states.filter((s) => s.id === agent.id).at(-1)?.status === "idle",
    );
    const [listed] = (await client.call("agent.list")).agents;
    expect(listed).toMatchObject({
      id: agent.id,
      status: "idle",
      activeTurnId: null,
      persistence: { provider: "mock" },
    });
    expect(listed!.lastUsage?.outputTokens).toBeGreaterThan(0);
  });

  test("忙时再 send 返回 TURN_IN_PROGRESS", async () => {
    const agent = await createAgent("mock-slow");
    await client.call("agent.send", { agentId: agent.id, prompt: "第一轮" });
    const error = await expectRpcError(
      client.call("agent.send", { agentId: agent.id, prompt: "第二轮" }),
    );
    expect(error.error.code).toBe(-32000);
    expect(error.error.data?.code).toBe("TURN_IN_PROGRESS");
    await client.call("agent.cancel", { agentId: agent.id });
  });

  test("/approve + allow：permission_requested → respond → 完成", async () => {
    const agent = await createAgent();
    await client.call("agent.send", { agentId: agent.id, prompt: "/approve 跑个命令" });
    const requested = await client.waitForEvent(agent.id, "permission_requested");
    expect(requested.request).toMatchObject({
      provider: "mock",
      kind: "tool",
      actions: [
        { id: "allow", label: "允许一次", behavior: "allow" },
        { id: "deny", label: "拒绝", behavior: "deny" },
      ],
    });
    await client.waitFor(
      () =>
        client.states.filter((s) => s.id === agent.id).at(-1)?.pendingPermissions.length === 1,
    );

    await client.call("agent.permission.respond", {
      agentId: agent.id,
      requestId: requested.request.id,
      response: { behavior: "allow", selectedActionId: "allow" },
    });
    const end = await client.waitForTurnEnd(agent.id);
    expect(end.type).toBe("turn_completed");

    const events = client.eventsFor(agent.id);
    expect(
      events.filter((e) => e.type === "permission_resolved" && e.requestId === requested.request.id),
    ).toHaveLength(1);
    expect(toolCalls(events).at(-1)?.status).toBe("completed");
    expect(assistantText(events)).toBe("Mock 回复：/approve 跑个命令");
    const [listed] = (await client.call("agent.list")).agents;
    expect(listed!.pendingPermissions).toEqual([]);
  });

  test("/approve + deny：tool_call 置 failed 并 turn_completed", async () => {
    const agent = await createAgent();
    await client.call("agent.send", { agentId: agent.id, prompt: "/approve 删库" });
    const requested = await client.waitForEvent(agent.id, "permission_requested");
    await client.call("agent.permission.respond", {
      agentId: agent.id,
      requestId: requested.request.id,
      response: { behavior: "deny", message: "不行" },
    });
    const end = await client.waitForTurnEnd(agent.id);
    expect(end.type).toBe("turn_completed");
    const events = client.eventsFor(agent.id);
    expect(toolCalls(events)).toEqual([expect.objectContaining({ status: "failed", error: "不行" })]);
    expect(assistantText(events)).toBe("");
  });

  test("respond 不存在的权限请求返回 PERMISSION_NOT_FOUND", async () => {
    const agent = await createAgent();
    const error = await expectRpcError(
      client.call("agent.permission.respond", {
        agentId: agent.id,
        requestId: "missing",
        response: { behavior: "allow" },
      }),
    );
    expect(error.error.data?.code).toBe("PERMISSION_NOT_FOUND");
  });

  test("/fail 发 turn_failed 并记录 lastError", async () => {
    const agent = await createAgent();
    await client.call("agent.send", { agentId: agent.id, prompt: "/fail" });
    const end = await client.waitForTurnEnd(agent.id);
    expect(end).toMatchObject({ type: "turn_failed", code: "MOCK_FAILURE" });
    const [listed] = (await client.call("agent.list")).agents;
    expect(listed).toMatchObject({ status: "idle", lastError: expect.stringContaining("/fail") });
  });

  test("agent.cancel → turn_canceled", async () => {
    const agent = await createAgent("mock-slow");
    const { turnId } = await client.call("agent.send", { agentId: agent.id, prompt: "慢慢来" });
    await client.waitForEvent(agent.id, "turn_started");
    await client.call("agent.cancel", { agentId: agent.id });
    const end = await client.waitForTurnEnd(agent.id);
    expect(end).toMatchObject({ type: "turn_canceled", turnId });
    const [listed] = (await client.call("agent.list")).agents;
    expect(listed).toMatchObject({ status: "idle", activeTurnId: null });

    // 取消后可以开始新一轮
    await client.call("agent.setModel", { agentId: agent.id, modelId: "mock-fast" });
    await client.call("agent.send", { agentId: agent.id, prompt: "再来" });
    await expect(client.waitForTurnEnd(agent.id, 2)).resolves.toMatchObject({
      type: "turn_completed",
    });
  });

  test("agent.timeline { sinceSeq } 只返回之后的条目", async () => {
    const agent = await createAgent();
    await client.call("agent.send", { agentId: agent.id, prompt: "timeline" });
    await client.waitForTurnEnd(agent.id);

    const all = await client.call("agent.timeline", { agentId: agent.id });
    expect(all.epoch).toBe(manager.epoch);
    expect(all.entries).toEqual(client.streams.filter((s) => s.agentId === agent.id));

    const tail = await client.call("agent.timeline", { agentId: agent.id, sinceSeq: 3 });
    expect(tail.entries.length).toBe(all.entries.length - 3);
    expect(tail.entries[0]?.seq).toBe(4);
    expect(tail.entries.every((e) => e.seq > 3)).toBe(true);
  });

  test("setModel / setMode 更新快照并推送事件", async () => {
    const agent = await createAgent();
    const { agent: afterModel } = await client.call("agent.setModel", {
      agentId: agent.id,
      modelId: "mock-slow",
    });
    expect(afterModel.model).toBe("mock-slow");
    const { agent: afterMode } = await client.call("agent.setMode", {
      agentId: agent.id,
      modeId: "plan",
    });
    expect(afterMode.modeId).toBe("plan");
    const events = client.eventsFor(agent.id);
    expect(events).toEqual([
      { type: "model_changed", modelId: "mock-slow" },
      { type: "mode_changed", modeId: "plan" },
    ]);
  });

  test("agent.close 置 closed，之后 send 返回 AGENT_CLOSED", async () => {
    const agent = await createAgent();
    await client.call("agent.close", { agentId: agent.id });
    await client.waitFor(
      () => client.states.filter((s) => s.id === agent.id).at(-1)?.status === "closed",
    );
    const error = await expectRpcError(
      client.call("agent.send", { agentId: agent.id, prompt: "hi" }),
    );
    expect(error.error.data?.code).toBe("AGENT_CLOSED");
  });

  test("close 后再 send：mock 可恢复时自动恢复并完成一轮", async () => {
    const agent = await createAgent();
    await client.call("agent.send", { agentId: agent.id, prompt: "一" });
    await client.waitForTurnEnd(agent.id, 1);
    await client.call("agent.close", { agentId: agent.id });
    await client.call("agent.send", { agentId: agent.id, prompt: "二" });
    await expect(client.waitForTurnEnd(agent.id, 2)).resolves.toMatchObject({
      type: "turn_completed",
    });
    const statuses = client.states.filter((s) => s.id === agent.id).map((s) => s.status);
    expect(statuses.slice(statuses.indexOf("closed"))).toEqual(
      expect.arrayContaining(["closed", "starting", "idle", "running"]),
    );
  });

  test("agent.delete 广播 agent.removed，之后查询返回 AGENT_NOT_FOUND", async () => {
    const agent = await createAgent();
    await expect(client.call("agent.delete", { agentId: agent.id })).resolves.toEqual({});
    await client.waitFor(() => client.removed.includes(agent.id));
    expect((await client.call("agent.list")).agents).toEqual([]);
    const error = await expectRpcError(client.call("agent.timeline", { agentId: agent.id }));
    expect(error.error.data?.code).toBe("AGENT_NOT_FOUND");
    const invalid = await client.request("agent.delete", { agentId: "" });
    expect(invalid.error?.code).toBe(-32602);
  });

  test("未知 agent 返回 AGENT_NOT_FOUND", async () => {
    const error = await expectRpcError(client.call("agent.timeline", { agentId: "missing" }));
    expect(error.error.data?.code).toBe("AGENT_NOT_FOUND");
  });
});

describe("JSON-RPC 错误码", () => {
  test("未知方法 -32601", async () => {
    const response = await client.request("agent.nope", {});
    expect(response.error?.code).toBe(-32601);
  });

  test("参数错误 -32602", async () => {
    const missingPrompt = await client.request("agent.send", { agentId: "x" });
    expect(missingPrompt.error?.code).toBe(-32602);
    const badType = await client.request("agent.timeline", { agentId: "x", sinceSeq: "1" });
    expect(badType.error?.code).toBe(-32602);
    const badResponse = await client.request("agent.permission.respond", {
      agentId: "x",
      requestId: "r",
      response: { behavior: "maybe" },
    });
    expect(badResponse.error?.code).toBe(-32602);
  });

  test("解析错误 -32700", async () => {
    const response = await client.sendRaw("{not json");
    expect(response).toMatchObject({ id: null, error: { code: -32700 } });
  });

  test("非法请求与批量请求 -32600", async () => {
    const invalid = await client.sendRaw(JSON.stringify({ jsonrpc: "1.0", id: 7, method: "x" }));
    expect(invalid).toMatchObject({ id: 7, error: { code: -32600 } });
    const batch = await client.sendRaw(
      JSON.stringify([{ jsonrpc: "2.0", id: 8, method: "sidecar.info" }]),
    );
    expect(batch).toMatchObject({ id: null, error: { code: -32600 } });
  });
});
