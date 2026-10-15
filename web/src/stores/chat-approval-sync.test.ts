// 快照 pendingPermissions 补齐待审批（design.md 4.31）：手机首屏只拉最近一页时间线时，
// 审批卡片不能因为 permission_requested 被分页截断而丢失。
import { createStore } from "jotai";
import { describe, expect, it } from "vitest";
import type { AgentPermissionRequest, AgentSnapshot, AgentStreamEnvelope, AgentStreamEvent } from "@agentdeck/protocol";
import { agentSnapshotsAtom } from "./agents";
import {
  applyAgentEventAtom,
  chatRuntimeBySessionAtom,
  createEmptyChatRuntime,
  reduceAgentEvent,
  removeApprovalAtom,
  type ChatSessionRuntime,
  syncPendingApprovals,
  syncPendingApprovalsAtom,
} from "./chat";

const AGENT = "agent-1";

function request(id: string, extra: Partial<AgentPermissionRequest> = {}): AgentPermissionRequest {
  return { id, provider: "claude", name: "Bash", kind: "tool", title: `执行 ${id}`, ...extra };
}

function snapshot(pending: AgentPermissionRequest[], extra: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id: AGENT,
    provider: "claude",
    cwd: "/w",
    status: "running",
    pendingPermissions: pending,
    lastSeq: 10,
    resumable: true,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

function env(seq: number, event: AgentStreamEvent): AgentStreamEnvelope {
  return { agentId: AGENT, seq, epoch: "e1", timestamp: 1000 + seq, event };
}

describe("syncPendingApprovals", () => {
  it("分页截断后时间线里没有 permission_requested，快照里的待审批会补成卡片", () => {
    const runtime = createEmptyChatRuntime(0);
    const next = syncPendingApprovals(runtime, snapshot([request("p1", { description: "需要确认" })]));
    expect(next.pendingApprovals).toHaveLength(1);
    expect(next.pendingApprovals[0]).toMatchObject({
      requestId: "p1",
      sessionId: AGENT,
      reason: "需要确认",
      permission: { id: "p1", name: "Bash" },
    });
  });

  it("补出的审批格式与 permission_requested 事件一致", () => {
    const req = request("p1", { kind: "plan", description: "d" });
    const viaEvent = createStoreRuntimeViaEvent(req);
    const viaSnapshot = syncPendingApprovals(createEmptyChatRuntime(0), snapshot([req]));
    expect(viaSnapshot.pendingApprovals).toEqual(viaEvent.pendingApprovals);
  });

  it("已有的不重复，快照里已不存在的被移除", () => {
    let runtime = syncPendingApprovals(createEmptyChatRuntime(0), snapshot([request("p1"), request("p2")]));
    expect(runtime.pendingApprovals.map((a) => a.requestId)).toEqual(["p1", "p2"]);
    runtime = syncPendingApprovals(runtime, snapshot([request("p2")]));
    expect(runtime.pendingApprovals.map((a) => a.requestId)).toEqual(["p2"]);
    // 再同步一次：引用不变（无变化不产生新对象）
    expect(syncPendingApprovals(runtime, snapshot([request("p2")]))).toBe(runtime);
  });

  it("已 resolved 的不会被过期快照补回", () => {
    let runtime = createEmptyChatRuntime(0);
    runtime = reduceEvents(runtime, [
      env(1, { type: "permission_requested", request: request("p1") }),
      env(2, { type: "permission_resolved", requestId: "p1", response: { behavior: "allow" } }),
    ]);
    expect(runtime.pendingApprovals).toHaveLength(0);
    const next = syncPendingApprovals(runtime, snapshot([request("p1")], { lastSeq: 1 }));
    expect(next.pendingApprovals).toHaveLength(0);
  });

  it("快照比已归约事件旧时只补不删，不误删刚到的审批", () => {
    let runtime = reduceEvents(createEmptyChatRuntime(0), [env(5, { type: "permission_requested", request: request("p9") })]);
    runtime = syncPendingApprovals(runtime, snapshot([], { lastSeq: 4 }));
    expect(runtime.pendingApprovals.map((a) => a.requestId)).toEqual(["p9"]);
    runtime = syncPendingApprovals(runtime, snapshot([], { lastSeq: 5 }));
    expect(runtime.pendingApprovals).toHaveLength(0);
  });

  it("dormant / closed 会话不处理", () => {
    const runtime = createEmptyChatRuntime(0);
    expect(syncPendingApprovals(runtime, snapshot([request("p1")], { status: "dormant" }))).toBe(runtime);
    expect(syncPendingApprovals(runtime, snapshot([request("p1")], { status: "closed" }))).toBe(runtime);
  });
});

describe("syncPendingApprovalsAtom", () => {
  it("读 store 里的快照；本地已回应（removeApprovalAtom）的不会被旧快照补回；无运行时不创建", () => {
    const store = createStore();
    store.set(agentSnapshotsAtom, { [AGENT]: snapshot([request("p1")]) });
    store.set(syncPendingApprovalsAtom, AGENT);
    expect(store.get(chatRuntimeBySessionAtom)[AGENT]).toBeUndefined();

    store.set(chatRuntimeBySessionAtom, { [AGENT]: createEmptyChatRuntime(0) });
    store.set(syncPendingApprovalsAtom, AGENT);
    expect(store.get(chatRuntimeBySessionAtom)[AGENT]!.pendingApprovals.map((a) => a.requestId)).toEqual(["p1"]);

    store.set(removeApprovalAtom, { sessionId: AGENT, requestId: "p1" });
    store.set(agentSnapshotsAtom, { [AGENT]: snapshot([request("p1")], { lastSeq: 0 }) });
    store.set(syncPendingApprovalsAtom, AGENT);
    expect(store.get(chatRuntimeBySessionAtom)[AGENT]!.pendingApprovals).toHaveLength(0);
  });

  it("applyAgentEventAtom 路径的 permission_resolved 也记入已处理名单", () => {
    const store = createStore();
    store.set(chatRuntimeBySessionAtom, { [AGENT]: createEmptyChatRuntime(0) });
    store.set(applyAgentEventAtom, env(1, { type: "permission_requested", request: request("p1") }), true);
    store.set(applyAgentEventAtom, env(2, { type: "permission_resolved", requestId: "p1", response: { behavior: "deny" } }), true);
    store.set(agentSnapshotsAtom, { [AGENT]: snapshot([request("p1")], { lastSeq: 1 }) });
    store.set(syncPendingApprovalsAtom, AGENT);
    expect(store.get(chatRuntimeBySessionAtom)[AGENT]!.pendingApprovals).toHaveLength(0);
  });
});

function reduceEvents(runtime: ChatSessionRuntime, events: AgentStreamEnvelope[]): ChatSessionRuntime {
  return events.reduce((acc, e) => reduceAgentEvent(acc, e, 1), runtime);
}

function createStoreRuntimeViaEvent(req: AgentPermissionRequest): ChatSessionRuntime {
  return reduceEvents(createEmptyChatRuntime(0), [env(1, { type: "permission_requested", request: req })]);
}
