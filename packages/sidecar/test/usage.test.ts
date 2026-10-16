import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentStreamEnvelope, AgentStreamEvent, UsageTurnRecord } from "@agentdeck/protocol";
import { afterEach, describe, expect, test } from "vitest";

import { AgentManager } from "../src/agent/agent-manager.js";
import { MockAgentClient } from "../src/providers/mock/mock-agent.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { UsageLedger } from "../src/usage/ledger.js";
import { percentile, summarizeUsage } from "../src/usage/summary.js";
import { UsageTurnTracker } from "../src/usage/turn-tracker.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agentdeck-usage-"));
  dirs.push(dir);
  return dir;
}

let seq = 0;
function env(timestamp: number, event: AgentStreamEvent): AgentStreamEnvelope {
  seq += 1;
  return { agentId: "a1", seq, epoch: "e", timestamp, event };
}

function rec(partial: Partial<UsageTurnRecord> & { ts: number }): UsageTurnRecord {
  return {
    agentId: "a1",
    provider: "mock",
    model: null,
    turnId: `t-${partial.ts}`,
    origin: "user",
    outcome: "completed",
    ...partial,
  };
}

describe("UsageTurnTracker", () => {
  test("完成回合：tokens / 费用 / 耗时 / ttft / model", () => {
    const tracker = new UsageTurnTracker("a1", "claude");
    expect(tracker.observe(env(1000, { type: "turn_started", turnId: "t1" }), "opus")).toBeNull();
    expect(
      tracker.observe(
        env(1400, { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "x" } }),
        "opus",
      ),
    ).toBeNull();
    tracker.observe(
      env(1600, { type: "timeline", turnId: "t1", item: { type: "assistant_message", text: "y" } }),
      "opus",
    );
    const record = tracker.observe(
      env(3000, {
        type: "turn_completed",
        turnId: "t1",
        usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 20, totalCostUsd: 0.5 },
      }),
      "sonnet", // 回合进行中切换模型：仍取回合开始时的 model
    );
    expect(record).toEqual({
      ts: 3000,
      agentId: "a1",
      provider: "claude",
      model: "opus",
      turnId: "t1",
      origin: "user",
      outcome: "completed",
      inputTokens: 10,
      cachedInputTokens: 4,
      outputTokens: 20,
      costUsd: 0.5,
      durationMs: 2000,
      ttftMs: 400,
    });
  });

  test("outputTokensPerSecond 与 rate_limits_updated 不进入账本记录（design.md 4.30）", () => {
    const tracker = new UsageTurnTracker("a1", "claude");
    tracker.observe(env(1000, { type: "turn_started", turnId: "t1" }), "opus");
    expect(
      tracker.observe(
        env(1500, {
          type: "rate_limits_updated",
          rateLimits: { windows: [{ id: "five_hour", label: "5 小时", usedPercent: 3 }], updatedAt: 1500 },
        }),
        "opus",
      ),
    ).toBeNull();
    const record = tracker.observe(
      env(3000, {
        type: "turn_completed",
        turnId: "t1",
        usage: { inputTokens: 10, outputTokens: 20, outputTokensPerSecond: 12.5 },
      }),
      "opus",
    );
    expect(record).toMatchObject({ inputTokens: 10, outputTokens: 20 });
    expect(JSON.stringify(record)).not.toContain("PerSecond");
  });

  test("turn_completed.usage 的 speedOutputTokens / speedGenerationMs 写入账本记录", () => {
    const tracker = new UsageTurnTracker("a1", "claude");
    tracker.observe(env(1000, { type: "turn_started", turnId: "t1" }), "opus");
    const record = tracker.observe(
      env(3000, {
        type: "turn_completed",
        turnId: "t1",
        usage: { outputTokens: 500, outputTokensPerSecond: 250, speedOutputTokens: 500, speedGenerationMs: 2000 },
      }),
      "opus",
    );
    expect(record).toMatchObject({ outputTokens: 500, speedOutputTokens: 500, speedGenerationMs: 2000 });
    expect(JSON.stringify(record)).not.toContain("PerSecond");
    tracker.observe(env(4000, { type: "turn_started", turnId: "t2" }), "opus");
    const bare = tracker.observe(env(5000, { type: "turn_completed", turnId: "t2", usage: { outputTokens: 5 } }), "opus");
    expect(bare).not.toHaveProperty("speedOutputTokens");
    expect(bare).not.toHaveProperty("speedGenerationMs");
  });

  test("失败 / 中断 / background 回合", () => {
    const tracker = new UsageTurnTracker("a1", "mock");
    tracker.observe(env(100, { type: "turn_started", turnId: "b1", origin: "background" }), null);
    const failed = tracker.observe(env(250, { type: "turn_failed", turnId: "b1", error: "x" }), null);
    expect(failed).toMatchObject({ outcome: "failed", origin: "background", durationMs: 150, model: null });
    expect(failed).not.toHaveProperty("ttftMs");
    expect(failed).not.toHaveProperty("inputTokens");

    tracker.observe(env(300, { type: "turn_started", turnId: "u1" }), "m");
    const canceled = tracker.observe(env(350, { type: "turn_canceled", turnId: "u1", reason: "r" }), "m");
    expect(canceled).toMatchObject({ outcome: "canceled", origin: "user", model: "m", durationMs: 50 });
  });
});

