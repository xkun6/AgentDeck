import { createStore } from "jotai/vanilla";
import type { AgentStreamEnvelope, AgentStreamEvent } from "@agentdeck/protocol";
import { describe, expect, it } from "vitest";
import { agentUIMessagesToChatMessages } from "@/components/chat/message-adapter";
import { promptFromUserMessage } from "@/lib/agent-prompt";
import {
  applyAgentEventAtom,
  chatRuntimeBySessionAtom,
  resendableUserMessage,
  retryableTurn,
  startAgentPromptAtom,
} from "./chat";

function envelope(seq: number, event: AgentStreamEvent): AgentStreamEnvelope {
  return { agentId: "a1", seq, epoch: "e1", timestamp: 10 + seq, event };
}

function replay(events: AgentStreamEvent[]) {
  const store = createStore();
  events.forEach((event, index) => store.set(applyAgentEventAtom, envelope(index + 1, event), true));
  return store.get(chatRuntimeBySessionAtom).a1!;
}

describe("运行中插话（design.md 4.22）", () => {
  const events: AgentStreamEvent[] = [
    { type: "timeline", item: { type: "user_message", text: "先做 A", clientMessageId: "m1" } },
    { type: "turn_started", turnId: "t1" },
    { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "好的，开始。", messageId: "x1" } },
    { type: "timeline", turnId: "t1", item: { type: "user_message", text: "顺便做 B", clientMessageId: "m2", steer: true } },
    { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "收到插话。", messageId: "x1" } },
    { type: "turn_completed", turnId: "t1" },
  ];

  it("steer 的 user_message 作为 steer part 并入当前助手消息，不新增用户消息，之后的文本另起一段", () => {
    const runtime = replay(events);
    expect(runtime.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(runtime.messages[1]!.parts).toEqual([
      { type: "text", text: "好的，开始。" },
      { type: "steer", text: "顺便做 B", clientMessageId: "m2" },
      { type: "text", text: "收到插话。" },
    ]);
    // 回合仍是同一个：没有因为插话开新回合
    expect(runtime.streamStatus).toBe("complete");
  });

  it("适配层把 steer part 转成 steer 块，助手文本里不含插话文字", () => {
    const runtime = replay(events);
    const [, assistant] = agentUIMessagesToChatMessages(runtime.messages);
    expect(assistant!.blocks!.map((block) => block.type)).toEqual(["text", "steer", "text"]);
    expect(assistant!.text).toBe("好的，开始。收到插话。");
  });

  it("没有助手消息时（插话先于任何输出）也会建立当前助手消息承接它", () => {
    const runtime = replay([
      { type: "timeline", item: { type: "user_message", text: "hi" } },
      { type: "turn_started", turnId: "t1" },
      { type: "timeline", turnId: "t1", item: { type: "user_message", text: "补充", steer: true } },
    ]);
    expect(runtime.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(runtime.messages.at(-1)!.parts).toEqual([{ type: "steer", text: "补充" }]);
  });
});

