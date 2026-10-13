import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentBackgroundTask } from "@agentdeck/protocol";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ClaudeBackgroundTaskRegistry, readFileTail } from "../../../src/providers/claude/background-tasks.js";
import type { ClaudeOutputMessage } from "../../../src/providers/claude/stream-json-types.js";

function system(subtype: string, fields: Record<string, unknown>): ClaudeOutputMessage {
  return { type: "system", subtype, session_id: "s", ...fields } as unknown as ClaudeOutputMessage;
}

function setup() {
  let now = 1_000_000;
  const snapshots: AgentBackgroundTask[][] = [];
  const registry = new ClaudeBackgroundTaskRegistry({
    onChange: (tasks) => snapshots.push(tasks),
    now: () => now,
  });
  return {
    registry,
    snapshots,
    advance: (ms: number) => {
      now += ms;
    },
    last: () => snapshots.at(-1)!,
  };
}

const bashStarted = (taskId = "bk1", toolUseId = "toolu_b") =>
  system("task_started", { task_id: taskId, tool_use_id: toolUseId, description: "pnpm build", task_type: "local_bash" });

const OUTPUT_TEXT =
  "Command running in background with ID: bk1. Output is being written to: C:\\Users\\x\\tasks\\bk1.output";

describe("ClaudeBackgroundTaskRegistry：登记", () => {
  test("local_bash 登记（无 is_backgrounded），随后工具结果带来输出路径 → hasOutput", () => {
    const t = setup();
    t.registry.observe(bashStarted());
    expect(t.last()).toEqual([
      { taskId: "bk1", kind: "command", description: "pnpm build", status: "running", startedAt: 1_000_000 },
    ]);
    t.registry.observeToolResult("toolu_b", OUTPUT_TEXT);
    expect(t.last()[0]).toMatchObject({ hasOutput: true });
    expect(t.registry.getOutputPath("bk1")).toBe("C:\\Users\\x\\tasks\\bk1.output");
  });

  test("工具结果先于 task_started 到达时也能关联；无关文本与非命令任务不取路径", () => {
    const t = setup();
    t.registry.observeToolResult("toolu_b", OUTPUT_TEXT);
    t.registry.observeToolResult("toolu_x", "普通输出");
    t.registry.observe(bashStarted());
    expect(t.registry.getOutputPath("bk1")).toBe("C:\\Users\\x\\tasks\\bk1.output");
    expect(t.last()[0]).toMatchObject({ hasOutput: true });
    t.registry.observe(
      system("task_started", {
        task_id: "a1",
        tool_use_id: "toolu_x",
        description: "子代理",
        task_type: "local_agent",
        is_backgrounded: true,
      }),
    );
    expect(t.registry.getOutputPath("a1")).toBeUndefined();
  });

  test("前台子代理不登记，task_updated 转入后台后才登记；workflow / 其它类型同理", () => {
    const t = setup();
    t.registry.observe(
      system("task_started", {
        task_id: "a1",
        tool_use_id: "toolu_a",
        description: "读文件",
        task_type: "local_agent",
        is_backgrounded: false,
      }),
    );
    t.registry.observe(system("task_started", { task_id: "w1", description: "流程", task_type: "local_workflow" }));
    t.registry.observe(
      system("task_started", { task_id: "o1", description: "杂项", task_type: "monitor", is_backgrounded: true }),
    );
    expect(t.registry.list().map((x) => [x.taskId, x.kind])).toEqual([["o1", "other"]]);
    expect(t.registry.has("a1")).toBe(false);

    t.registry.observe(system("task_updated", { task_id: "a1", patch: { is_backgrounded: true } }));
    t.registry.observe(system("task_updated", { task_id: "w1", patch: { is_backgrounded: true } }));
    expect(t.registry.list().map((x) => [x.taskId, x.kind])).toEqual([
      ["a1", "agent"],
      ["w1", "workflow"],
      ["o1", "other"],
    ]);
  });

  test("前台子代理的 progress / notification 不推送", () => {
    const t = setup();
    t.registry.observe(system("task_started", { task_id: "a1", description: "读", task_type: "local_agent" }));
    t.registry.observe(system("task_progress", { task_id: "a1", usage: { total_tokens: 5 } }));
    t.registry.observe(system("task_notification", { task_id: "a1", status: "completed" }));
    expect(t.snapshots).toHaveLength(0);
  });
});

