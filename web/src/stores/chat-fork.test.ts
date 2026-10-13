import { createStore } from "jotai/vanilla";
import type { AgentStreamEnvelope, AgentStreamEvent } from "@agentdeck/protocol";
import { describe, expect, it } from "vitest";
import {
  AGENT_TIMELINE_NOTICE_PREFIX,
  applyAgentEventAtom,
  chatRuntimeBySessionAtom,
  startAgentPromptAtom,
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

  it("回放：用户 / 助手消息的 metadata.seq 记下对应时间线 seq，并透传到 ChatMessage", () => {
    const store = createStore();
    const events: AgentStreamEvent[] = [
      { type: "timeline", item: { type: "user_message", text: "第一问" } },
      { type: "turn_started", turnId: "t1" },
      { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "答" } },
      { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "一", messageId: "m" } },
      { type: "turn_completed", turnId: "t1" },
      { type: "timeline", item: { type: "user_message", text: "第二问" } },
      { type: "turn_started", turnId: "t2" },
      { type: "timeline", turnId: "t2", item: { type: "assistant_message", text: "答二" } },
      { type: "turn_completed", turnId: "t2" },
    ];
    events.forEach((event, index) => store.set(applyAgentEventAtom, envelope(index + 1, event), true));

    const runtime = store.get(chatRuntimeBySessionAtom).a1;
    expect(runtime.messages.map((message) => [message.role, message.metadata?.seq])).toEqual([
      ["user", 1],
      ["assistant", 3],
      ["user", 6],
      ["assistant", 8],
    ]);
    // 回合结束写入的 metadata（计时等）不覆盖 seq
    expect(runtime.messages[1]!.metadata?.timing).toBeDefined();
    expect(agentUIMessagesToChatMessages(runtime.messages).map((message) => message.seq)).toEqual([1, 3, 6, 8]);
  });

  it("乐观用户消息在事件回显时补上 seq", () => {
    const store = createStore();
    store.set(startAgentPromptAtom, { agentId: "a1", clientMessageId: "m1", text: "hi", now: 5 });
    expect(store.get(chatRuntimeBySessionAtom).a1.messages[0]!.metadata?.seq).toBeUndefined();
    store.set(
      applyAgentEventAtom,
      envelope(4, { type: "timeline", item: { type: "user_message", text: "hi", clientMessageId: "m1" } }),
    );
    expect(store.get(chatRuntimeBySessionAtom).a1.messages[0]!.metadata?.seq).toBe(4);
  });
});
