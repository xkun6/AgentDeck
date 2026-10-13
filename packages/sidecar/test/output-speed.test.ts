import { describe, expect, test } from "vitest";

import { OutputSpeedTracker } from "../src/providers/shared/output-speed.js";

describe("OutputSpeedTracker（design.md 4.30）", () => {
  test("没有首个输出、不足 1 秒或没有 token 时不计算；之后按 token ÷ 秒并保留 1 位小数", () => {
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
    // 重复 markOutput 不移动起点
    tracker.markOutput();
    expect(tracker.speed(100)).toBe(33.3);
  });

  test("throttledSpeed 每秒最多下发一次；reset 清掉起点", () => {
    let now = 0;
    const tracker = new OutputSpeedTracker(() => now);
    tracker.markOutput();
    now = 1000;
    expect(tracker.throttledSpeed(10)).toBe(10);
    now = 1500;
    expect(tracker.throttledSpeed(15)).toBeUndefined();
    now = 2000;
    expect(tracker.throttledSpeed(20)).toBe(10);
    tracker.reset();
    now = 9000;
    expect(tracker.speed(20)).toBeUndefined();
  });
});