describe("ClaudeBackgroundTaskRegistry：状态与进度", () => {
  test("task_updated 状态映射：paused → running，killed → stopped，带 end_time / error / description", () => {
    const t = setup();
    t.registry.observe(bashStarted());
    t.registry.observe(system("task_updated", { task_id: "bk1", patch: { status: "paused" } }));
    expect(t.last()[0]!.status).toBe("running");
    t.registry.observe(
      system("task_updated", {
        task_id: "bk1",
        patch: { status: "killed", end_time: 1_005_000, error: "被终止", description: "pnpm build（新）" },
      }),
    );
    expect(t.last()[0]).toMatchObject({
      status: "stopped",
      endedAt: 1_005_000,
      error: "被终止",
      description: "pnpm build（新）",
    });
    t.registry.observe(system("task_updated", { task_id: "bk1", patch: { status: "failed" } }));
    expect(t.last()[0]!.status).toBe("failed");
  });

  test("task_progress 合并 usage / lastToolName / summary，且节流到约 1 秒一次（尾部补发最新值）", () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      t.registry.observe(
        system("task_started", { task_id: "a1", description: "读", task_type: "local_agent", is_backgrounded: true }),
      );
      expect(t.snapshots).toHaveLength(1);
      // 同一毫秒内的进度被节流，定时器到点补发最新整表
      t.registry.observe(
        system("task_progress", {
          task_id: "a1",
          usage: { total_tokens: 10, tool_uses: 1, duration_ms: 100 },
          last_tool_name: "Read",
        }),
      );
      t.registry.observe(
        system("task_progress", {
          task_id: "a1",
          usage: { total_tokens: 20, tool_uses: 2, duration_ms: 200 },
          last_tool_name: "Grep",
          summary: "在搜索",
        }),
      );
      expect(t.snapshots).toHaveLength(1);
      vi.advanceTimersByTime(1_000);
      expect(t.snapshots).toHaveLength(2);
      expect(t.last()[0]).toMatchObject({
        usage: { totalTokens: 20, toolUses: 2, durationMs: 200 },
        lastToolName: "Grep",
        summary: "在搜索",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("状态变化立即推送（不受节流影响）", () => {
    const t = setup();
    t.registry.observe(bashStarted());
    t.registry.observe(system("task_progress", { task_id: "bk1", usage: { total_tokens: 1 } }));
    const before = t.snapshots.length;
    t.registry.observe(
      system("task_notification", {
        task_id: "bk1",
        status: "completed",
        summary: 'Background command "pnpm build" completed (exit code 0)',
      }),
    );
    expect(t.snapshots).toHaveLength(before + 1);
    expect(t.last()[0]).toMatchObject({
      status: "completed",
      endedAt: 1_000_000,
      summary: expect.stringContaining("exit code 0"),
    });
  });

  test("task_notification：failed / stopped；命令的 output_file 作为兜底输出路径，子代理的不算", () => {
    const t = setup();
    t.registry.observe(bashStarted("bk1", "toolu_1"));
    t.registry.observe(bashStarted("bk2", "toolu_2"));
    t.registry.observe(
      system("task_started", { task_id: "a1", description: "子代理", task_type: "local_agent", is_backgrounded: true }),
    );
    t.registry.observe(system("task_notification", { task_id: "bk1", status: "failed", output_file: "C:\\t\\bk1.output" }));
    t.registry.observe(system("task_notification", { task_id: "bk2", status: "stopped" }));
    t.registry.observe(
      system("task_notification", {
        task_id: "a1",
        status: "completed",
        output_file: "C:\\t\\a1.jsonl",
        usage: { total_tokens: 9 },
      }),
    );
    const byId = Object.fromEntries(t.last().map((x) => [x.taskId, x]));
    expect(byId.bk1).toMatchObject({ status: "failed", hasOutput: true });
    expect(byId.bk2).toMatchObject({ status: "stopped" });
    expect(byId.a1!.hasOutput).toBeUndefined();
    expect(byId.a1!.usage).toEqual({ totalTokens: 9 });
    expect(t.registry.getOutputPath("bk1")).toBe("C:\\t\\bk1.output");
    expect(t.registry.getOutputPath("a1")).toBeUndefined();
  });

  test("会话结束：仍在运行的任务标为已停止（会话已结束），已结束的不动", () => {
    const t = setup();
    t.registry.observe(bashStarted("bk1", "toolu_1"));
    t.registry.observe(bashStarted("bk2", "toolu_2"));
    t.registry.observe(system("task_notification", { task_id: "bk2", status: "completed" }));
    t.advance(5_000);
    t.registry.markSessionEnded();
    const byId = Object.fromEntries(t.last().map((x) => [x.taskId, x]));
    expect(byId.bk1).toMatchObject({ status: "stopped", error: "会话已结束", endedAt: 1_005_000 });
    expect(byId.bk2).toMatchObject({ status: "completed" });
    expect(byId.bk2!.error).toBeUndefined();
  });
});

describe("readFileTail", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "agentdeck-tail-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("文件不存在返回空文本；小文件整体返回", async () => {
    await expect(readFileTail(path.join(dir, "none.output"), 1024)).resolves.toEqual({
      text: "",
      truncated: false,
      size: 0,
    });
    const file = path.join(dir, "a.output");
    writeFileSync(file, "line1\nline2\n");
    await expect(readFileTail(file, 1024)).resolves.toEqual({ text: "line1\nline2\n", truncated: false, size: 12 });
  });

  test("超过 maxBytes：取尾部并丢弃不完整首行", async () => {
    const file = path.join(dir, "b.output");
    writeFileSync(file, "aaaa1\nbbbb2\ncccc3\n");
    const result = await readFileTail(file, 9);
    expect(result).toEqual({ text: "cccc3\n", truncated: true, size: 18 });
  });

  test("按 UTF-8 解码：截断落在多字节字符中间时不产生乱码", async () => {
    const file = path.join(dir, "c.output");
    writeFileSync(file, "你好世界你好世界", "utf8");
    const result = await readFileTail(file, 7);
    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain("\uFFFD");
    expect("你好世界你好世界".endsWith(result.text)).toBe(true);
  });
});
