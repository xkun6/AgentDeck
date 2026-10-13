import { describe, expect, it } from "vitest";
import {
  backgroundTaskPillLabel,
  backgroundTaskStatusText,
  formatElapsed,
  taskElapsedMs,
  taskUsageText,
} from "./background-task-presentation";

describe("backgroundTaskPillLabel", () => {
  it("有运行中显示运行中数量，否则显示已结束总数", () => {
    expect(backgroundTaskPillLabel([{ status: "running" }, { status: "completed" }, { status: "running" }])).toBe("2 运行中");
    expect(backgroundTaskPillLabel([{ status: "completed" }, { status: "failed" }, { status: "stopped" }])).toBe("3 个已结束");
  });
});

describe("backgroundTaskStatusText", () => {
  it("四种状态的中文文案", () => {
    expect(["running", "completed", "failed", "stopped"].map((s) => backgroundTaskStatusText(s as "running"))).toEqual([
      "运行中",
      "已完成",
      "失败",
      "已停止",
    ]);
  });
});

describe("formatElapsed / taskElapsedMs", () => {
  it("mm:ss，满一小时 h:mm:ss", () => {
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(65_900)).toBe("01:05");
    expect(formatElapsed(3_600_000)).toBe("1:00:00");
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
    expect(formatElapsed(-5)).toBe("00:00");
  });

  it("运行中按 now 计时，结束后用 endedAt", () => {
    expect(taskElapsedMs({ status: "running", startedAt: 1_000 }, 6_000)).toBe(5_000);
    expect(taskElapsedMs({ status: "completed", startedAt: 1_000, endedAt: 3_000 }, 99_000)).toBe(2_000);
    expect(taskElapsedMs({ status: "stopped", startedAt: 1_000 }, 99_000)).toBe(0);
  });
});

describe("taskUsageText", () => {
  it("子代理 / workflow 显示 token 与工具次数，命令不显示", () => {
    expect(taskUsageText({ kind: "agent", usage: { totalTokens: 12_345, toolUses: 5 } })).toBe("12.3k tokens · 5 次工具");
    expect(taskUsageText({ kind: "workflow", usage: { totalTokens: 800 } })).toBe("800 tokens");
    expect(taskUsageText({ kind: "agent", usage: { totalTokens: 2_000 } })).toBe("2k tokens");
    expect(taskUsageText({ kind: "command", usage: { totalTokens: 1 } })).toBeNull();
    expect(taskUsageText({ kind: "agent" })).toBeNull();
  });
});
