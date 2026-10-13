import type { ToolCallTimelineItem } from "@agentdeck/protocol";
import { describe, expect, test } from "vitest";

import type { ProviderSubagentInputEvent } from "../../../src/agent/types.js";
import {
  CodexSubagentRouter,
  MAX_PENDING_SUB_AGENT_NOTIFICATIONS_PER_THREAD,
  MAX_PENDING_SUB_AGENT_THREADS,
} from "../../../src/providers/codex/subagent-router.js";
import { mapCodexToolCallFromThreadItem } from "../../../src/providers/codex/tool-call-mapper.js";

function createRouter() {
  const subagentEvents: ProviderSubagentInputEvent[] = [];
  const parentCards: ToolCallTimelineItem[] = [];
  const router = new CodexSubagentRouter({
    cwd: "C:\\work",
    rootThreadId: () => "thr_root",
    emitSubagent: (event) => subagentEvents.push(event),
    emitParentCard: (item) => parentCards.push(item),
  });
  return { router, subagentEvents, parentCards };
}

function collab(id: string, threads: string[], prompt = "任务") {
  return {
    type: "collabAgentToolCall",
    id,
    tool: "spawnAgent",
    prompt,
    receiverThreadIds: threads,
    agentsStates: Object.fromEntries(threads.map((t) => [t, { status: "running" }])),
    status: "completed",
  };
}

/** 主线程登记 sub_agent 卡片；返回调用方会发出的卡片 */
function registerRoot(router: CodexSubagentRouter, item: Record<string, unknown>) {
  const tool = mapCodexToolCallFromThreadItem(item, { cwd: "C:\\work" });
  if (!tool) throw new Error("映射失败");
  const routed = router.handleRootItem(item, tool);
  if (!routed || routed === "handled") throw new Error("未登记");
  routed.replay();
  return routed.card;
}

const delta = (threadId: string, text: string, itemId = "m1") => ({ threadId, itemId, delta: text });

