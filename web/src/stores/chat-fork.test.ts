import { createStore } from "jotai/vanilla";
import type { AgentStreamEnvelope, AgentStreamEvent } from "@agentdeck/protocol";
import { describe, expect, it } from "vitest";
import {
  AGENT_TIMELINE_NOTICE_PREFIX,
  applyAgentEventAtom,
  chatRuntimeBySessionAtom,
} from "./chat";
import { agentUIMessagesToChatMessages } from "@/components/chat/message-adapter";

function envelope(seq: number, event: AgentStreamEvent): AgentStreamEnvelope {
  return { agentId: "a1", seq, epoch: "e1", timestamp: 10 + seq, event };
}

describe("会话分叉（design.md 4.23）", () => {
  it("timeline notice 归约为居中系统提示（不是告警）", () => {
    const store = createStore();
    store.set(
      applyAgentEventAtom,
      envelope(7, { type: "timeline", item: { type: "notice", text: "已从「原会话」分叉" } }),
      true,
    );
    const messages = store.get(chatRuntimeBySessionAtom).a1.messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: `${AGENT_TIMELINE_NOTICE_PREFIX}7`,
      role: "system",
      status: "complete",
      parts: [{ type: "notice", level: "system", text: "已从「原会话」分叉" }],
    });
  });

  it("回放：用户 / 助手消息的 firstSeq 即「从这里分叉」传给 agent.fork 的 seq，并透传到 ChatMessage", () => {
    const store = createStore();
    const events: AgentStreamEvent[] = [
      { type: "timeline", item: { type: "user_message", text: "第一问" } },
      { type: "turn_started", turnId: "t1" },
      { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "答" } },
      { type: "turn_completed", turnId: "t1" },
      { type: "timeline", item: { type: "user_message", text: "第二问" } },
      { type: "turn_started", turnId: "t2" },
      { type: "timeline", turnId: "t2", item: { type: "assistant_message", text: "答二" } },
      { type: "turn_completed", turnId: "t2" },
    ];
    events.forEach((event, index) => store.set(applyAgentEventAtom, envelope(index + 1, event), true));

    const runtime = store.get(chatRuntimeBySessionAtom).a1;
    expect(runtime.messages.map((message) => [message.role, message.firstSeq])).toEqual([
      ["user", 1],
      ["assistant", 2],
      ["user", 5],
      ["assistant", 6],
    ]);
    expect(agentUIMessagesToChatMessages(runtime.messages).map((message) => message.firstSeq)).toEqual([1, 2, 5, 6]);
  });
});
