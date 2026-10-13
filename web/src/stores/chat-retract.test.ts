import { createStore } from "jotai/vanilla";
import type { AgentStreamEnvelope, AgentStreamEvent } from "@agentdeck/protocol";
import { describe, expect, it } from "vitest";
import {
  applyAgentEventAtom,
  chatRuntimeBySessionAtom,
  retractableUserMessageId,
  startAgentPromptAtom,
} from "./chat";

function envelope(seq: number, event: AgentStreamEvent): AgentStreamEnvelope {
  return { agentId: "a1", seq, epoch: "e1", timestamp: 10 + seq, event };
}

describe("撤回用户消息（design.md 4.16）", () => {
  it("user_message_retracted 移除乐观用户消息与空助手占位，turn_canceled 不再提示已中断", () => {
    const store = createStore();
    store.set(startAgentPromptAtom, { agentId: "a1", clientMessageId: "m1", text: "hi", now: 5 });
    store.set(applyAgentEventAtom, envelope(1, { type: "timeline", item: { type: "user_message", text: "hi", clientMessageId: "m1" } }));
    store.set(applyAgentEventAtom, envelope(2, { type: "turn_started", turnId: "t1" }));
    expect(retractableUserMessageId(store.get(chatRuntimeBySessionAtom).a1)).toBe("m1");

    store.set(applyAgentEventAtom, envelope(3, { type: "user_message_retracted", turnId: "t1", clientMessageId: "m1" }));
    store.set(applyAgentEventAtom, envelope(4, { type: "turn_canceled", turnId: "t1", reason: "interrupted" }));

    const runtime = store.get(chatRuntimeBySessionAtom).a1;
    expect(runtime.messages).toEqual([]);
    expect(runtime.streamStatus).toBe("idle");
    expect(runtime.retractedTurnId).toBeUndefined();
  });

  it("回放：没有 clientMessageId 时移除最近的用户消息，保留更早的对话", () => {
    const store = createStore();
    const events: AgentStreamEvent[] = [
      { type: "timeline", item: { type: "user_message", text: "第一问" } },
      { type: "turn_started", turnId: "t1" },
      { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "答" } },
      { type: "turn_completed", turnId: "t1" },
      { type: "timeline", item: { type: "user_message", text: "第二问" } },
      { type: "turn_started", turnId: "t2" },
      { type: "user_message_retracted", turnId: "t2" },
      { type: "turn_canceled", turnId: "t2", reason: "interrupted" },
    ];
    events.forEach((event, index) => store.set(applyAgentEventAtom, envelope(index + 1, event), true));

    const runtime = store.get(chatRuntimeBySessionAtom).a1;
    expect(runtime.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(runtime.messages[0]!.parts).toEqual([{ type: "text", text: "第一问" }]);
  });

  it("已有助手内容或待审批时不可撤回", () => {
    const store = createStore();
    store.set(startAgentPromptAtom, { agentId: "a1", clientMessageId: "m1", text: "hi", now: 5 });
    store.set(applyAgentEventAtom, envelope(1, { type: "turn_started", turnId: "t1" }));
    store.set(applyAgentEventAtom, envelope(2, { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "嗯" } }));
    expect(retractableUserMessageId(store.get(chatRuntimeBySessionAtom).a1)).toBeUndefined();

    const approval = createStore();
    approval.set(startAgentPromptAtom, { agentId: "a1", clientMessageId: "m1", text: "hi", now: 5 });
    approval.set(applyAgentEventAtom, envelope(1, { type: "turn_started", turnId: "t1" }));
    approval.set(applyAgentEventAtom, envelope(2, {
      type: "permission_requested",
      turnId: "t1",
      request: { id: "p1", provider: "claude", name: "shell", kind: "tool" },
    }));
    expect(retractableUserMessageId(approval.get(chatRuntimeBySessionAtom).a1)).toBeUndefined();
  });

  it("空闲时不可撤回", () => {
    expect(retractableUserMessageId(undefined)).toBeUndefined();
  });
});