describe("重试 / 再次发送（design.md 4.21）", () => {
  it("turn_failed：回合末尾的错误提示可重试，目标是该回合的用户消息", () => {
    const runtime = replay([
      { type: "timeline", item: { type: "user_message", text: "请做点事" } },
      { type: "turn_started", turnId: "t1" },
      { type: "turn_failed", turnId: "t1", error: "炸了" },
    ]);
    const lastUser = runtime.messages.find((message) => message.role === "user")!;
    const retry = retryableTurn(runtime);
    expect(retry?.userMessageId).toBe(lastUser.id);
    expect(runtime.messages.find((message) => message.id === retry!.noticeId)?.role).toBe("system");
    expect(resendableUserMessage(runtime)?.id).toBe(lastUser.id);
    const chat = agentUIMessagesToChatMessages(runtime.messages);
    expect(chat.find((message) => message.id === retry!.noticeId)?.retryUserMessageId).toBe(lastUser.id);
  });

  it("turn_canceled（用户中断）同样可重试；回合正常完成则没有重试，但仍可再次发送", () => {
    const canceled = replay([
      { type: "timeline", item: { type: "user_message", text: "q" } },
      { type: "turn_started", turnId: "t1" },
      { type: "turn_canceled", turnId: "t1", reason: "interrupted" },
    ]);
    expect(retryableTurn(canceled)).toBeDefined();

    const done = replay([
      { type: "timeline", item: { type: "user_message", text: "q" } },
      { type: "turn_started", turnId: "t1" },
      { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "a" } },
      { type: "turn_completed", turnId: "t1" },
    ]);
    expect(retryableTurn(done)).toBeUndefined();
    expect(resendableUserMessage(done)?.parts).toEqual([{ type: "text", text: "q" }]);
  });

  it("只对最后一条用户消息之后的失败提示给重试；新一轮开始后不再提供", () => {
    const failedThenNew = replay([
      { type: "timeline", item: { type: "user_message", text: "一" } },
      { type: "turn_started", turnId: "t1" },
      { type: "turn_failed", turnId: "t1", error: "炸了" },
      { type: "timeline", item: { type: "user_message", text: "二" } },
      { type: "turn_started", turnId: "t2" },
      { type: "timeline", turnId: "t2", item: { type: "assistant_message", text: "ok" } },
    ]);
    expect(retryableTurn(failedThenNew)).toBeUndefined();

    const running = replay([
      { type: "timeline", item: { type: "user_message", text: "一" } },
      { type: "turn_started", turnId: "t1" },
    ]);
    expect(retryableTurn(running)).toBeUndefined();
    expect(resendableUserMessage(running)).toBeUndefined();
  });

  it("CLI 自发轮次（origin background）失败 / 中断不提供重试", () => {
    const runtime = replay([
      { type: "timeline", item: { type: "user_message", text: "q" } },
      { type: "turn_started", turnId: "t1" },
      { type: "turn_completed", turnId: "t1" },
      { type: "turn_started", turnId: "bg1", origin: "background" },
      { type: "turn_failed", turnId: "bg1", error: "后台轮次失败" },
    ]);
    expect(retryableTurn(runtime)).toBeUndefined();
  });

  it("由时间线重建的用户消息带 restored 标记；本地乐观消息不带，并保留图片 part", () => {
    const restored = replay([{ type: "timeline", item: { type: "user_message", text: "旧消息" } }]);
    expect(restored.messages[0]!.restored).toBe(true);
    expect(agentUIMessagesToChatMessages(restored.messages)[0]!.restored).toBe(true);

    const store = createStore();
    store.set(startAgentPromptAtom, {
      agentId: "a1",
      clientMessageId: "m1",
      text: "看图",
      images: [{ url: "data:image/png;base64,QUJD", mimeType: "image/png", name: "a.png" }],
      now: 5,
    });
    store.set(applyAgentEventAtom, envelope(1, { type: "timeline", item: { type: "user_message", text: "看图", clientMessageId: "m1" } }));
    const message = store.get(chatRuntimeBySessionAtom).a1!.messages[0]!;
    expect(message.restored).toBeUndefined();
    const prepared = promptFromUserMessage(message)!;
    expect(prepared.prompt).toEqual([
      { type: "text", text: "看图" },
      { type: "image", data: "QUJD", mimeType: "image/png" },
    ]);
    expect(prepared.displayImages).toHaveLength(1);
  });
});

describe("promptFromUserMessage", () => {
  it("只有文本时返回字符串 prompt；没有任何可发送内容时返回 null", () => {
    const base = { id: "m", sessionId: "a1", role: "user" as const, createdAt: 1, status: "complete" as const };
    expect(promptFromUserMessage({ ...base, parts: [{ type: "text", text: "你好" }] })?.prompt).toBe("你好");
    expect(promptFromUserMessage({ ...base, parts: [] })).toBeNull();
    // 非 data URL 的图片拿不到内容，丢弃
    expect(promptFromUserMessage({ ...base, parts: [{ type: "image", url: "file:///x.png" }] })).toBeNull();
  });
});
