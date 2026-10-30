import type { AgentSnapshot } from "@agentdeck/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { AgentManagerListener } from "../src/agent/agent-manager.js";
import { AgentRpcError } from "../src/agent/errors.js";
import { InteropReports } from "../src/server/interop-reports.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function snapshot(id: string, patch: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return { id, status: "idle", activeTurnId: null, ...patch } as AgentSnapshot;
}

function createHarness() {
  const agents = new Map<string, AgentSnapshot>();
  const listeners = new Set<AgentManagerListener>();
  const sendPrompt = vi.fn(async () => ({ turnId: "t" }));
  const reports = new InteropReports({
    manager: {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getAgent(id) {
        const agent = agents.get(id);
        if (!agent) throw new Error("not found");
        return agent;
      },
      sendPrompt,
    },
    describeTurn: async (agentId) => `回传:${agentId}`,
    settleMs: 10,
  });
  stops.push(() => reports.stop());
  const set = (id: string, patch: Partial<AgentSnapshot> = {}) => {
    const next = snapshot(id, patch);
    agents.set(id, next);
    for (const listener of listeners) listener.onState?.(next);
  };
  return { reports, set, sendPrompt, agents, listeners };
}

const stops: Array<() => void> = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

describe("InteropReports", () => {
  test("后台任务运行期间不回传，结束并稳定后才回传", async () => {
    const h = createHarness();
    h.set("parent");
    h.set("child", { status: "running", activeTurnId: "t1" });
    h.reports.expect("child", "parent", 0);

    h.set("child", { backgroundActive: true });
    await sleep(40);
    expect(h.sendPrompt).not.toHaveBeenCalled();

    h.set("child");
    await vi.waitUntil(() => h.sendPrompt.mock.calls.length === 1, { timeout: 1000 });
    expect(h.sendPrompt).toHaveBeenCalledWith("parent", "回传:child", undefined, { internal: true });
  });

  test("稳定时间内又开始新回合（CLI 自发轮次）：等新回合结束后才回传", async () => {
    const h = createHarness();
    h.set("parent");
    h.set("child", { status: "running", activeTurnId: "t1" });
    h.reports.expect("child", "parent", 0);

    h.set("child");
    h.set("child", { status: "running", activeTurnId: "t2" });
    await sleep(40);
    expect(h.sendPrompt).not.toHaveBeenCalled();

    h.set("child");
    await vi.waitUntil(() => h.sendPrompt.mock.calls.length === 1, { timeout: 1000 });
  });

  test("会话被关闭或休眠：放弃回传", async () => {
    const h = createHarness();
    h.set("parent");
    h.set("child", { status: "running", activeTurnId: "t1" });
    h.reports.expect("child", "parent", 0);
    h.set("child", { status: "closed" });
    await sleep(40);
    expect(h.sendPrompt).not.toHaveBeenCalled();
  });

  test("发送时遇到 TURN_IN_PROGRESS：放回队列，下一次空闲重发", async () => {
    const h = createHarness();
    h.set("parent");
    h.sendPrompt.mockRejectedValueOnce(new AgentRpcError("TURN_IN_PROGRESS", "忙"));
    h.reports.enqueue("parent", "child", "内容");
    await vi.waitUntil(() => h.sendPrompt.mock.calls.length === 1, { timeout: 1000 });
    await sleep(30);
    expect(h.sendPrompt).toHaveBeenCalledTimes(1);

    h.set("parent", { status: "running", activeTurnId: "x" });
    h.set("parent");
    await vi.waitUntil(() => h.sendPrompt.mock.calls.length === 2, { timeout: 1000 });
    expect(h.sendPrompt).toHaveBeenLastCalledWith("parent", "内容", undefined, { internal: true });
  });

  test("stop 后不再投递，也不再监听", async () => {
    const h = createHarness();
    h.set("parent");
    h.reports.enqueue("parent", "child", "内容");
    h.reports.stop();
    await sleep(40);
    expect(h.sendPrompt).not.toHaveBeenCalled();
    expect(h.listeners.size).toBe(0);
  });
});
