import { describe, expect, it } from "vitest";
import type { AgentRateLimits } from "@agentdeck/protocol";
import {
  formatClock,
  formatResetTime,
  formatTokensPerSecond,
  rateLimitChipLabel,
  rateLimitTone,
  rateLimitWindowShortLabel,
  speedChipState,
  todoChipLabel,
  todoProgress,
  todoStepStatus,
} from "./status-row-presentation";

const limits = (windows: AgentRateLimits["windows"], status?: AgentRateLimits["status"]): AgentRateLimits => ({
  windows,
  ...(status ? { status } : {}),
  updatedAt: 0,
});

describe("步骤计数与进行中判定", () => {
  const items = [
    { text: "a", completed: true },
    { text: "b", completed: false },
    { text: "c", completed: false },
  ];

  it("已完成数 / 总数；回合进行中第一条未完成项为进行中，空闲时没有进行中项", () => {
    const busy = todoProgress(items, true);
    expect(busy).toMatchObject({ done: 1, total: 3, allDone: false, currentIndex: 1 });
    expect(items.map((item, i) => todoStepStatus(item, i, busy))).toEqual(["completed", "in_progress", "pending"]);
    const idle = todoProgress(items, false);
    expect(idle.currentIndex).toBe(-1);
    expect(items.map((item, i) => todoStepStatus(item, i, idle))).toEqual(["completed", "pending", "pending"]);
    expect(todoChipLabel(busy)).toBe("1/3");
  });

  it("全部完成显示「N/N ✓」，没有进行中项", () => {
    const done = todoProgress([{ text: "a", completed: true }, { text: "b", completed: true }], true);
    expect(done).toMatchObject({ allDone: true, currentIndex: -1 });
    expect(todoChipLabel(done)).toBe("2/2 ✓");
  });
});

describe("额度芯片文字与颜色", () => {
  const five = { id: "five_hour", label: "5 小时", usedPercent: 3.2 };
  const seven = { id: "seven_day", label: "7 天", usedPercent: 96 };

  it("窗口简写：5 小时→5h、7 天 / 每周→7d，其它取 label", () => {
    expect(rateLimitWindowShortLabel(five)).toBe("5h");
    expect(rateLimitWindowShortLabel(seven)).toBe("7d");
    expect(rateLimitWindowShortLabel({ id: "secondary", label: "每周", usedPercent: 1 })).toBe("7d");
    expect(rateLimitWindowShortLabel({ id: "primary", label: "5 小时", usedPercent: 1 })).toBe("5h");
    expect(rateLimitWindowShortLabel({ id: "secondary", label: "3 天", usedPercent: 1 })).toBe("3 天");
    expect(rateLimitWindowShortLabel({ id: "seven_day_opus", label: "seven_day_opus", usedPercent: 1 })).toBe(
      "seven_day_opus",
    );
  });

  it("文字「5h 3% · 7d 96%」，百分比四舍五入", () => {
    expect(rateLimitChipLabel(limits([five, seven]))).toBe("5h 3% · 7d 96%");
  });

  it("颜色阈值：任一窗口 ≥ 80% 为警告，79% 正常，rejected 为危险（优先）", () => {
    expect(rateLimitTone(limits([five, { ...seven, usedPercent: 79 }]))).toBe("normal");
    expect(rateLimitTone(limits([five, { ...seven, usedPercent: 80 }]))).toBe("warn");
    expect(rateLimitTone(limits([five, seven], "allowed"))).toBe("warn");
    expect(rateLimitTone(limits([five], "rejected"))).toBe("err");
  });
});

describe("重置时间格式", () => {
  const at = (month: number, day: number, hour: number, minute: number) =>
    new Date(2026, month - 1, day, hour, minute).getTime();

  it("HH:mm 补零", () => {
    expect(formatClock(at(10, 14, 9, 5))).toBe("09:05");
  });

  it("今天只显示「HH:mm 重置」，不在今天显示「M月D日 HH:mm 重置」", () => {
    const now = at(10, 14, 8, 0);
    expect(formatResetTime(at(10, 14, 13, 30), now)).toBe("13:30 重置");
    expect(formatResetTime(at(10, 16, 7, 5), now)).toBe("10月16日 07:05 重置");
    expect(formatResetTime(at(11, 1, 0, 0), now)).toBe("11月1日 00:00 重置");
  });
});

describe("输出速度格式与空闲弱化", () => {
  it("≥ 1 取整，不足 1 保留 1 位小数", () => {
    expect(formatTokensPerSecond(42.46)).toBe("42 tok/s");
    expect(formatTokensPerSecond(8)).toBe("8 tok/s");
    expect(formatTokensPerSecond(99.94)).toBe("100 tok/s");
    expect(formatTokensPerSecond(1)).toBe("1 tok/s");
    expect(formatTokensPerSecond(0.96)).toBe("1.0 tok/s");
    expect(formatTokensPerSecond(0.54)).toBe("0.5 tok/s");
    expect(formatTokensPerSecond(1234.6)).toBe("1235 tok/s");
  });

  it("回合中实时值不弱化；空闲为上一回合最终值（弱化 + 悬停提示）；没有值时为 null", () => {
    expect(speedChipState({ outputTokensPerSecond: 50 }, true)).toEqual({
      text: "50 tok/s",
      idle: false,
      title: "当前输出速度",
    });
    expect(speedChipState({ outputTokensPerSecond: 50 }, false)).toEqual({
      text: "50 tok/s",
      idle: true,
      title: "上一回合平均输出速度",
    });
    expect(speedChipState(undefined, true)).toBeNull();
    expect(speedChipState({ inputTokens: 1 }, false)).toBeNull();
    expect(speedChipState({ outputTokensPerSecond: 0 }, false)).toBeNull();
    expect(speedChipState({ outputTokensPerSecond: Number.NaN }, false)).toBeNull();
  });
});