describe("CodexSubagentRouter", () => {
  test("未登记子线程的通知缓冲；登记后按序回放", () => {
    const { router, subagentEvents } = createRouter();
    router.routeNotification("item/agentMessage/delta", delta("thr_a", "一"), "thr_a");
    router.routeNotification("item/agentMessage/delta", delta("thr_a", "二"), "thr_a");
    expect(subagentEvents).toEqual([]);

    registerRoot(router, collab("c1", ["thr_a"]));
    const texts = subagentEvents.flatMap((e) =>
      e.type === "timeline" && e.item.type === "assistant_message" ? [e.item.text] : [],
    );
    expect(texts).toEqual(["一", "二"]);
    expect(subagentEvents[0]).toMatchObject({ type: "upsert", id: "thr_a", toolCallId: "c1", title: "Sub-agent" });
    expect(router.callIdForThread("thr_a")).toBe("c1");
  });

  test("缓冲上限：最多 32 个线程（丢最旧线程）、每线程 128 条（丢最旧通知）", () => {
    const { router, subagentEvents } = createRouter();
    for (let i = 0; i <= MAX_PENDING_SUB_AGENT_THREADS; i += 1) {
      router.routeNotification("item/agentMessage/delta", delta(`thr_${i}`, "x"), `thr_${i}`);
    }
    // thr_0 被挤掉：登记后没有可回放的内容
    registerRoot(router, collab("c0", ["thr_0"]));
    expect(subagentEvents.filter((e) => e.type === "timeline")).toEqual([]);

    for (let i = 0; i < MAX_PENDING_SUB_AGENT_NOTIFICATIONS_PER_THREAD + 2; i += 1) {
      router.routeNotification("item/agentMessage/delta", delta("thr_many", String(i)), "thr_many");
    }
    registerRoot(router, collab("c2", ["thr_many"]));
    const texts = subagentEvents.flatMap((e) =>
      e.type === "timeline" && e.id === "thr_many" && e.item.type === "assistant_message" ? [e.item.text] : [],
    );
    expect(texts).toHaveLength(MAX_PENDING_SUB_AGENT_NOTIFICATIONS_PER_THREAD);
    expect(texts[0]).toBe("2");
  });

  test("子线程回合状态推动父卡片：完成 → completed，中断 → canceled；重新开始回合可再次 running", () => {
    const { router, parentCards, subagentEvents } = createRouter();
    registerRoot(router, collab("c1", ["thr_a"]));
    router.routeNotification("turn/completed", { threadId: "thr_a", turn: { id: "t", status: "completed" } }, "thr_a");
    expect(parentCards.at(-1)?.status).toBe("completed");
    // 迟到的父线程 running 卡片不回退终态
    const again = registerRoot(router, { ...collab("c1", ["thr_a"]), status: "inProgress" });
    expect(again.status).toBe("completed");

    router.routeNotification("turn/started", { threadId: "thr_a", turn: { id: "t2" } }, "thr_a");
    expect(parentCards.at(-1)?.status).toBe("running");
    router.routeNotification("turn/completed", { threadId: "thr_a", turn: { id: "t2", status: "interrupted" } }, "thr_a");
    expect(parentCards.at(-1)?.status).toBe("canceled");
    expect(subagentEvents.filter((e) => e.type === "upsert").at(-1)).toMatchObject({ status: "canceled" });
  });

  test("子线程的工具项写入子代理时间线并汇总到父卡片 log；文本增量不逐条重推父卡片", () => {
    const { router, parentCards, subagentEvents } = createRouter();
    registerRoot(router, collab("c1", ["thr_a"]));
    const before = parentCards.length;
    router.routeNotification("item/agentMessage/delta", delta("thr_a", "看看"), "thr_a");
    expect(parentCards.length).toBe(before);

    const exec = {
      type: "commandExecution",
      id: "e1",
      command: "ls",
      cwd: "C:\\work",
      status: "completed",
      commandActions: [],
      aggregatedOutput: "a",
      exitCode: 0,
    };
    router.routeNotification("item/completed", { threadId: "thr_a", item: exec }, "thr_a");
    expect(subagentEvents.filter((e) => e.type === "timeline").at(-1)).toMatchObject({
      id: "thr_a",
      item: { type: "tool_call", callId: "e1" },
    });
    const log = parentCards.at(-1)?.detail.type === "sub_agent" ? parentCards.at(-1)!.detail : null;
    expect(log && "log" in log ? log.log : "").toContain("[Assistant] 看看");
    expect(log && "log" in log ? log.log : "").toContain("ls");
  });

  test("嵌套：子线程派出的孙代理挂在子代理下，活动冒泡到最上层父卡片", () => {
    const { router, parentCards, subagentEvents } = createRouter();
    registerRoot(router, collab("c1", ["thr_a"]));
    router.routeNotification("item/completed", { threadId: "thr_a", item: collab("c2", ["thr_b"], "孙任务") }, "thr_a");
    expect(subagentEvents.find((e) => e.type === "upsert" && e.id === "thr_b")).toMatchObject({
      parentSubagentId: "thr_a",
      toolCallId: "c2",
      description: "孙任务",
    });
    router.routeNotification("item/completed", { threadId: "thr_b", item: { type: "agentMessage", id: "gm", text: "孙代理完成" } }, "thr_b");
    // 父会话只看到 c1 的卡片，log 里带着孙代理的内容
    expect(parentCards.every((card) => card.callId === "c1")).toBe(true);
    const detail = parentCards.at(-1)?.detail;
    expect(detail?.type === "sub_agent" ? detail.log : "").toContain("孙代理完成");
  });

  test("已登记子线程的 subAgentActivity 更新既有卡片；failRunning 把运行中的子代理记为失败", () => {
    const { router, parentCards } = createRouter();
    registerRoot(router, collab("c1", ["thr_a"]));
    const activity = { type: "subAgentActivity", id: "act1", kind: "started", agentThreadId: "thr_a", agentPath: "/root/code_reviewer" };
    const tool = mapCodexToolCallFromThreadItem(activity, { cwd: "C:\\work" })!;
    expect(router.handleRootItem(activity, tool)).toBe("handled");
    expect(parentCards.at(-1)).toMatchObject({ callId: "c1", detail: { subAgentType: "Code reviewer" } });

    router.failRunning();
    expect(parentCards.at(-1)).toMatchObject({ callId: "c1", status: "failed" });
  });

  test("codex 0.162.1 实测形状：spawn 为 subAgentActivity(started)，结束为 subAgentActivity(completed)；子线程回给父线程的活动不登记父线程", () => {
    const { router, parentCards, subagentEvents } = createRouter();
    const activity = (id: string, kind: string, agentThreadId: string, agentPath = "/root/read_package_name") => ({
      type: "subAgentActivity",
      id,
      kind,
      agentThreadId,
      agentPath,
    });
    const card = registerRoot(router, activity("call_spawn", "started", "thr_a"));
    expect(card).toMatchObject({ callId: "call_spawn", status: "running", detail: { subAgentType: "Read package name" } });
    expect(subagentEvents[0]).toMatchObject({
      type: "upsert",
      id: "thr_a",
      title: "Read package name",
      toolCallId: "call_spawn",
    });

    // 子线程向父线程汇报（agentThreadId 指向父线程）：只作为子代理时间线里的卡片
    router.routeNotification(
      "item/completed",
      { threadId: "thr_a", item: activity("call_back", "interacted", "thr_root", "/root") },
      "thr_a",
    );
    expect(router.callIdForThread("thr_root")).toBeUndefined();
    expect(subagentEvents.some((e) => e.type === "upsert" && e.id === "thr_root")).toBe(false);

    // completed 活动更新既有卡片，不产生新的父卡片
    const completed = activity("subagent-completed-turn1", "completed", "thr_a");
    const tool = mapCodexToolCallFromThreadItem(completed, { cwd: "C:\\work" })!;
    expect(router.handleRootItem(completed, tool)).toBe("handled");
    expect(parentCards.every((c) => c.callId === "call_spawn")).toBe(true);
    expect(parentCards.at(-1)?.status).toBe("completed");
    expect(subagentEvents.filter((e) => e.type === "upsert").at(-1)).toMatchObject({ id: "thr_a", status: "completed" });
  });
});
