import { describe, expect, it } from "vitest";
import {
  backgroundTaskPillLabel,
  backgroundTaskStatusText,
  formatElapsed,
  taskDisplayLabel,
  taskElapsedMs,
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

describe("taskDisplayLabel", () => {
  it("优先用描述；没有描述时取命令首行（跳过空行）；都没有时给兜底文案", () => {
    expect(taskDisplayLabel({ description: "跑构建", command: "pnpm build" })).toBe("跑构建");
    expect(taskDisplayLabel({ description: "  ", command: "\n  cd x && pnpm build\nnext" })).toBe("cd x && pnpm build");
    expect(taskDisplayLabel({ description: "" })).toBe("后台命令");
  });
});
