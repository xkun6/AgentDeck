// 持久化会话（design.md 4.5）在前端 store 的行为：timeline 重建、跨 epoch 按 seq 去重、
// sidecar 重启后的收尾、dormant 会话未结束回合的收尾、agent.removed、回放不通知。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import type { AgentSnapshot, AgentStreamEnvelope, AgentStreamEvent } from "@agentdeck/protocol";

const notifyMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notifications", () => ({ notifyFromAgentEvent: notifyMock }));

import {
  AGENT_RESUMING_PROGRESS,
  agentPendingAssistantId,
  applyAgentEventAtom,
  chatRuntimeBySessionAtom,
  removeAgentAtom,
  resetAgentRuntimesForEpochAtom,
  settleInactiveAgentRuntimeAtom,
  startAgentPromptAtom,
} from "./chat";
import { agentSnapshotsAtom, lastRemovedAgentAtom, upsertAgentSnapshotAtom } from "./agents";
import { activeSessionIdAtom } from "./ui";

const AGENT = "agent-p";

function env(seq: number, event: AgentStreamEvent, epoch: string): AgentStreamEnvelope {
  return { agentId: AGENT, seq, epoch, timestamp: 20_000 + seq, event };
}

function snapshot(patch: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id: AGENT,
    provider: "mock",
    cwd: "/work",
    status: "dormant",
    pendingPermissions: [],
    lastSeq: 0,
    resumable: true,
    createdAt: 1,
    updatedAt: 2,
    ...patch,
  };
}

/** 一轮完整对话：user_message → turn_started → assistant_message → turn_completed。 */
function turn(startSeq: number, turnId: string, prompt: string, reply: string, epoch: string): AgentStreamEnvelope[] {
  return [
    env(startSeq, { type: "timeline", item: { type: "user_message", text: prompt, clientMessageId: `cm-${turnId}` } }, epoch),
    env(startSeq + 1, { type: "turn_started", turnId }, epoch),
    env(startSeq + 2, { type: "timeline", turnId, item: { type: "assistant_message", text: reply } }, epoch),
    env(startSeq + 3, { type: "turn_completed", turnId }, epoch),
  ];
}

function textOf(store: ReturnType<typeof createStore>): string[] {
  const runtime = store.get(chatRuntimeBySessionAtom)[AGENT]!;
  return runtime.messages.map((message) =>
    `${message.role}:${message.parts.map((part) => ("text" in part ? part.text : part.type)).join("")}`);
}

beforeEach(() => {
  notifyMock.mockReset();
});

