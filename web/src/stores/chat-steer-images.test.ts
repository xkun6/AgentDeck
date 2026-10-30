// 插话带图片（design.md 4.22）：本端显示缩略图，其它情况显示图片数，只有图片也不丢气泡
import { createStore } from "jotai/vanilla";
import type { AgentStreamEnvelope, AgentStreamEvent } from "@agentdeck/protocol";
import { describe, expect, it } from "vitest";
import { agentUIMessagesToChatMessages } from "@/components/chat/message-adapter";
import { applyAgentEventAtom, chatRuntimeBySessionAtom, rememberSteerImagesAtom } from "./chat";

function envelope(seq: number, event: AgentStreamEvent): AgentStreamEnvelope {
  return { agentId: "a1", seq, epoch: "e1", timestamp: 10 + seq, event };
}

function applySteer(store: ReturnType<typeof createStore>, item: Extract<AgentStreamEvent, { type: "timeline" }>["item"]) {
  const events: AgentStreamEvent[] = [
    { type: "turn_started", turnId: "t1" },
    { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "OK", messageId: "x" } },
    { type: "timeline", turnId: "t1", item },
  ];
  events.forEach((event, index) => store.set(applyAgentEventAtom, envelope(index + 1, event), true));
  const [assistant] = agentUIMessagesToChatMessages(store.get(chatRuntimeBySessionAtom).a1!.messages);
  return assistant!.blocks!.find((block) => block.type === "steer");
}

describe("插话带图片", () => {
  it("本端暂存的图片并入气泡，只有图片时气泡也保留，暂存随后清除", () => {
    const store = createStore();
    store.set(rememberSteerImagesAtom, {
      agentId: "a1",
      clientMessageId: "cm-1",
      images: [{ url: "data:image/png;base64,AAAA", name: "a.png" }],
    });
    const block = applySteer(store, { type: "user_message", text: "", clientMessageId: "cm-1", steer: true, imageCount: 1 });
    expect(block).toMatchObject({ type: "steer", text: "", imageCount: 1, images: [{ url: "data:image/png;base64,AAAA" }] });
    expect(store.get(chatRuntimeBySessionAtom).a1!.pendingSteerImages).toEqual({});
  });

  it("没有暂存（重连重建、另一台设备）时只带图片数", () => {
    const block = applySteer(createStore(), { type: "user_message", text: "看这张", steer: true, imageCount: 2 });
    expect(block).toEqual({ type: "steer", text: "看这张", imageCount: 2 });
  });

  it("既无文字也无图片的插话不显示", () => {
    expect(applySteer(createStore(), { type: "user_message", text: "", steer: true })).toBeUndefined();
  });
});
