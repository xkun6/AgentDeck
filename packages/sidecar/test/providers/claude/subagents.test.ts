import { describe, expect, test } from "vitest";

import { ClaudeSidechainTracker } from "../../../src/providers/claude/sidechain-tracker.js";
import type { ClaudeOutputMessage } from "../../../src/providers/claude/stream-json-types.js";
import { ClaudeTaskProtocolSource } from "../../../src/providers/claude/subagents/live-source.js";
import { foldSubagentObservations } from "../../../src/providers/claude/subagents/observation.js";

const SESSION = "s";

function system(subtype: string, fields: Record<string, unknown>): ClaudeOutputMessage {
  return { type: "system", subtype, session_id: SESSION, ...fields } as unknown as ClaudeOutputMessage;
}

function assistant(parent: string | null, content: unknown[], model?: string): ClaudeOutputMessage {
  return {
    type: "assistant",
    parent_tool_use_id: parent,
    session_id: SESSION,
    message: { id: `m-${Math.random()}`, role: "assistant", content, ...(model ? { model } : {}) },
  } as unknown as ClaudeOutputMessage;
}

function toolResult(parent: string | null, toolUseId: string, content: unknown, isError = false): ClaudeOutputMessage {
  return {
    type: "user",
    parent_tool_use_id: parent,
    session_id: SESSION,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) }],
    },
  } as unknown as ClaudeOutputMessage;
}

const started = (taskId: string, toolUseId: string, extra: Record<string, unknown> = {}) =>
  system("task_started", {
    task_id: taskId,
    tool_use_id: toolUseId,
    description: "读文件",
    subagent_type: "Explore",
    task_type: "local_agent",
    prompt: "去读 package.json",
    ...extra,
  });

describe("ClaudeTaskProtocolSource", () => {
  test("task_started 声明子代理：标题优先取 Task 调用的 name，时间线以 prompt 开头", () => {
    const source = new ClaudeTaskProtocolSource({
      getToolInput: (id) => (id === "toolu_a" ? { name: "读取员" } : null),
    });
    expect(source.isActive).toBe(false);
    const observations = source.observe(started("t1", "toolu_a"));
    expect(observations).toEqual([
      { kind: "declared", id: "toolu_a", toolCallId: "toolu_a", title: "读取员", description: "读文件" },
      { kind: "subtitle", id: "toolu_a", subtitle: "读取员" },
      { kind: "timeline", id: "toolu_a", item: { type: "user_message", text: "去读 package.json" } },
    ]);
    expect(source.isActive).toBe(true);
    expect(source.resolveSubagentId("toolu_a")).toBe("toolu_a");
    expect(source.needsSyntheticParentToolCard("toolu_a")).toBe(true);
    expect(foldSubagentObservations(observations)[0]).toEqual({
      type: "upsert",
      id: "toolu_a",
      status: "running",
      title: "读取员",
      description: "读文件",
      toolCallId: "toolu_a",
    });
  });

  test("过滤 local_bash 与 skip_transcript 的任务，但仍记为公告过 task", () => {
    const source = new ClaudeTaskProtocolSource();
    expect(source.observe(started("bg", "toolu_bash", { task_type: "local_bash" }))).toEqual([]);
    expect(source.announcesTasks).toBe(true);
    expect(source.isActive).toBe(false);
    expect(source.observe(started("st", "toolu_skip", { skip_transcript: true }))).toEqual([]);
    expect(source.resolveSubagentId("toolu_bash")).toBeUndefined();
    // 被过滤任务的通知不会冒出无名行
    expect(source.observe(system("task_notification", { task_id: "bg", status: "completed" }))).toEqual([]);
  });

  test("同一 task 以新的 tool_use_id 再次公告时视为别名，状态回到 running", () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(started("t1", "toolu_a"));
    source.observe(system("task_notification", { task_id: "t1", status: "completed" }));
    const again = source.observe(started("t1", "toolu_b", { prompt: "继续" }));
    expect(again).toEqual([
      { kind: "status", id: "toolu_a", status: "running" },
      { kind: "timeline", id: "toolu_a", item: { type: "user_message", text: "继续" } },
    ]);
    expect(source.resolveSubagentId("toolu_b")).toBe("toolu_a");
  });

  test("状态映射：killed → canceled，failed → failed；重复状态不重复广播", () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(started("t1", "toolu_a"));
    source.observe(started("t2", "toolu_b"));
    expect(source.observe(system("task_updated", { task_id: "t1", patch: { status: "running" } }))).toEqual([]);
    expect(source.observe(system("task_updated", { task_id: "t1", patch: { status: "killed" } }))).toEqual([
      { kind: "status", id: "toolu_a", status: "canceled" },
    ]);
    expect(source.observe(system("task_notification", { task_id: "t2", status: "failed" }))).toEqual([
      { kind: "status", id: "toolu_b", status: "failed" },
    ]);
  });

  test("取消回合只结束前台子代理；进程丢失时全部 failed", () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(started("t1", "toolu_fg"));
    source.observe(started("t2", "toolu_bg"));
    source.observe(system("task_updated", { task_id: "t2", patch: { is_backgrounded: true } }));
    expect(source.cancelRunningForegroundTasks()).toEqual([{ kind: "status", id: "toolu_fg", status: "canceled" }]);
    expect(source.failRunningTasks()).toEqual([{ kind: "status", id: "toolu_bg", status: "failed" }]);
    expect(source.failRunningTasks()).toEqual([]);
  });

  test("sidechain 帧：读出模型与用量组成 subtitle；嵌套子代理挂到上级并不需要父卡片", () => {
    const source = new ClaudeTaskProtocolSource();
    source.observe(started("t1", "toolu_a"));
    expect(
      source.observeSidechainFrame(
        assistant("toolu_a", [{ type: "tool_use", id: "toolu_nested", name: "Agent", input: {} }], "claude-haiku-4-5-20251001"),
        "toolu_a",
      ),
    ).toEqual([{ kind: "subtitle", id: "toolu_a", subtitle: "Explore · Haiku 4.5" }]);
    // <synthetic> 占位模型被忽略
    expect(source.observeSidechainFrame(assistant("toolu_a", [], "<synthetic>"), "toolu_a")).toEqual([]);

    const nested = source.observe(started("t2", "toolu_nested", { subagent_type: "Plan" }));
    expect(nested[0]).toMatchObject({ kind: "declared", id: "toolu_nested", parentSubagentId: "toolu_a" });
    expect(source.needsSyntheticParentToolCard("toolu_nested")).toBe(false);
  });
});