describe("持久化会话的 timeline 重建", () => {
  it("历史条目保留原 epoch：跨多个 epoch 的历史全部重建，之后的实时事件照常合并", () => {
    const store = createStore();
    // 两段历史分别来自两次 sidecar 进程（epoch e-old1 / e-old2），当前进程 epoch 为 e-now
    const history = [
      ...turn(1, "t1", "第一问", "第一答", "e-old1"),
      ...turn(5, "t2", "第二问", "第二答", "e-old2"),
    ];
    history.forEach((entry) => store.set(applyAgentEventAtom, entry, true));
    expect(textOf(store)).toEqual(["user:第一问", "assistant:第一答", "user:第二问", "assistant:第二答"]);

    // timeline 与实时事件重叠：同一批历史再回放一次也不重复
    history.forEach((entry) => store.set(applyAgentEventAtom, entry, true));
    expect(textOf(store)).toHaveLength(4);

    // 恢复后的新一轮（当前 epoch，seq 接着历史递增）
    turn(9, "t3", "第三问", "第三答", "e-now").forEach((entry) => store.set(applyAgentEventAtom, entry));
    expect(textOf(store)).toEqual([
      "user:第一问",
      "assistant:第一答",
      "user:第二问",
      "assistant:第二答",
      "user:第三问",
      "assistant:第三答",
    ]);
    const runtime = store.get(chatRuntimeBySessionAtom)[AGENT]!;
    expect(runtime.agentLastSeq).toBe(12);
    expect(runtime.streamStatus).toBe("complete");
  });

  it("回放（replay）的事件不触发桌面通知，实时事件照常交给通知旁路", () => {
    const store = createStore();
    turn(1, "t1", "问", "答", "e-old").forEach((entry) => store.set(applyAgentEventAtom, entry, true));
    expect(notifyMock).not.toHaveBeenCalled();
    turn(5, "t2", "再问", "再答", "e-now").forEach((entry) => store.set(applyAgentEventAtom, entry));
    expect(notifyMock).toHaveBeenCalledTimes(4);
  });

  it("sidecar 重启（epoch 变化）后保留已归约 seq：进行中的回合收尾，再回放全部历史也不重复", () => {
    const store = createStore();
    const history = [
      ...turn(1, "t1", "问", "答", "e1"),
      env(5, { type: "timeline", item: { type: "user_message", text: "长任务", clientMessageId: "cm-t2" } }, "e1"),
      env(6, { type: "turn_started", turnId: "t2" }, "e1"),
    ];
    history.forEach((entry) => store.set(applyAgentEventAtom, entry));
    expect(store.get(chatRuntimeBySessionAtom)[AGENT]!.streamStatus).toBe("streaming");

    store.set(resetAgentRuntimesForEpochAtom);
    let runtime = store.get(chatRuntimeBySessionAtom)[AGENT]!;
    expect(runtime.streamStatus).toBe("error");
    expect(runtime.agentLastSeq).toBe(6);
    const before = runtime.messages.length;

    // 新进程从 seq 0 起拉全量 timeline：历史条目全部按 seq 去重
    history.forEach((entry) => store.set(applyAgentEventAtom, entry, true));
    runtime = store.get(chatRuntimeBySessionAtom)[AGENT]!;
    expect(runtime.messages).toHaveLength(before);
    expect(runtime.streamStatus).toBe("error");
  });

  it("dormant 会话回放后收尾历史里未结束的回合（清掉运行中工具与挂起审批）", () => {
    const store = createStore();
    store.set(upsertAgentSnapshotAtom, snapshot({ status: "dormant" }));
    const entries = [
      env(1, { type: "timeline", item: { type: "user_message", text: "跑命令" } }, "e-old"),
      env(2, { type: "turn_started", turnId: "t1" }, "e-old"),
      env(3, {
        type: "timeline",
        turnId: "t1",
        item: { type: "tool_call", callId: "c1", name: "shell", status: "running", detail: { type: "shell", command: "sleep 100" } },
      }, "e-old"),
      env(4, {
        type: "permission_requested",
        turnId: "t1",
        request: { id: "p1", provider: "mock", name: "shell", kind: "tool" },
      }, "e-old"),
    ];
    entries.forEach((entry) => store.set(applyAgentEventAtom, entry, true));
    expect(store.get(chatRuntimeBySessionAtom)[AGENT]!.pendingApprovals).toHaveLength(1);

    store.set(settleInactiveAgentRuntimeAtom, AGENT);
    const runtime = store.get(chatRuntimeBySessionAtom)[AGENT]!;
    expect(runtime.activeTurnId).toBeUndefined();
    expect(runtime.streamStatus).toBe("idle");
    expect(runtime.pendingApprovals).toHaveLength(0);
    const tool = runtime.messages.flatMap((message) => message.parts).find((part) => part.type === "tool");
    expect(tool && tool.type === "tool" ? tool.state : null).toBe("error");
  });

  it("会话不是 dormant / closed 时不收尾（例如已恢复并在运行）", () => {
    const store = createStore();
    store.set(upsertAgentSnapshotAtom, snapshot({ status: "running" }));
    store.set(applyAgentEventAtom, env(1, { type: "turn_started", turnId: "t1" }, "e1"));
    const before = store.get(chatRuntimeBySessionAtom)[AGENT];
    store.set(settleInactiveAgentRuntimeAtom, AGENT);
    expect(store.get(chatRuntimeBySessionAtom)[AGENT]).toBe(before);
  });

  it("恢复中发送：占位助手消息显示「正在恢复会话…」", () => {
    const store = createStore();
    store.set(startAgentPromptAtom, {
      agentId: AGENT,
      clientMessageId: "cm-r",
      text: "继续",
      progressText: AGENT_RESUMING_PROGRESS,
      now: 1,
    });
    const runtime = store.get(chatRuntimeBySessionAtom)[AGENT]!;
    const pending = runtime.messages.find((message) => message.id === agentPendingAssistantId("cm-r"));
    expect(pending?.parts).toEqual([{ type: "progress", text: AGENT_RESUMING_PROGRESS }]);
  });
});

describe("agent.removed", () => {
  it("从快照与会话运行时中移除，并记录最近一次删除（nonce 递增）", () => {
    const store = createStore();
    store.set(upsertAgentSnapshotAtom, snapshot());
    store.set(upsertAgentSnapshotAtom, snapshot({ id: "other" }));
    turn(1, "t1", "问", "答", "e1").forEach((entry) => store.set(applyAgentEventAtom, entry));
    store.set(activeSessionIdAtom, AGENT);

    store.set(removeAgentAtom, AGENT);
    expect(store.get(activeSessionIdAtom)).toBeNull();
    expect(Object.keys(store.get(agentSnapshotsAtom))).toEqual(["other"]);
    expect(store.get(chatRuntimeBySessionAtom)[AGENT]).toBeUndefined();
    expect(store.get(lastRemovedAgentAtom)).toEqual({ agentId: AGENT, nonce: 1 });

    // agent.delete 成功与 agent.removed 通知可能各触发一次：重复移除无副作用
    store.set(removeAgentAtom, AGENT);
    expect(Object.keys(store.get(agentSnapshotsAtom))).toEqual(["other"]);
    expect(store.get(lastRemovedAgentAtom)).toEqual({ agentId: AGENT, nonce: 2 });
  });
});
