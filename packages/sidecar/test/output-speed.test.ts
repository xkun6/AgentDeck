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

  describe("审批等待不计入耗时", () => {
    const requested = (id: string) => ({ type: "permission_requested", request: { id } });
    const resolved = (id: string) => ({ type: "permission_resolved", requestId: id });

    test("permission_requested → permission_resolved 之间的时间从分母里扣除", () => {
      let now = 0;
      const tracker = new OutputSpeedTracker(() => now);
      tracker.markOutput();
      now = 2_000;
      tracker.observe(requested("p1"));
      now = 62_000; // 等了 60 秒
      // 等待期间：只算审批前的 2 秒
      expect(tracker.speed(40)).toBe(20);
      tracker.observe(resolved("p1"));
      now = 64_000; // 之后又输出了 2 秒
      expect(tracker.speed(80)).toBe(20); // 80 token ÷ 4 秒，而不是 ÷ 64 秒
    });

    test("首个输出之前的等待本来就不在分母里，不会被重复扣除", () => {
      let now = 0;
      const tracker = new OutputSpeedTracker(() => now);
      tracker.observe(requested("p1"));
      now = 30_000;
      tracker.observe(resolved("p1"));
      tracker.markOutput();
      now = 32_000;
      expect(tracker.speed(40)).toBe(20);
    });

    test("多个请求同时挂起按并集扣除；未知 / 重复的 resolved 被忽略；reset 清空", () => {
      let now = 0;
      const tracker = new OutputSpeedTracker(() => now);
      tracker.markOutput();
      now = 1_000;
      tracker.observe(requested("a"));
      now = 11_000;
      tracker.observe(requested("b"));
      now = 21_000;
      tracker.observe(resolved("a"));
      now = 31_000;
      tracker.observe(resolved("b"));
      tracker.observe(resolved("b"));
      tracker.observe(resolved("zzz"));
      now = 32_000;
      // 总共 32 秒，其中 1–31 秒（30 秒）在等审批
      expect(tracker.speed(4)).toBe(2);
      tracker.reset();
      tracker.markOutput();
      now = 34_000;
      expect(tracker.speed(4)).toBe(2);
    });

    test("等待中扣到不足 1 秒时不计算", () => {
      let now = 0;
      const tracker = new OutputSpeedTracker(() => now);
      tracker.markOutput();
      now = 500;
      tracker.observe(requested("p1"));
      now = 60_000;
      expect(tracker.speed(10)).toBeUndefined();
    });
  });
});
