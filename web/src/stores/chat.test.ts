import { createStore } from "jotai/vanilla";
import type { AgentStreamEnvelope } from "@agentdeck/protocol";
import { describe, expect, it } from "vitest";
import {
  agentPendingAssistantId,
  applyAgentEventAtom,
  chatRuntimeBySessionAtom,
  createEmptyChatRuntime,
  markStreamsReconnectingAtom,
  startAgentPromptAtom,
} from "./chat";

describe("markStreamsReconnectingAtom", () => {
  it("把进行中的回合标成临时重连状态，而不是错误收尾", () => {
    const store = createStore();
    store.set(startAgentPromptAtom, { agentId: "a1", clientMessageId: "m1", text: "hi", now: 5 });

    store.set(markStreamsReconnectingAtom);

    const runtime = store.get(chatRuntimeBySessionAtom).a1;
    expect(runtime.streamStatus).toBe("connecting");
    expect(runtime.statusMessage).toBe("连接中断，正在重连…");
    expect(runtime.statusKind).toBe("info");
    expect(runtime.activeAssistantId).toBe(agentPendingAssistantId("m1"));
    const assistant = runtime.messages.find((message) => message.role === "assistant");
    expect(assistant?.status).not.toBe("error");
  });

  it("重连后的输出接续到同一条助手消息", () => {
    const store = createStore();
    store.set(startAgentPromptAtom, { agentId: "a1", clientMessageId: "m1", text: "hi", now: 5 });
    store.set(markStreamsReconnectingAtom);

    store.set(applyAgentEventAtom, {
      agentId: "a1",
      seq: 1,
      epoch: "e1",
      timestamp: 10,
      event: { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "world" } },
    });

    const runtime = store.get(chatRuntimeBySessionAtom).a1;
    expect(runtime.activeAssistantId).toBe(agentPendingAssistantId("m1"));
    expect(runtime.statusMessage).toBe("");
    const assistant = runtime.messages.find((message) => message.role === "assistant");
    expect(assistant?.parts).toEqual([{ type: "text", text: "world" }]);
  });

  it("命令输出（source:command）单独成 part，不与普通文本合并", () => {
    const store = createStore();
    store.set(startAgentPromptAtom, { agentId: "a1", clientMessageId: "m1", text: "/usage", now: 5 });
    const emit = (seq: number, item: object) =>
      store.set(applyAgentEventAtom, {
        agentId: "a1",
        seq,
        epoch: "e1",
        timestamp: 10 + seq,
        event: { type: "timeline", turnId: "t1", item },
      } as never);
    emit(1, { type: "assistant_message", text: "a\nb", messageId: "m-syn", source: "command" });
    emit(2, { type: "assistant_message", text: "c", messageId: "m-syn", source: "command" });
    emit(3, { type: "assistant_message", text: "普通", messageId: "m-real" });
    const assistant = store
      .get(chatRuntimeBySessionAtom)
      .a1.messages.find((message) => message.role === "assistant");
    expect(assistant?.parts).toEqual([
      { type: "text", text: "a\nbc", source: "command" },
      { type: "text", text: "普通" },
    ]);
  });

  it("不改动未在流式输出的会话", () => {
    const store = createStore();
    store.set(chatRuntimeBySessionAtom, (state) => ({
      ...state,
      done: { ...createEmptyChatRuntime(), streamStatus: "complete" },
    }));

    store.set(markStreamsReconnectingAtom);

    expect(store.get(chatRuntimeBySessionAtom).done.streamStatus).toBe("complete");
  });
});

describe("CLI 自发轮次（turn_started 没有前置用户消息）", () => {
  const envelope = (seq: number, event: AgentStreamEnvelope["event"]): AgentStreamEnvelope => ({
    agentId: "a1",
    seq,
    epoch: "e1",
    timestamp: seq * 10,
    event,
  });

  it("上一轮结束后自发开始的一轮另起一条助手消息，运行中显示 streaming，结束后恢复 complete", () => {
    const store = createStore();
    store.set(startAgentPromptAtom, { agentId: "a1", clientMessageId: "m1", text: "派个子代理", now: 5 });
    store.set(applyAgentEventAtom, envelope(1, { type: "timeline", item: { type: "user_message", text: "派个子代理", clientMessageId: "m1" } }));
    store.set(applyAgentEventAtom, envelope(2, { type: "turn_started", turnId: "t1" }));
    store.set(applyAgentEventAtom, envelope(3, { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "已派出" } }));
    store.set(applyAgentEventAtom, envelope(4, { type: "turn_completed", turnId: "t1" }));
    expect(store.get(chatRuntimeBySessionAtom).a1.streamStatus).toBe("complete");

    store.set(applyAgentEventAtom, envelope(5, { type: "turn_started", turnId: "t2", origin: "background" }));
    let runtime = store.get(chatRuntimeBySessionAtom).a1;
    expect(runtime.streamStatus).toBe("streaming");
    expect(runtime.activeTurnId).toBe("t2");
    expect(runtime.activeAssistantId).not.toBe(agentPendingAssistantId("m1"));

    store.set(applyAgentEventAtom, envelope(6, { type: "timeline", turnId: "t2", item: { type: "assistant_message", text: "子代理回报：agentdeck" } }));
    store.set(applyAgentEventAtom, envelope(7, { type: "turn_completed", turnId: "t2" }));
    runtime = store.get(chatRuntimeBySessionAtom).a1;
    expect(runtime.streamStatus).toBe("complete");
    expect(runtime.activeTurnId).toBeUndefined();
    expect(runtime.messages.map((message) => [message.role, message.status, message.parts])).toEqual([
      ["user", "complete", [{ type: "text", text: "派个子代理" }]],
      ["assistant", "complete", [{ type: "text", text: "已派出" }]],
      ["assistant", "complete", [{ type: "text", text: "子代理回报：agentdeck" }]],
    ]);
  });

  it("回放：首个事件就是自发轮次也能建出助手消息", () => {
    const store = createStore();
    store.set(applyAgentEventAtom, envelope(1, { type: "turn_started", turnId: "bg", origin: "background" }), true);
    store.set(applyAgentEventAtom, envelope(2, { type: "timeline", turnId: "bg", item: { type: "assistant_message", text: "后台完成" } }), true);
    store.set(applyAgentEventAtom, envelope(3, { type: "turn_completed", turnId: "bg" }), true);
    const runtime = store.get(chatRuntimeBySessionAtom).a1;
    expect(runtime.streamStatus).toBe("complete");
    expect(runtime.messages).toHaveLength(1);
    expect(runtime.messages[0]).toMatchObject({ role: "assistant", status: "complete", parts: [{ type: "text", text: "后台完成" }] });
  });
});
