import type { AgentSnapshot } from "@agentdeck/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { AgentManagerListener } from "../src/agent/agent-manager.js";
import { AgentRpcError } from "../src/agent/errors.js";
import { InteropReports, REPORT_MAX_RETRIES } from "../src/server/interop-reports.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function snapshot(id: string, patch: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return { id, status: "idle", activeTurnId: null, ...patch } as AgentSnapshot;
}

function createHarness(opts: { describeTurn?: (agentId: string) => Promise<string> } = {}) {
  const agents = new Map<string, AgentSnapshot>();
  const listeners = new Set<AgentManagerListener>();
  // 同真实实现：返回时快照已是 running
  const sendPrompt = vi.fn(async (agentId: string, _prompt?: unknown, _id?: unknown, _opts?: unknown) => {
    set(agentId, { status: "running", activeTurnId: "t" });
    return { turnId: "t" };
  });
  const reclaimIfIdle = vi.fn(async () => true);
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
      reclaimIfIdle,
    },
    describeTurn: opts.describeTurn ?? (async (agentId) => `回传:${agentId}`),
    settleMs: 10,
    retryMs: 10,
  });
  stops.push(() => reports.stop());
  const set = (id: string, patch: Partial<AgentSnapshot> = {}) => {
    const next = snapshot(id, patch);
    agents.set(id, next);
    for (const listener of listeners) listener.onState?.(next);
  };
  return { reports, set, sendPrompt, reclaimIfIdle, agents, listeners };
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

  test("回传入队后回收干活的会话；派单方等到结果时也回收；stop 后不回收", async () => {
    const h = createHarness();
    h.set("parent");
    h.set("child", { status: "running", activeTurnId: "t1" });
    h.reports.expect("child", "parent", 0);
    h.set("child");
    await vi.waitUntil(() => h.reclaimIfIdle.mock.calls.length === 1, { timeout: 1000 });
    expect(h.reclaimIfIdle).toHaveBeenCalledWith("child");

    h.set("waited", { status: "running", activeTurnId: "t2" });
    h.reports.expect("waited", "parent", 0);
    h.set("waited");
    h.reports.settleWaited("waited", "parent");
    await vi.waitUntil(() => h.reclaimIfIdle.mock.calls.length === 2, { timeout: 1000 });
    expect(h.reclaimIfIdle).toHaveBeenLastCalledWith("waited");

    h.set("late");
    h.reports.settleWaited("late", "parent");
    h.reports.stop();
    await sleep(40);
    expect(h.reclaimIfIdle).toHaveBeenCalledTimes(2);
  });

  test("干活的会话派出的任务未结束：不算完成，不回传也不回收；任务回传并处理后才向上回传", async () => {
    const h = createHarness();
    h.set("top");
    h.set("worker", { status: "running", activeTurnId: "t1" });
    h.set("sub", { status: "running", activeTurnId: "s1" });
    h.reports.expect("worker", "top", 0);
    h.reports.expect("sub", "worker", 0);

    h.set("worker");
    await sleep(40);
    expect(h.sendPrompt).not.toHaveBeenCalled();
    expect(h.reclaimIfIdle).not.toHaveBeenCalled();

    h.set("sub");
    await vi.waitUntil(() => h.sendPrompt.mock.calls.length === 1, { timeout: 1000 });
    expect(h.sendPrompt).toHaveBeenLastCalledWith("worker", "回传:sub", undefined, { internal: true });
    expect(h.reclaimIfIdle).toHaveBeenCalledWith("sub");
    expect(h.reclaimIfIdle).not.toHaveBeenCalledWith("worker");

    h.set("worker", { status: "running", activeTurnId: "t2" });
    h.set("worker");
    await vi.waitUntil(() => h.sendPrompt.mock.calls.length === 2, { timeout: 1000 });
    expect(h.sendPrompt).toHaveBeenLastCalledWith("top", "回传:worker", undefined, { internal: true });
    expect(h.reclaimIfIdle).toHaveBeenCalledWith("worker");
  });

  test("干活的会话休眠时子任务还没回传：保留等待，恢复处理后仍向上回传", async () => {
    const h = createHarness();
    h.set("top");
    h.set("worker", { status: "running", activeTurnId: "t1" });
    h.set("sub", { status: "running", activeTurnId: "s1" });
    h.reports.expect("worker", "top", 0);
    h.reports.expect("sub", "worker", 0);
    h.set("worker", { status: "dormant" });

    h.set("sub");
    await vi.waitUntil(() => h.sendPrompt.mock.calls.length === 1, { timeout: 1000 });
    h.set("worker", { status: "running", activeTurnId: "t2" });
    h.set("worker");
    await vi.waitUntil(() => h.sendPrompt.mock.calls.length === 2, { timeout: 1000 });
    expect(h.sendPrompt).toHaveBeenLastCalledWith("top", "回传:worker", undefined, { internal: true });
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

  test("发送时遇到 TURN_IN_PROGRESS：放回队列，稳定后重发，内容不丢", async () => {
    const h = createHarness();
    h.set("parent");
    h.sendPrompt.mockRejectedValueOnce(new AgentRpcError("TURN_IN_PROGRESS", "忙"));
    h.reports.enqueue("parent", "child", "内容");
    await vi.waitUntil(() => h.sendPrompt.mock.calls.length === 2, { timeout: 1000 });
    expect(h.sendPrompt).toHaveBeenLastCalledWith("parent", "内容", undefined, { internal: true });
    await sleep(40);
    expect(h.sendPrompt).toHaveBeenCalledTimes(2);
  });

  test("其它发送失败：稍后重试，内容不丢；连续失败超过上限才放弃", async () => {
    const h = createHarness();
    h.set("parent");
    h.sendPrompt.mockRejectedValueOnce(new Error("恢复失败"));
    h.reports.enqueue("parent", "child", "内容");
    await vi.waitUntil(() => h.sendPrompt.mock.calls.length === 2, { timeout: 1000 });
    expect(h.sendPrompt).toHaveBeenLastCalledWith("parent", "内容", undefined, { internal: true });

    h.set("parent");
    h.sendPrompt.mockReset();
    h.sendPrompt.mockRejectedValue(new Error("一直失败"));
    h.reports.enqueue("parent", "child", "内容2");
    await vi.waitUntil(() => h.sendPrompt.mock.calls.length === REPORT_MAX_RETRIES + 1, { timeout: 2000 });
    await sleep(60);
    expect(h.sendPrompt).toHaveBeenCalledTimes(REPORT_MAX_RETRIES + 1);
  });

  test("组装回传期间仍算未完成，且能被 wait 撤回", async () => {
    const release: Array<(text: string) => void> = [];
    const h = createHarness({ describeTurn: () => new Promise<string>((resolve) => release.push(resolve)) });
    h.set("top");
    h.set("worker", { status: "running", activeTurnId: "t1" });
    h.set("sub", { status: "running", activeTurnId: "s1" });
    h.reports.expect("worker", "top", 0);
    h.reports.expect("sub", "worker", 0);
    h.set("worker");
    h.set("sub");
    await vi.waitUntil(() => release.length === 1, { timeout: 1000 });
    expect(h.reports.hasOutstanding("worker")).toBe(true);
    await sleep(40);
    expect(release).toHaveLength(1);

    h.reports.settle("sub", "worker");
    release[0]!("迟到的回传");
    await sleep(40);
    expect(h.sendPrompt).not.toHaveBeenCalledWith("worker", "迟到的回传", undefined, { internal: true });
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
