import { describe, expect, it } from "vitest";
import { createStore } from "jotai";
import type { AgentPermissionRequest, AgentStreamEnvelope, AgentStreamEvent } from "@agentdeck/protocol";
import {
  agentPendingAssistantId,
  applyAgentEventAtom,
  chatRuntimeBySessionAtom,
  createEmptyChatRuntime,
  reduceAgentEvent,
  startAgentPromptAtom,
  type ChatSessionRuntime,
} from "./chat";

const AGENT = "agent-1";

function env(seq: number, event: AgentStreamEvent, epoch = "e1"): AgentStreamEnvelope {
  return { agentId: AGENT, seq, epoch, timestamp: 10_000 + seq, event };
}

function replay(events: AgentStreamEvent[], runtime: ChatSessionRuntime = createEmptyChatRuntime(0)): ChatSessionRuntime {
  return events.reduce((acc, event, index) => reduceAgentEvent(acc, env(index + 1, event), 1), runtime);
}

function assistant(runtime: ChatSessionRuntime) {
  return runtime.messages.filter((message) => message.role === "assistant");
}

const SHELL_RUNNING: AgentStreamEvent = {
  type: "timeline",
  turnId: "t1",
  item: {
    type: "tool_call",
    callId: "c1",
    name: "shell",
    status: "running",
    detail: { type: "shell", command: "echo hi" },
  },
};
const SHELL_DONE: AgentStreamEvent = {
  type: "timeline",
  turnId: "t1",
  item: {
    type: "tool_call",
    callId: "c1",
    name: "shell",
    status: "completed",
    detail: { type: "shell", command: "echo hi", output: "hi", exitCode: 0 },
  },
};

const PERMISSION: AgentPermissionRequest = {
  id: "p1",
  provider: "mock",
  name: "shell",
  kind: "tool",
  title: "运行命令",
  description: "需要执行 shell",
  detail: { type: "shell", command: "rm -rf build" },
  actions: [
    { id: "allow", label: "允许一次", behavior: "allow" },
    { id: "deny", label: "拒绝", behavior: "deny" },
  ],
};