describe("ClaudeSidechainTracker", () => {
  test("task 协议缺席：由帧推导描述 upsert，工具调用 / 结果 / 文本写入时间线，父卡片累积 log", () => {
    const tracker = new ClaudeSidechainTracker({
      getToolInput: () => ({ subagent_type: "Explore", description: "读 package.json" }),
    });
    const first = tracker.handleMessage(
      assistant("toolu_task", [
        { type: "text", text: "我来读" },
        { type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "package.json" } },
      ]),
      "toolu_task",
    );
    expect(first.events[0]).toEqual({
      type: "upsert",
      id: "toolu_task",
      title: "Explore",
      description: "读 package.json",
      status: "running",
      toolCallId: "toolu_task",
    });
    expect(first.events.slice(1).map((e) => (e.type === "timeline" ? e.item.type : e.type))).toEqual([
      "assistant_message",
      "tool_call",
    ]);
    expect(first.parentCard).toEqual({
      type: "tool_call",
      callId: "toolu_task",
      name: "Task",
      status: "running",
      error: null,
      detail: {
        type: "sub_agent",
        subAgentType: "Explore",
        description: "读 package.json",
        log: "[Read] package.json",
        actions: [],
      },
    });

    const second = tracker.handleMessage(toolResult("toolu_task", "toolu_read", '{"name":"demo"}'), "toolu_task");
    const resultItem = second.events.find((e) => e.type === "timeline");
    expect(resultItem).toMatchObject({ item: { type: "tool_call", callId: "toolu_read", status: "completed" } });

    // 重复的结果不再重复写入
    expect(tracker.handleMessage(toolResult("toolu_task", "toolu_read", "x"), "toolu_task").events).toEqual([]);

    expect(tracker.finish("toolu_task", "completed")).toEqual([
      expect.objectContaining({ type: "upsert", id: "toolu_task", status: "completed" }),
    ]);
    expect(tracker.finish("toolu_task", "completed")).toEqual([]);
  });

  test("task 协议在场时不发描述 upsert；不需要父卡片时 parentCard 为 null；失败结果映射为 failed", () => {
    const tracker = new ClaudeSidechainTracker({
      getToolInput: () => null,
      isDescriptorOwnedElsewhere: () => true,
      needsSyntheticParentToolCard: () => false,
    });
    tracker.handleMessage(
      assistant("toolu_task", [{ type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "ls" } }]),
      "toolu_task",
    );
    const output = tracker.handleMessage(toolResult("toolu_task", "toolu_bash", "boom", true), "toolu_task");
    expect(output.parentCard).toBeNull();
    expect(output.events).toEqual([
      expect.objectContaining({ type: "timeline", item: expect.objectContaining({ callId: "toolu_bash", status: "failed" }) }),
    ]);
    expect(tracker.finishAll("failed")).toEqual([]);
  });
});
