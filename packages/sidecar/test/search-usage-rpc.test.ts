import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { AgentManager } from "../src/agent/agent-manager.js";
import { MockAgentClient } from "../src/providers/mock/index.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { RpcServer } from "../src/server/rpc-server.js";
import { UsageLedger } from "../src/usage/ledger.js";
import { RpcCallError, TestRpcClient } from "./rpc-test-client.js";

const TOKEN = "test-token-0123456789abcdef";

let server: RpcServer;
let client: TestRpcClient;

beforeEach(async () => {
  const registry = new ProviderRegistry([new MockAgentClient()]);
  const usage = new UsageLedger();
  const manager = new AgentManager({ registry, usage });
  server = new RpcServer({ token: TOKEN, version: "t", manager, registry, usage });
  const port = await server.listen(0);
  client = await TestRpcClient.connect(`ws://127.0.0.1:${port}/rpc?token=${TOKEN}`);
});

afterEach(async () => {
  client.close();
  await server.close();
});

async function paramsError(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    return (error as RpcCallError).error.code;
  }
  throw new Error("预期失败");
}

describe("agent.search / usage.summary", () => {
  test("query 与 limit 校验为 -32602", async () => {
    expect(await paramsError(client.call("agent.search", { query: "   " }))).toBe(-32602);
    expect(await paramsError(client.call("agent.search", { query: "x".repeat(201) }))).toBe(-32602);
    expect(await paramsError(client.call("agent.search", { query: "a", limit: 501 }))).toBe(-32602);
  });

  test("发送消息后能搜到用户消息，并记入用量", async () => {
    const { agent } = await client.call("agent.create", { provider: "mock", cwd: process.cwd() });
    await client.call("agent.send", { agentId: agent.id, prompt: "独特关键词 Zebra" });
    await client.waitForTurnEnd(agent.id);

    const { hits, truncated } = await client.call("agent.search", { query: "zebra" });
    expect(truncated).toBe(false);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.every((hit) => hit.agentId === agent.id)).toBe(true);
    expect(hits.some((hit) => hit.role === "user")).toBe(true);
    const none = await client.call("agent.search", { query: "zebra", agentIds: ["other"] });
    expect(none.hits).toEqual([]);

    const summary = await client.call("usage.summary", undefined);
    expect(summary.backfilling).toBe(false);
    expect(summary.totals.turns).toBe(1);
    expect(summary.byProvider[0]).toMatchObject({ provider: "mock", turns: 1 });
    expect(summary.topAgents[0]).toMatchObject({ agentId: agent.id, deleted: false });
  });
});