describe("reduceAgentEvent", () => {
  it("user_message 追加用户消息", () => {
    const runtime = replay([
      { type: "timeline", turnId: "t1", item: { type: "user_message", text: "你好", messageId: "u1" } },
    ]);
    expect(runtime.messages).toHaveLength(1);
    expect(runtime.messages[0]).toMatchObject({ id: "u1", role: "user", parts: [{ type: "text", text: "你好" }] });
  });

  it("assistant_message / reasoning 分别累加为 text 与 reasoning part", () => {
    const runtime = replay([
      { type: "turn_started", turnId: "t1" },
      { type: "timeline", turnId: "t1", item: { type: "reasoning", text: "想" } },
      { type: "timeline", turnId: "t1", item: { type: "reasoning", text: "一想" } },
      { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "你", messageId: "m1" } },
      { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "好", messageId: "m1" } },
    ]);
    const [message] = assistant(runtime);
    expect(message!.parts).toEqual([
      { type: "reasoning", text: "想一想" },
      { type: "text", text: "你好" },
    ]);
    expect(runtime.streamStatus).toBe("streaming");
  });

  it("同一轮不同 messageId 的 assistant_message 分段", () => {
    const runtime = replay([
      { type: "turn_started", turnId: "t1" },
      { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "第一段", messageId: "m1" } },
      { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "第二段", messageId: "m2" } },
    ]);
    expect(assistant(runtime)[0]!.parts).toEqual([
      { type: "text", text: "第一段" },
      { type: "text", text: "第二段" },
    ]);
  });

  it("tool_call 按 callId 合并，completed 覆盖 running，并带可读上下文", () => {
    const running = replay([{ type: "turn_started", turnId: "t1" }, SHELL_RUNNING]);
    expect(assistant(running)[0]!.parts).toMatchObject([
      { type: "tool", toolCallId: "c1", state: "running", input: "echo hi" },
    ]);

    const done = replay([{ type: "turn_started", turnId: "t1" }, SHELL_RUNNING, SHELL_DONE]);
    const tools = assistant(done)[0]!.parts.filter((part) => part.type === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ state: "done", input: "echo hi", output: "hi" });
  });

  it("todo 写入计划进度，error 追加错误提示", () => {
    const runtime = replay([
      {
        type: "timeline",
        item: { type: "todo", items: [{ text: "读代码", completed: true }, { text: "改代码", completed: false }] },
      },
      { type: "timeline", item: { type: "error", message: "出错了" } },
    ]);
    expect(runtime.statusMessage).toBe("计划进度 1/2：改代码");
    expect(runtime.agentTodos).toHaveLength(2);
    const notice = runtime.messages.find((message) => message.role === "system");
    expect(notice?.parts).toEqual([{ type: "notice", level: "error", text: "出错了" }]);
  });

  it("turn_completed 收尾：状态 complete、记录用量与耗时", () => {
    const runtime = replay([
      { type: "turn_started", turnId: "t1" },
      { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "完成" } },
      { type: "turn_completed", turnId: "t1", usage: { inputTokens: 10, outputTokens: 5 } },
    ]);
    expect(runtime.streamStatus).toBe("complete");
    expect(runtime.activeAssistantId).toBeUndefined();
    const [message] = assistant(runtime);
    expect(message!.status).toBe("complete");
    expect(message!.metadata?.usage).toMatchObject({ tokensInput: 10, tokensOutput: 5, tokensTotal: 15 });
    expect(message!.metadata?.timing?.durationMs).toBe(2);
  });

  it("turn_failed 收尾为 error 并提示；进程退出时提示新建会话", () => {
    const runtime = replay([
      { type: "turn_started", turnId: "t1" },
      SHELL_RUNNING,
      { type: "turn_failed", turnId: "t1", error: "进程退出", code: "PROCESS_EXITED" },
    ]);
    expect(runtime.streamStatus).toBe("error");
    const tool = assistant(runtime)[0]!.parts.find((part) => part.type === "tool");
    expect(tool).toMatchObject({ state: "error" });
    const notice = runtime.messages.find((message) => message.role === "system");
    expect(JSON.stringify(notice?.parts)).toContain("请新建会话");
  });

  it("turn_canceled 收尾为 idle 并提示已中断", () => {
    const runtime = replay([
      { type: "turn_started", turnId: "t1" },
      { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "半句" } },
      { type: "turn_canceled", turnId: "t1", reason: "user" },
    ]);
    expect(runtime.streamStatus).toBe("idle");
    expect(JSON.stringify(runtime.messages)).toContain("已中断本轮");
  });

  it("permission_requested / permission_resolved 维护 pendingApprovals", () => {
    const pending = replay([
      { type: "turn_started", turnId: "t1" },
      { type: "permission_requested", turnId: "t1", request: PERMISSION },
    ]);
    expect(pending.pendingApprovals).toHaveLength(1);
    expect(pending.pendingApprovals[0]).toMatchObject({
      requestId: "p1",
      sessionId: AGENT,
      command: "rm -rf build",
      reason: "需要执行 shell",
    });
    expect(pending.pendingApprovals[0]!.permission?.actions).toHaveLength(2);

    const resolved = reduceAgentEvent(
      pending,
      env(3, { type: "permission_resolved", requestId: "p1", response: { behavior: "allow", selectedActionId: "allow" } }),
    );
    expect(resolved.pendingApprovals).toHaveLength(0);
  });

  it("usage_updated 记录用量", () => {
    const runtime = replay([{ type: "usage_updated", usage: { inputTokens: 3 } }]);
    expect(runtime.agentUsage).toEqual({ inputTokens: 3 });
  });

  it("同 epoch 下 seq 不大于已归约序号的事件被忽略；epoch 变化后重新接收", () => {
    const first = reduceAgentEvent(
      createEmptyChatRuntime(0),
      env(1, { type: "timeline", item: { type: "user_message", text: "一次" } }),
    );
    const duplicated = reduceAgentEvent(first, env(1, { type: "timeline", item: { type: "user_message", text: "一次" } }));
    expect(duplicated).toBe(first);
    const older = reduceAgentEvent(first, env(0, { type: "timeline", item: { type: "user_message", text: "旧" } }));
    expect(older).toBe(first);

    const nextEpoch = reduceAgentEvent(
      first,
      env(1, { type: "timeline", item: { type: "user_message", text: "新 epoch" } }, "e2"),
    );
    expect(nextEpoch.messages).toHaveLength(2);
    expect(nextEpoch.agentEpoch).toBe("e2");
    expect(nextEpoch.agentLastSeq).toBe(1);
  });
});

describe("乐观发送与事件去重", () => {
  it("user_message 按 clientMessageId 与乐观消息去重，turn_started 复用占位助手消息", () => {
    const store = createStore();
    store.set(startAgentPromptAtom, { agentId: AGENT, clientMessageId: "cm-1", text: "跑一下", now: 5 });

    let runtime = store.get(chatRuntimeBySessionAtom)[AGENT]!;
    expect(runtime.messages.map((message) => message.id)).toEqual(["cm-1", agentPendingAssistantId("cm-1")]);
    expect(runtime.streamStatus).toBe("streaming");

    const events: AgentStreamEvent[] = [
      { type: "timeline", turnId: "t1", item: { type: "user_message", text: "跑一下", clientMessageId: "cm-1" } },
      { type: "turn_started", turnId: "t1" },
      SHELL_RUNNING,
      SHELL_DONE,
      { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "Mock 回复：跑一下" } },
      { type: "turn_completed", turnId: "t1" },
    ];
    events.forEach((event, index) => store.set(applyAgentEventAtom, env(index + 1, event)));
    // 重放同一批事件（例如 timeline 补齐与实时事件重叠）不产生重复
    events.forEach((event, index) => store.set(applyAgentEventAtom, env(index + 1, event)));

    runtime = store.get(chatRuntimeBySessionAtom)[AGENT]!;
    expect(runtime.messages.filter((message) => message.role === "user")).toHaveLength(1);
    const assistants = assistant(runtime);
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.id).toBe(agentPendingAssistantId("cm-1"));
    expect(assistants[0]!.parts.map((part) => part.type)).toEqual(["tool", "text"]);
    expect(runtime.streamStatus).toBe("complete");
  });
});