describe("UsageLedger", () => {
  test("写入账本文件，重启后读回，重复记录忽略", async () => {
    const dir = tempDir();
    const ledger = new UsageLedger({ dataDir: dir });
    await ledger.load();
    const r = rec({ ts: 1000, outputTokens: 5 });
    ledger.record(r);
    ledger.record(r);
    await ledger.flush();
    const lines = readFileSync(path.join(dir, "usage", "turns.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);

    writeFileSync(path.join(dir, "usage", "turns.jsonl"), `${lines[0]}\n{坏行\n`);
    const again = new UsageLedger({ dataDir: dir });
    await again.load();
    expect(again.list()).toEqual([r]);
  });

  test("未设置数据目录时只在内存累计", async () => {
    const ledger = new UsageLedger();
    await ledger.load();
    ledger.record(rec({ ts: 1 }));
    expect(ledger.list()).toHaveLength(1);
    expect(ledger.backfilling).toBe(false);
  });

  test("回填只执行一次，期间 backfilling 为 true，model 取快照 / model_changed", async () => {
    const dir = tempDir();
    const entriesByAgent: Record<string, AgentStreamEnvelope[]> = {
      a1: [
        env(1000, { type: "turn_started", turnId: "t1" }),
        env(2000, { type: "turn_completed", turnId: "t1", usage: { inputTokens: 1, outputTokens: 2 } }),
      ],
      a2: [
        env(1000, { type: "turn_started", turnId: "t1" }),
        env(1500, { type: "turn_completed", turnId: "t1", usage: { inputTokens: 3, outputTokens: 4 } }),
        env(1600, { type: "model_changed", modelId: "m2" }),
        env(1700, { type: "turn_started", turnId: "t2" }),
        env(1800, { type: "turn_failed", turnId: "t2", error: "e" }),
      ],
    };
    for (const [id, list] of Object.entries(entriesByAgent)) {
      for (const entry of list) entry.agentId = id;
    }
    let reads = 0;
    const reader = (agentId: string) => {
      reads += 1;
      return (async function* () {
        yield* entriesByAgent[agentId] ?? [];
      })();
    };
    const agents = [
      { id: "a1", provider: "mock", model: "snap-model" },
      { id: "a2", provider: "mock", model: "m2" },
    ];

    const ledger = new UsageLedger({ dataDir: dir });
    await ledger.load();
    expect(ledger.backfilling).toBe(true);
    const running = ledger.backfill(agents, reader);
    expect(ledger.backfilling).toBe(true);
    await running;
    expect(ledger.backfilling).toBe(false);
    expect(existsSync(path.join(dir, "usage", "backfill-v1.done"))).toBe(true);
    const byKey = new Map(ledger.list().map((r) => [`${r.agentId}/${r.turnId}`, r]));
    expect(byKey.size).toBe(3);
    expect(byKey.get("a1/t1")).toMatchObject({ model: "snap-model", durationMs: 1000, inputTokens: 1 });
    expect(byKey.get("a2/t1")).toMatchObject({ model: null });
    expect(byKey.get("a2/t2")).toMatchObject({ model: "m2", outcome: "failed" });

    // 再次启动：标记存在，不再回填
    const second = new UsageLedger({ dataDir: dir });
    await second.load();
    expect(second.backfilling).toBe(false);
    const readsBefore = reads;
    await second.backfill(agents, reader);
    expect(reads).toBe(readsBefore);
    expect(second.list()).toHaveLength(3);
  });

  test("回填与实时记录重复时去重", async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, "usage"), { recursive: true });
    const ledger = new UsageLedger({ dataDir: dir });
    await ledger.load();
    const entries = [
      env(10, { type: "turn_started", turnId: "t1" }),
      env(20, { type: "turn_completed", turnId: "t1" }),
    ].map((e) => ({ ...e, agentId: "a9" }));
    const live = new UsageTurnTracker("a9", "mock");
    for (const entry of entries) {
      const r = live.observe(entry, null);
      if (r) ledger.record(r);
    }
    await ledger.backfill([{ id: "a9", provider: "mock", model: null }], () =>
      (async function* () {
        yield* entries;
      })(),
    );
    expect(ledger.list()).toHaveLength(1);
  });
});

