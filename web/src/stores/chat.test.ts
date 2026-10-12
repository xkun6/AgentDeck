import { createStore } from "jotai/vanilla";
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
