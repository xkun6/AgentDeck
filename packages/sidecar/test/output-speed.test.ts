import { describe, expect, test } from "vitest";

import { OutputSpeedTracker } from "../src/providers/shared/output-speed.js";

describe("OutputSpeedTracker（纯生成速度，design.md 4.30）", () => {
  test("没有 token 或累计生成时长不足 1 秒时不计算；之后按 token ÷ 秒并保留 1 位小数", () => {
    let now = 10_000;
    const tracker = new OutputSpeedTracker(() => now);
    expect(tracker.speed(100)).toBeUndefined();
    tracker.markOutput();
    now += 999;
    expect(tracker.speed(100)).toBeUndefined();
    now += 1;
    expect(tracker.speed(100)).toBe(100);
    expect(tracker.speed(0)).toBeUndefined();
    now += 2000;
    expect(tracker.speed(100)).toBe(33.3);
  });

  test("段内重复 markOutput 无效，不移动起点；没有开段时 markIdle 无效", () => {
    let now = 0;
    const tracker = new OutputSpeedTracker(() => now);
    tracker.markIdle(); // 未开段：无事发生
    expect(tracker.speed(10)).toBeUndefined();
    tracker.markOutput();
    now = 1000;
    tracker.markOutput();
    now = 2000;
    tracker.markOutput();
    expect(tracker.speed(100)).toBe(50);
    tracker.markIdle();
    tracker.markIdle(); // 重复关闭不会重复累计
    now = 5000;
    expect(tracker.speed(100)).toBe(50);
  });

  test("多个生成段累计，段间空隙（首 token 等待 / 工具执行）不计入", () => {
    let now = 0;
    const tracker = new OutputSpeedTracker(() => now);
    // 第一段：0–2 秒
    tracker.markOutput();
    now = 2000;
    tracker.markIdle();
    // 空隙 30 秒（工具执行）
    now = 32_000;
    expect(tracker.speed(40)).toBe(20); // 仍是 40 ÷ 2 秒
    // 第二段：32–35 秒
    tracker.markOutput();
    now = 35_000;
    expect(tracker.speed(100)).toBe(20); // 段内：2 + 3 = 5 秒
    tracker.markIdle();
    now = 100_000;
    expect(tracker.speed(100)).toBe(20);
  });

  test("permission_requested 关闭当前生成段；其它事件不影响", () => {
    let now = 0;
    const tracker = new OutputSpeedTracker(() => now);
    tracker.markOutput();
    now = 2000;
    tracker.observe({ type: "timeline" });
    tracker.observe({ type: "permission_resolved" });
    expect(tracker.speed(40)).toBe(20); // 段仍在继续
    tracker.observe({ type: "permission_requested" });
    now = 62_000; // 审批等了 60 秒
    expect(tracker.speed(40)).toBe(20);
    // 审批通过后模型继续输出，开新段
    tracker.markOutput();
    now = 64_000;
    expect(tracker.speed(80)).toBe(20); // 80 token ÷ (2 + 2) 秒
  });

  test("累计生成时长不足 1 秒（含已关闭的短段）返回 undefined", () => {
    let now = 0;
    const tracker = new OutputSpeedTracker(() => now);
    tracker.markOutput();
    now = 500;
    tracker.markIdle();
    now = 60_000;
    expect(tracker.speed(10)).toBeUndefined();
    tracker.markOutput();
    now = 60_500;
    expect(tracker.speed(10)).toBe(10); // 0.5 + 0.5 = 1 秒
  });

  test("throttledSpeed 每秒最多下发一次", () => {
    let now = 0;
    const tracker = new OutputSpeedTracker(() => now);
    tracker.markOutput();
    now = 1000;
    expect(tracker.throttledSpeed(10)).toBe(10);
    now = 1500;
    expect(tracker.throttledSpeed(15)).toBeUndefined();
    now = 2000;
    expect(tracker.throttledSpeed(20)).toBe(10);
  });

  test("不足 1 秒的 throttledSpeed 不占用节流额度", () => {
    let now = 0;
    const tracker = new OutputSpeedTracker(() => now);
    tracker.markOutput();
    now = 500;
    expect(tracker.throttledSpeed(10)).toBeUndefined();
    now = 1000;
    expect(tracker.throttledSpeed(10)).toBe(10);
  });

  test("reset 清零生成段、累计时长与节流状态", () => {
    let now = 0;
    const tracker = new OutputSpeedTracker(() => now);
    tracker.markOutput();
    now = 1000;
    expect(tracker.throttledSpeed(10)).toBe(10);
    tracker.markIdle();
    tracker.markOutput();
    tracker.reset();
    now = 9000;
    expect(tracker.speed(20)).toBeUndefined();
    // 节流状态也清了：reset 之后立刻允许下发
    tracker.markOutput();
    now = 10_000;
    expect(tracker.throttledSpeed(20)).toBe(20);
  });
});