describe("AgentManager 实时记账", () => {
  test("mock 回合结束后账本多一行 completed 记录，删除会话不删账本", async () => {
    const ledger = new UsageLedger();
    const registry = new ProviderRegistry([new MockAgentClient()]);
    const manager = new AgentManager({ registry, usage: ledger });
    const agent = await manager.createAgent({ provider: "mock", cwd: process.cwd(), model: "mock-model" });
    await manager.sendPrompt(agent.id, "你好");
    for (let i = 0; i < 100 && ledger.list().length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(ledger.list()).toHaveLength(1);
    expect(ledger.list()[0]).toMatchObject({
      agentId: agent.id,
      provider: "mock",
      model: "mock-model",
      outcome: "completed",
      origin: "user",
    });
    await manager.deleteAgent(agent.id);
    expect(ledger.list()).toHaveLength(1);
    await manager.shutdown();
  });
});

describe("summarizeUsage", () => {
  const ctx = {
    now: new Date(2026, 5, 30, 12).getTime(),
    backfilling: false,
    providerLabel: (p: string) => (p === "claude" ? "Claude Code" : undefined),
    agentTitle: (id: string) => (id === "alive" ? "活着的会话" : id === "untitled" ? null : undefined),
  };
  const day = (d: number, h = 10) => new Date(2026, 5, d, h).getTime();

  test("按本地日期分桶、总量与失败数", () => {
    const records = [
      rec({ ts: day(29, 23), inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, costUsd: 0.1 }),
      rec({ ts: day(29, 1), inputTokens: 1, outputTokens: 1, outcome: "failed" }),
      rec({ ts: day(30, 8), inputTokens: 100, outputTokens: 50, costUsd: 1 }),
    ];
    const summary = summarizeUsage(records, {}, ctx);
    expect(summary.totals).toEqual({
      turns: 3,
      failedTurns: 1,
      inputTokens: 111,
      cachedInputTokens: 2,
      outputTokens: 56,
      costUsd: 1.1,
    });
    expect(summary.byDay.map((d) => [d.day, d.turns, d.inputTokens])).toEqual([
      ["2026-06-29", 2, 11],
      ["2026-06-30", 1, 100],
    ]);
    expect(summary.byDay[0]!.cachedInputTokens).toBe(2);
  });

  test("时间范围：默认最近 30 天，sinceMs / untilMs 过滤", () => {
    const records = [
      rec({ ts: new Date(2026, 4, 1).getTime(), inputTokens: 1 }), // 30 天前之外
      rec({ ts: day(10), inputTokens: 2 }),
      rec({ ts: day(20), inputTokens: 4 }),
    ];
    expect(summarizeUsage(records, {}, ctx).totals.inputTokens).toBe(6);
    expect(summarizeUsage(records, { sinceMs: 0 }, ctx).totals.inputTokens).toBe(7);
    expect(summarizeUsage(records, { sinceMs: day(15) }, ctx).totals.inputTokens).toBe(4);
    expect(summarizeUsage(records, { sinceMs: 0, untilMs: day(15) }, ctx).totals.inputTokens).toBe(3);
  });

  test("byProvider label / byModel / topAgents 的 deleted 与标题 / 前 10", () => {
    const records = [
      rec({ ts: day(20), provider: "claude", model: "opus", agentId: "alive", inputTokens: 10, outputTokens: 10 }),
      rec({ ts: day(21), provider: "claude", model: null, agentId: "gone", inputTokens: 50, outputTokens: 5 }),
      rec({ ts: day(22), provider: "mock", model: null, agentId: "untitled", inputTokens: 1 }),
    ];
    const summary = summarizeUsage(records, {}, ctx);
    expect(summary.byProvider.map((p) => [p.provider, p.label, p.turns])).toEqual([
      ["claude", "Claude Code", 2],
      ["mock", "mock", 1],
    ]);
    expect(summary.byModel.map((m) => [m.provider, m.model])).toEqual([
      ["claude", null],
      ["claude", "opus"],
      ["mock", null],
    ]);
    expect(summary.topAgents.map((a) => [a.agentId, a.title, a.deleted])).toEqual([
      ["gone", null, true],
      ["alive", "活着的会话", false],
      ["untitled", null, false],
    ]);

    const many = Array.from({ length: 15 }, (_, i) =>
      rec({ ts: day(20) + i, agentId: `x${i}`, inputTokens: i + 1 }),
    );
    expect(summarizeUsage(many, {}, ctx).topAgents).toHaveLength(10);
  });

  test("百分位与输出速度", () => {
    expect(percentile([], 0.5)).toBeUndefined();
    expect(percentile([5], 0.95)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);

    const records = [
      rec({ ts: day(20), ttftMs: 100, durationMs: 1000, outputTokens: 100 }),
      rec({ ts: day(21), ttftMs: 300, durationMs: 2000, outputTokens: 100 }),
      rec({ ts: day(22), ttftMs: 200, durationMs: 4000, outputTokens: 100 }),
      rec({ ts: day(23), durationMs: 500 }),
    ];
    const { perf } = summarizeUsage(records, {}, ctx);
    expect(perf.ttftP50Ms).toBe(200);
    expect(perf.ttftP95Ms).toBe(300);
    expect(perf.durationP50Ms).toBe(1000);
    expect(perf.durationP95Ms).toBe(4000);
    // 旧记录没有 speed 字段：不参与输出速度，不再用 outputTokens ÷ durationMs 估算
    expect(perf.outputTokensPerSec).toBeUndefined();
    expect(summarizeUsage([], {}, ctx).perf).toEqual({});
  });

  test("输出速度按 Σ speedOutputTokens ÷ Σ speedGenerationMs 汇总（合计而非平均），缺字段的记录不参与", () => {
    const records = [
      rec({ ts: day(20), outputTokens: 100, durationMs: 9000, speedOutputTokens: 100, speedGenerationMs: 1000 }), // 100 tok/s
      rec({ ts: day(21), outputTokens: 1000, durationMs: 9000, speedOutputTokens: 1000, speedGenerationMs: 2000 }), // 500 tok/s
      rec({ ts: day(22), outputTokens: 5000, durationMs: 1000 }), // 旧记录：不参与
      rec({ ts: day(23), speedOutputTokens: 300 }), // 缺 speedGenerationMs：不参与
    ];
    // Σ = 1100 token ÷ 3 秒 = 366.7（逐条平均会是 300）
    expect(summarizeUsage(records, {}, ctx).perf.outputTokensPerSec).toBe(366.7);
    expect(summarizeUsage([records[2]!, records[3]!], {}, ctx).perf.outputTokensPerSec).toBeUndefined();
  });
});
