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

  it("turn_completed.usage 的输出速度写入消息元数据；取消的回合不沿用上一回合的速度", () => {
    const runtime = replay([
      { type: "turn_started", turnId: "t1" },
      { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "完成" } },
      { type: "turn_completed", turnId: "t1", usage: { outputTokens: 500, outputTokensPerSecond: 82.4 } },
      { type: "turn_started", turnId: "t2" },
      { type: "timeline", turnId: "t2", item: { type: "assistant_message", text: "取消前" } },
      { type: "turn_canceled", turnId: "t2", reason: "user" },
    ]);
    const [first, second] = assistant(runtime);
    expect(first!.metadata?.usage?.outputTokensPerSecond).toBe(82.4);
    expect(second!.metadata?.usage?.outputTokensPerSecond).toBeUndefined();
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

  it("usage_updated 浅合并：只带上下文字段的中途更新保留 token / 费用字段，同名字段被覆盖", () => {
    const runtime = replay([
      { type: "usage_updated", usage: { inputTokens: 3, outputTokens: 2, totalCostUsd: 0.1, contextWindowUsedTokens: 10 } },
      { type: "usage_updated", usage: { contextWindowUsedTokens: 500, contextWindowMaxTokens: 1000 } },
    ]);
    expect(runtime.agentUsage).toEqual({
      inputTokens: 3,
      outputTokens: 2,
      totalCostUsd: 0.1,
      contextWindowUsedTokens: 500,
      contextWindowMaxTokens: 1000,
    });
  });

  it("按 seq 去重，与 epoch 无关：重复或更旧的 seq 一律忽略", () => {
    const first = reduceAgentEvent(
      createEmptyChatRuntime(0),
      env(1, { type: "timeline", item: { type: "user_message", text: "一次" } }),
    );
    const duplicated = reduceAgentEvent(first, env(1, { type: "timeline", item: { type: "user_message", text: "一次" } }));
    expect(duplicated).toBe(first);
    const older = reduceAgentEvent(first, env(0, { type: "timeline", item: { type: "user_message", text: "旧" } }));
    expect(older).toBe(first);
    // 历史条目保留原 epoch：同一 seq 换了 epoch 也不能重复归约
    const otherEpoch = reduceAgentEvent(first, env(1, { type: "timeline", item: { type: "user_message", text: "一次" } }, "e2"));
    expect(otherEpoch).toBe(first);

    const next = reduceAgentEvent(
      first,
      env(2, { type: "timeline", item: { type: "user_message", text: "新 epoch" } }, "e2"),
    );
    expect(next.messages).toHaveLength(2);
    expect(next.agentEpoch).toBe("e2");
    expect(next.agentLastSeq).toBe(2);
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

describe("reduceAgentEvent：子代理父卡片（design.md 4.11）", () => {
  const subAgentCard = (status: "running" | "completed", log: string): AgentStreamEvent => ({
    type: "timeline",
    item: {
      type: "tool_call",
      callId: "task-1",
      name: "Agent",
      status,
      detail: { type: "sub_agent", subAgentType: "Explore", description: "读 package.json", log },
    },
  });

  it("sub_agent 卡片显示子代理类型并带 subAgent 字段", () => {
    const runtime = replay([
      { type: "turn_started", turnId: "t1" },
      { ...subAgentCard("running", "[Read] package.json"), turnId: "t1" } as AgentStreamEvent,
    ]);
    const tool = assistant(runtime)[0]!.parts.find((part) => part.type === "tool")!;
    expect(tool.name).toBe("Explore");
    expect(tool.input).toBe("读 package.json");
    expect(tool.subAgent).toEqual({ subAgentType: "Explore", description: "读 package.json", log: "[Read] package.json" });
  });

  it("回合结束后同 callId 的更新原地改到原消息，不新建助手消息", () => {
    const runtime = replay([
      { type: "turn_started", turnId: "t1" },
      { ...subAgentCard("running", ""), turnId: "t1" } as AgentStreamEvent,
      { type: "turn_completed", turnId: "t1" },
      subAgentCard("completed", "[Read] package.json\n[Grep] name"),
    ]);
    const assistants = assistant(runtime);
    expect(assistants).toHaveLength(1);
    const tools = assistants[0]!.parts.filter((part) => part.type === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]!.state).toBe("done");
    expect((tools[0]!.subAgent as { log: string }).log).toBe("[Read] package.json\n[Grep] name");
    expect(assistants[0]!.status).toBe("complete");
    expect(runtime.streamStatus).toBe("complete");
  });

  it("新一轮里更新上一轮的卡片：留在上一轮的消息里", () => {
    const runtime = replay([
      { type: "turn_started", turnId: "t1" },
      { ...subAgentCard("running", ""), turnId: "t1" } as AgentStreamEvent,
      { type: "turn_completed", turnId: "t1" },
      { type: "turn_started", turnId: "t2" },
      { ...subAgentCard("completed", "[Read] a"), turnId: "t2" } as AgentStreamEvent,
    ]);
    const assistants = assistant(runtime);
    expect(assistants[0]!.parts.filter((part) => part.type === "tool")).toHaveLength(1);
    expect(assistants.slice(1).every((message) => !message.parts.some((part) => part.type === "tool"))).toBe(true);
  });
});

describe("reduceAgentEvent：上下文压缩与提问卡片（design.md 4.13）", () => {
  const compaction = (
    status: "running" | "completed" | "failed",
    extra: Record<string, unknown> = {},
  ): AgentStreamEvent => ({
    type: "timeline",
    turnId: "t1",
    item: { type: "compaction", compactionId: "c1", status, ...extra },
  });
  const notices = (runtime: ChatSessionRuntime) =>
    runtime.messages.filter((message) => message.id === "agent-compaction-c1");

  it("running → completed 原地更新同一条提示，并清掉运行时的上下文已用量", () => {
    const running = replay([
      { type: "turn_started", turnId: "t1" },
      { type: "usage_updated", usage: { inputTokens: 10, contextWindowUsedTokens: 150_000, contextWindowMaxTokens: 200_000 } },
      compaction("running"),
    ]);
    expect(notices(running)).toHaveLength(1);
    expect(notices(running)[0]!.parts).toEqual([{ type: "notice", level: "system", text: "正在压缩上下文…" }]);
    // 本轮助手消息还没有内容：提示插在它前面
    expect(running.messages.map((message) => message.role)).toEqual(["system", "assistant"]);
    expect(running.agentUsage?.contextWindowUsedTokens).toBe(150_000);

    const completed = reduceAgentEvent(
      running,
      env(4, compaction("completed", { trigger: "auto", preTokens: 84_100 })),
      1,
    );
    expect(notices(completed)).toHaveLength(1);
    expect(notices(completed)[0]!.parts).toEqual([
      { type: "notice", level: "system", text: "上下文已自动压缩（压缩前 约 84.1k tokens）" },
    ]);
    expect(completed.agentUsage).toEqual({ inputTokens: 10, contextWindowMaxTokens: 200_000 });
  });

  it("助手消息已有内容时追加在末尾；手动压缩、失败文案", () => {
    const runtime = replay([
      { type: "turn_started", turnId: "t1" },
      { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "先说一句" } },
      compaction("completed", { trigger: "manual" }),
    ]);
    expect(runtime.messages.map((message) => message.role)).toEqual(["assistant", "system", "assistant"]);
    expect(notices(runtime)[0]!.parts).toEqual([{ type: "notice", level: "system", text: "上下文已手动压缩" }]);

    const failed = replay([compaction("running"), compaction("failed", { error: "摘要失败" })]);
    expect(notices(failed)[0]!.parts).toEqual([
      { type: "notice", level: "warning", text: "上下文压缩失败：摘要失败" },
    ]);
  });

  it("回合中途压缩：后续输出接在提示之下，提示不再停在末尾；回合结束时空的后续段被移除", () => {
    const head: AgentStreamEvent[] = [
      { type: "turn_started", turnId: "t1" },
      { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "先说一句" } },
      compaction("running"),
      compaction("completed", { trigger: "auto" }),
    ];
    const runtime = replay([
      ...head,
      { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "接着说" } },
      { type: "turn_completed", turnId: "t1" },
    ]);
    expect(runtime.messages.map((message) => message.role)).toEqual(["assistant", "system", "assistant"]);
    const [before, , after] = runtime.messages;
    expect(before!.status).toBe("complete");
    expect(before!.parts).toEqual([{ type: "text", text: "先说一句" }]);
    expect(after!.parts).toEqual([{ type: "text", text: "接着说" }]);
    expect(after!.status).toBe("complete");

    const idle = replay([...head, { type: "turn_completed", turnId: "t1" }]);
    expect(idle.messages.map((message) => message.role)).toEqual(["assistant", "system"]);
  });

  it("question 工具卡片显示为「提问」，输出为「问题 → 回答」", () => {
    const runtime = replay([
      { type: "turn_started", turnId: "t1" },
      {
        type: "timeline",
        turnId: "t1",
        item: {
          type: "tool_call",
          callId: "q1",
          name: "AskUserQuestion",
          status: "completed",
          detail: {
            type: "question",
            questions: [{ question: "用哪个库？", header: "库", multiSelect: false, options: [{ label: "dayjs" }] }],
            answers: { "用哪个库？": "dayjs" },
          },
        },
      },
    ]);
    const tool = assistant(runtime)[0]!.parts.find((part) => part.type === "tool");
    expect(tool).toMatchObject({ name: "提问", input: "用哪个库？", output: "用哪个库？ → dayjs" });
  });
});
