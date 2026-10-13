import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { AgentManager } from "../src/agent/agent-manager.js";
import { MockAgentClient } from "../src/providers/mock/index.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { ScheduleStore } from "../src/scheduler/store.js";
import { RpcServer } from "../src/server/rpc-server.js";
import { RpcCallError, TestRpcClient } from "./rpc-test-client.js";

const TOKEN = "test-token-0123456789abcdef";

let server: RpcServer;
let client: TestRpcClient;
let scheduler: Scheduler;

beforeEach(async () => {
  const registry = new ProviderRegistry([new MockAgentClient()]);
  const manager = new AgentManager({ registry });
  scheduler = new Scheduler({ manager, store: new ScheduleStore() });
  await scheduler.start();
  server = new RpcServer({ token: TOKEN, version: "t", manager, registry, scheduler });
  const port = await server.listen(0);
  client = await TestRpcClient.connect(`ws://127.0.0.1:${port}/rpc?token=${TOKEN}`);
});

afterEach(async () => {
  await client.close();
  await server.close();
  await scheduler.stop();
});

async function errorCode(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    return (error as RpcCallError).error.code;
  }
  throw new Error("预期失败");
}

describe("schedule.* RPC", () => {
  test("list 初始为空；upsert 校验失败为 -32602（cron 非法 / 目标缺失）", async () => {
    expect(await client.call("schedule.list")).toEqual({ schedules: [], paused: false });
    const bad = {
      kind: "cron" as const,
      name: "x",
      trigger: { cron: "not a cron" },
      target: { type: "agent" as const, agentId: "a" },
      prompt: "p",
      onBusy: "skip" as const,
    };
    expect(await errorCode(client.call("schedule.upsert", { schedule: bad }))).toBe(-32602);
    expect(
      await errorCode(client.call("schedule.upsert", { schedule: { ...bad, trigger: { cron: "* * * * *" }, name: "" } })),
    ).toBe(-32602);
    // 目标会话不存在 → 业务错误 AGENT_NOT_FOUND
    const response = await client.request("schedule.upsert", {
      schedule: { ...bad, trigger: { cron: "* * * * *" } },
    });
    expect(response.error).toMatchObject({ code: -32000, data: { code: "AGENT_NOT_FOUND" } });
  });

  test("upsert / list / setPaused / runs / delete 全流程，并广播 schedule.changed", async () => {
    const { agent } = await client.call("agent.create", { provider: "mock", cwd: process.cwd() });
    const { schedule } = await client.call("schedule.upsert", {
      schedule: {
        kind: "cron",
        name: "每小时",
        trigger: { cron: "0 * * * *" },
        target: { type: "agent", agentId: agent.id },
        prompt: "巡检",
        onBusy: "skip",
      },
    });
    expect(schedule).toMatchObject({ kind: "cron", name: "每小时", enabled: true });
    expect(schedule.id).toBeTruthy();
    await client.waitFor(() => client.notifications.some((n) => n.method === "schedule.changed"));

    expect((await client.call("schedule.list")).schedules).toHaveLength(1);
    expect(await client.call("schedule.setPaused", { paused: true })).toEqual({ paused: true });
    expect((await client.call("schedule.list")).paused).toBe(true);

    // runNow 不受暂停影响，向目标会话发出一轮
    await client.call("schedule.runNow", { id: schedule.id });
    await client.waitForTurnEnd(agent.id);
    const { runs } = await client.call("schedule.runs", { id: schedule.id });
    expect(runs).toMatchObject([{ scheduleId: schedule.id, outcome: "sent", agentId: agent.id }]);
    expect(await errorCode(client.call("schedule.runs", { limit: 0 }))).toBe(-32602);

    await client.call("schedule.delete", { id: schedule.id });
    expect((await client.call("schedule.list")).schedules).toEqual([]);
    expect(await errorCode(client.call("schedule.runNow", { id: "nope" }))).toBe(-32602);
    expect(await errorCode(client.call("schedule.delete", { id: "nope" }))).toBe(-32602);
  });

  test("目标循环完成时广播 schedule.notice", async () => {
    const { agent } = await client.call("agent.create", { provider: "mock", cwd: process.cwd() });
    const { schedule } = await client.call("schedule.upsert", {
      schedule: { kind: "goal", name: "目标", agentId: agent.id, goal: "x", maxIterations: 1 },
    });
    // mock 会回显 prompt（含 GOAL_DONE 的提示文本末行是「…输出 GOAL_DONE。」，不等于 marker），因此一轮后 exhausted
    await client.waitFor(() => client.notifications.some((n) => n.method === "schedule.notice"));
    const notice = client.notifications.find((n) => n.method === "schedule.notice")!.params;
    expect(notice).toMatchObject({ scheduleId: schedule.id, kind: "exhausted" });
  });
});
