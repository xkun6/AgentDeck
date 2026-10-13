// 消息首个 seq（全文搜索定位，design.md 4.19）
import { describe, expect, it } from "vitest";
import { createStore } from "jotai";
import type { AgentStreamEnvelope, AgentStreamEvent } from "@agentdeck/protocol";
import {
  applyAgentEventAtom,
  chatRuntimeBySessionAtom,
  createEmptyChatRuntime,
  reduceAgentEvent,
  startAgentPromptAtom,
  type ChatSessionRuntime,
} from "./chat";

const AGENT = "agent-1";

function env(seq: number, event: AgentStreamEvent): AgentStreamEnvelope {
  return { agentId: AGENT, seq, epoch: "e1", timestamp: 10_000 + seq, event };
}

function replay(events: AgentStreamEvent[]): ChatSessionRuntime {
  return events.reduce(
    (acc, event, index) => reduceAgentEvent(acc, env(index + 1, event), 1),
    createEmptyChatRuntime(0),
  );
}

describe("消息首个 seq", () => {
  it("用户消息与助手消息记录各自的首个 seq", () => {
    const runtime = replay([
      { type: "timeline", item: { type: "user_message", text: "你好" } },
      { type: "turn_started", turnId: "t1" },
      { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "嗨" } },
      { type: "turn_completed", turnId: "t1" },
      { type: "timeline", item: { type: "user_message", text: "再来" } },
    ]);
    expect(runtime.messages.map((message) => [message.role, message.firstSeq])).toEqual([
      ["user", 1],
      ["assistant", 2],
      ["user", 5],
    ]);
  });

  it("乐观消息被服务端确认时补上 seq", () => {
    const store = createStore();
    store.set(startAgentPromptAtom, { agentId: AGENT, clientMessageId: "cm1", text: "hi" });
    store.set(
      applyAgentEventAtom,
      env(7, { type: "timeline", item: { type: "user_message", text: "hi", clientMessageId: "cm1" } }),
    );
    store.set(applyAgentEventAtom, env(8, { type: "turn_started", turnId: "t9" }));
    const messages = store.get(chatRuntimeBySessionAtom)[AGENT]!.messages;
    expect(messages.find((message) => message.id === "cm1")?.firstSeq).toBe(7);
    expect(messages.find((message) => message.role === "assistant")?.firstSeq).toBe(8);
  });
});
