import { describe, expect, test } from "vitest";

import { OutputSpeedTracker } from "../src/providers/shared/output-speed.js";

/** 在 [from, to] 毫秒内生成一次响应并结束 */
function respond(tracker: OutputSpeedTracker, setNow: (t: number) => void, from: number, to: number, tokens: number) {
  setNow(from);
  tracker.markOutput();
  setNow(to);
  tracker.endResponse(tokens);
}

describe("OutputSpeedTracker（按单次响应记账，对齐 cc-switch，design.md 4.30）", () => {
  test("输出 < 100 token 的响应（工具调用）不计入；没有合格响应返回 undefined", () => {
    let now = 0;
    const tracker = new OutputSpeedTracker(() => now);
    respond(tracker, (t) => (now = t), 0, 2000, 99);
    expect(tracker.speed()).toBeUndefined();
    // 进行中的响应同样要达到 100 token 才计入实时值
    tracker.markOutput();
    now = 4000;
    expect(tracker.speed(99)).toBeUndefined();
  });

  test("生成时长 < 100ms 的响应不计入", () => {
    let now = 0;
    const tracker = new OutputSpeedTracker(() => now);
    respond(tracker, (t) => (now = t), 0, 99, 500);
    expect(tracker.speed()).toBeUndefined();
    respond(tracker, (t) => (now = t), 1000, 1100, 500); // 恰好 100ms 合格：500 ÷ 0.1 秒
    expect(tracker.speed()).toBe(5000);
  });

  test("多次合格响应按 Σ token ÷ Σ 时长汇总，而不是逐条平均", () => {
    let now = 0;
    const tracker = new OutputSpeedTracker(() => now);
    respond(tracker, (t) => (now = t), 0, 1000, 100); // 100 tok/s
    respond(tracker, (t) => (now = t), 5000, 7000, 1000); // 500 tok/s
    // Σ = 1100 token ÷ 3 秒 = 366.7（逐条平均会是 300）
    expect(tracker.speed()).toBe(366.7);
  });

  test("进行中的响应达到门槛才计入实时值", () => {
    let now = 0;
    const tracker = new OutputSpeedTracker(() => now);
    respond(tracker, (t) => (now = t), 0, 1000, 100); // 合格：100 token / 1 秒
    now = 2000;
    tracker.markOutput();
    now = 4000;
    expect(tracker.speed(50)).toBe(100); // 进行中 50 token 不够，只有合格累计
    expect(tracker.speed(300)).toBe(133.3); // (100 + 300) ÷ (1 + 2) 秒
    expect(tracker.speed()).toBe(100); // 不传当前响应 token 等同 0
    now = 4050;
    expect(tracker.speed(300)).toBe(131.1); // 400 ÷ (1 + 2.05) 秒
  });

  test("进行中的响应生成不足 100ms 时不计入实时值", () => {
    let now = 0;
    const tracker = new OutputSpeedTracker(() => now);
    respond(tracker, (t) => (now = t), 0, 1000, 100);
    now = 2000;
    tracker.markOutput();
    now = 2099;
    expect(tracker.speed(1000)).toBe(100);
    now = 2100;
    expect(tracker.speed(1000)).toBe(Math.round((1100 / 1.1) * 10) / 10); // 1000
  });

  test("endResponse 重复调用不重复计入", () => {
    let now = 0;
    const tracker = new OutputSpeedTracker(() => now);
    respond(tracker, (t) => (now = t), 0, 2000, 200); // 100 tok/s
    tracker.endResponse(200); // 第二次：没有生成时长，自然忽略
    tracker.endResponse(200);
    expect(tracker.speed()).toBe(100);
  });

  test("段内重复 markOutput 不移动起点；没有开段时 markIdle 无效", () => {
    let now = 0;
    const tracker = new OutputSpeedTracker(() => now);
    tracker.markIdle(); // 未开段：无事发生
    tracker.markOutput();
    now = 1000;
    tracker.markOutput();
    now = 2000;
    tracker.markOutput();
    tracker.endResponse(200); // 200 token ÷ 2 秒（起点仍是 0）
    expect(tracker.speed()).toBe(100);
  });

  test("同一响应被 markIdle 切成多段时时长累加，段间空隙不计入", () => {
    let now = 0;
    const tracker = new OutputSpeedTracker(() => now);
    tracker.markOutput();
    now = 2000;
    tracker.markIdle(); // 第一段 2 秒
    now = 32_000; // 空隙 30 秒（工具执行）
    tracker.markOutput();
    now = 35_000;
    tracker.endResponse(500); // 第二段 3 秒：500 ÷ (2 + 3) 秒
    expect(tracker.speed()).toBe(100);
  });

  test("permission_requested 切开同一响应，审批等待不计入；其它事件不影响", () => {
    let now = 0;
    const tracker = new OutputSpeedTracker(() => now);
    tracker.markOutput();
    now = 2000;
    tracker.observe({ type: "timeline" });
    tracker.observe({ type: "permission_resolved" });
    tracker.observe({ type: "permission_requested" }); // 闭段：2 秒
    now = 62_000; // 审批等了 60 秒
    tracker.markOutput(); // 审批通过后继续输出，开新段
    now = 64_000;
    tracker.endResponse(400); // 400 ÷ (2 + 2) 秒
    expect(tracker.speed()).toBe(100);
  });

  test("throttledSpeed 每秒最多下发一次，没有值时不占用节流额度", () => {
    let now = 0;
    const tracker = new OutputSpeedTracker(() => now);
    expect(tracker.throttledSpeed(1000)).toBeUndefined(); // 没开段，没有值
    respond(tracker, (t) => (now = t), 0, 1000, 100);
    expect(tracker.throttledSpeed()).toBe(100);
    now = 1500;
    expect(tracker.throttledSpeed()).toBeUndefined(); // 距上次下发不足 1 秒
    now = 2000;
    expect(tracker.throttledSpeed()).toBe(100);
  });

  test("reset 清零生成段、当前响应、合格累计与节流状态", () => {
    let now = 0;
    const tracker = new OutputSpeedTracker(() => now);
    respond(tracker, (t) => (now = t), 0, 1000, 100);
    expect(tracker.throttledSpeed()).toBe(100);
    tracker.markOutput();
    now = 1500;
    tracker.markIdle();
    tracker.markOutput();
    tracker.reset();
    now = 9000;
    expect(tracker.speed(1000)).toBeUndefined();
    // 节流状态也清了：reset 之后立刻允许下发
    respond(tracker, (t) => (now = t), 9000, 10_000, 200);
    expect(tracker.throttledSpeed()).toBe(200);
  });
});
