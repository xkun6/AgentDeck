import { createStore } from "jotai/vanilla";
import type { AgentStreamEnvelope, AgentStreamEvent } from "@agentdeck/protocol";
import { describe, expect, it } from "vitest";
import { agentUIMessagesToChatMessages } from "@/components/chat/message-adapter";
import { applyAgentEventAtom, chatRuntimeBySessionAtom, startAgentPromptAtom } from "./chat";

function envelope(seq: number, event: AgentStreamEvent): AgentStreamEnvelope {
  return { agentId: "a1", seq, epoch: "e1", timestamp: 10 + seq, event };
}

describe("翻译（design.md 4.35）：user_message.translatedText", () => {
  it("时间线重建的用户消息与插话都带上 translatedText，适配层透传；文本仍是原文", () => {
    const store = createStore();
    const events: AgentStreamEvent[] = [
      { type: "timeline", item: { type: "user_message", text: "修复登录", translatedText: "Fix login" } },
      { type: "turn_started", turnId: "t1" },
      { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "OK", messageId: "x" } },
      {
        type: "timeline",
        turnId: "t1",
        item: { type: "user_message", text: "加测试", translatedText: "Add tests", steer: true },
      },
      { type: "turn_completed", turnId: "t1" },
    ];
    events.forEach((event, index) => store.set(applyAgentEventAtom, envelope(index + 1, event), true));
    const [user, assistant] = agentUIMessagesToChatMessages(store.get(chatRuntimeBySessionAtom).a1!.messages);
    expect(user).toMatchObject({ role: "user", text: "修复登录", translatedText: "Fix login" });
    expect(assistant!.blocks).toContainEqual({ type: "steer", text: "加测试", translatedText: "Add tests" });
  });

  it("乐观用户消息被确认时补上 translatedText", () => {
    const store = createStore();
    store.set(startAgentPromptAtom, { agentId: "a1", clientMessageId: "m1", text: "你好", now: 5 });
    store.set(
      applyAgentEventAtom,
      envelope(1, {
        type: "timeline",
        item: { type: "user_message", text: "你好", translatedText: "Hello", clientMessageId: "m1" },
      }),
    );
    const [user] = agentUIMessagesToChatMessages(store.get(chatRuntimeBySessionAtom).a1!.messages);
    expect(user).toMatchObject({ id: "m1", text: "你好", translatedText: "Hello" });
  });
});
