import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AgentPermissionRequest,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentStreamEvent,
  Schedule,
  ScheduleNotice,
} from "@agentdeck/protocol";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { AgentManager } from "../src/agent/agent-manager.js";
import { AgentStore } from "../src/agent/agent-store.js";
import type { AgentClient, AgentSession, AgentSessionConfig } from "../src/agent/types.js";
import { isValidCron, nextCronAfter } from "../src/scheduler/cron.js";
import {
  endsWithMarker,
  goalContinuePrompt,
  parseJudgeReply,
  Scheduler,
} from "../src/scheduler/scheduler.js";
import { scheduleDraftSchema, type ParsedScheduleDraft } from "../src/scheduler/schema.js";
import { ScheduleStore } from "../src/scheduler/store.js";

const MIN = 60_000;
const START = new Date(2026, 0, 5, 9, 0, 0); // 本地时间 09:00:00

const tempDirs: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agentdeck-sched-"));
  tempDirs.push(dir);
  return dir;
}

function promptText(prompt: AgentPromptInput): string {
  return typeof prompt === "string"
    ? prompt
    : prompt.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** 由测试驱动的假会话：startTurn 后回合保持运行，直到 finish() */
class FakeSession implements AgentSession {
  readonly provider = "fake";
  private listeners = new Set<(event: AgentStreamEvent) => void>();
  private turnCounter = 0;
  prompts: string[] = [];
  currentTurnId: string | null = null;
  closed = false;

  constructor(
    readonly cfg: AgentSessionConfig,
    public id: string,
    private readonly onPrompt: (session: FakeSession, text: string) => void,
  ) {}

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    this.turnCounter += 1;
    const turnId = `${this.id}-turn-${this.turnCounter}`;
    this.currentTurnId = turnId;
    const text = promptText(prompt);
    this.prompts.push(text);
    this.emit({ type: "thread_started", sessionId: this.id });
    this.emit({ type: "turn_started", turnId });
    this.onPrompt(this, text);
    return { turnId };
  }

  /** 结束当前回合：先输出一条助手消息，再发结束事件 */
  finish(text: string, kind: "completed" | "failed" | "canceled" = "completed"): void {
    const turnId = this.currentTurnId!;
    this.currentTurnId = null;
    if (text) {
      this.emit({
        type: "timeline",
        turnId,
        item: { type: "assistant_message", text, messageId: `m-${turnId}` },
      });
    }
    if (kind === "completed") {
      this.emit({ type: "turn_completed", turnId });
    } else if (kind === "failed") {
      this.emit({ type: "turn_failed", turnId, error: "boom" });
    } else {
      this.emit({ type: "turn_canceled", turnId, reason: "x" });
    }
  }

  subscribe(cb: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  emit(event: AgentStreamEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return [];
  }
  async respondToPermission(): Promise<void> {}
  async interrupt(): Promise<void> {
    if (this.currentTurnId) {
      this.finish("", "canceled");
    }
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  describePersistence(): AgentPersistenceHandle | null {
    return { provider: "fake", sessionId: this.id };
  }
}

interface Harness {
  manager: AgentManager;
  scheduler: Scheduler;
  sessions: FakeSession[];
  notices: ScheduleNotice[];
  changed: Array<{ schedules: Schedule[]; paused: boolean }>;
  /** 为每个新 prompt 自动应答（如评判会话） */
  autoReply: (session: FakeSession, text: string) => void;
  store: ScheduleStore;
  dataDir?: string;
}

const managers: AgentManager[] = [];
const schedulers: Scheduler[] = [];

function makeClient(
  sessions: FakeSession[],
  hook: () => (s: FakeSession, t: string) => void,
): AgentClient {
  let counter = 0;
  const create = (cfg: AgentSessionConfig, id?: string) => {
    counter += 1;
    const session = new FakeSession(cfg, id ?? `native-${sessions.length}-${counter}`, (s, t) =>
      hook()(s, t),
    );
    sessions.push(session);
    return session;
  };
  return {
    provider: "fake",
    kind: "mock",
    label: "Fake",
    isAvailable: async () => ({ available: true }),
    fetchCatalog: async () => ({ models: [], modes: [{ id: "default", label: "默认" }] }),
    createSession: async (cfg) => create(cfg),
    resumeSession: async (handle: AgentPersistenceHandle, cfg: { cwd: string }) =>
      create(cfg, handle.sessionId),
  };
}

async function setup(opts: { dataDir?: string; startScheduler?: boolean } = {}): Promise<Harness> {
  const sessions: FakeSession[] = [];
  const harness = { autoReply: (_s: FakeSession, _t: string) => undefined } as Harness;
  const client = makeClient(sessions, () => harness.autoReply);
  const store = opts.dataDir ? new AgentStore({ dataDir: opts.dataDir }) : undefined;
  const manager = new AgentManager({
    registry: { get: (id) => (id === "fake" ? client : undefined) },
    ...(store ? { store } : {}),
  });
  managers.push(manager);
  if (store) {
    await manager.restore();
  }
  const scheduleStore = new ScheduleStore({ ...(opts.dataDir ? { dataDir: opts.dataDir } : {}) });
  const scheduler = new Scheduler({ manager, store: scheduleStore });
  schedulers.push(scheduler);
  const notices: ScheduleNotice[] = [];
  const changed: Harness["changed"] = [];
  scheduler.subscribe({
    onNotice: (n) => notices.push(n),
    onChanged: (schedules, paused) => changed.push({ schedules, paused }),
  });
  Object.assign(harness, { manager, scheduler, sessions, notices, changed, store: scheduleStore });
  if (opts.dataDir) {
    harness.dataDir = opts.dataDir;
  }
  if (opts.startScheduler !== false) {
    await scheduler.start();
  }
  return harness;
}

function draft(value: Record<string, unknown>): ParsedScheduleDraft {
  return scheduleDraftSchema.parse(value);
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const settle = () => vi.advanceTimersByTimeAsync(0);

async function createAgent(h: Harness): Promise<{ id: string; session: FakeSession }> {
  const agent = await h.manager.createAgent({ provider: "fake", cwd: "/work" });
  return { id: agent.id, session: h.sessions[h.sessions.length - 1]! };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(async () => {
  for (const scheduler of schedulers.splice(0)) {
    await scheduler.stop();
  }
  await Promise.allSettled(managers.splice(0).map((manager) => manager.shutdown()));
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("cron 工具与校验", () => {
  test("5 段表达式合法，其它非法", () => {
    expect(isValidCron("*/5 * * * *")).toBe(true);
    expect(isValidCron("0 9 * * 1-5")).toBe(true);
    expect(isValidCron("* * * *")).toBe(false);
    expect(isValidCron("0 0 9 * * *")).toBe(false); // 6 段（带秒）不接受
    expect(isValidCron("61 * * * *")).toBe(false);
    expect(nextCronAfter("*/5 * * * *", START.getTime())).toBe(START.getTime() + 5 * MIN);
  });

  test("upsert 入参校验：cron 非法、everyMinutes < 1、空 prompt", () => {
    const base = { kind: "cron", name: "x", target: { type: "agent", agentId: "a" }, prompt: "hi" };
    expect(scheduleDraftSchema.safeParse({ ...base, trigger: { cron: "bad" } }).success).toBe(false);
    expect(scheduleDraftSchema.safeParse({ ...base, trigger: { everyMinutes: 0 } }).success).toBe(false);
    expect(
      scheduleDraftSchema.safeParse({ ...base, trigger: { everyMinutes: 5 }, prompt: " " }).success,
    ).toBe(false);
    const ok = scheduleDraftSchema.parse({ ...base, trigger: { everyMinutes: 5 } });
    expect(ok).toMatchObject({ enabled: true, onBusy: "skip" });
  });

  test("goal 默认值：doneMarker = GOAL_DONE、stopOnFailure = true", () => {
    const parsed = scheduleDraftSchema.parse({
      kind: "goal",
      name: "g",
      agentId: "a",
      goal: "做完",
      maxIterations: 3,
    });
    expect(parsed).toMatchObject({ kind: "goal", doneMarker: "GOAL_DONE", stopOnFailure: true });
  });

  test("末行标记与评判回复解析", () => {
    expect(endsWithMarker("做完了\nGOAL_DONE\n\n", "GOAL_DONE")).toBe(true);
    expect(endsWithMarker("GOAL_DONE 还没", "GOAL_DONE")).toBe(false);
    expect(endsWithMarker("GOAL_DONE\n继续中", "GOAL_DONE")).toBe(false);
    expect(parseJudgeReply("\nDONE")).toBe(true);
    expect(parseJudgeReply("done，目标达成")).toBe(true);
    expect(parseJudgeReply("CONTINUE: 还没 DONE")).toBe(false);
    expect(parseJudgeReply("随便说点什么")).toBe(false);
  });
});

describe("定时任务触发", () => {
  test("cron 到点向目标会话发送 prompt，并记录 sent", async () => {
    const h = await setup();
    const { id, session } = await createAgent(h);
    h.scheduler.upsert(
      draft({
        kind: "cron",
        name: "每 5 分钟",
        trigger: { cron: "*/5 * * * *" },
        target: { type: "agent", agentId: id },
        prompt: "巡检",
      }),
    );
    await advance(4 * MIN);
    expect(session.prompts).toEqual([]);
    await advance(MIN);
    expect(session.prompts).toEqual(["巡检"]);
    session.finish("ok");
    await advance(5 * MIN);
    expect(session.prompts).toEqual(["巡检", "巡检"]);
    const runs = await h.scheduler.runs(undefined);
    expect(runs.map((run) => run.outcome)).toEqual(["sent", "sent"]);
    expect(runs[0]).toMatchObject({ agentId: id });
  });

  test("everyMinutes 按间隔触发", async () => {
    const h = await setup();
    const { id, session } = await createAgent(h);
    h.scheduler.upsert(
      draft({
        kind: "cron",
        name: "每 2 分钟",
        trigger: { everyMinutes: 2 },
        target: { type: "agent", agentId: id },
        prompt: "ping",
      }),
    );
    await advance(2 * MIN);
    expect(session.prompts).toHaveLength(1);
    session.finish("");
    await advance(2 * MIN);
    expect(session.prompts).toHaveLength(2);
  });

  test("at 一次性任务触发后自动停用", async () => {
    const h = await setup();
    const { id, session } = await createAgent(h);
    const saved = h.scheduler.upsert(
      draft({
        kind: "cron",
        name: "一次性",
        trigger: { at: START.getTime() + MIN },
        target: { type: "agent", agentId: id },
        prompt: "once",
      }),
    );
    await advance(MIN);
    expect(session.prompts).toEqual(["once"]);
    expect(h.scheduler.get(saved.id)).toMatchObject({ enabled: false });
    session.finish("");
    await advance(10 * MIN);
    expect(session.prompts).toHaveLength(1);
  });

  test("at 已过期时拒绝启用（-32602 语义）", async () => {
    const h = await setup();
    const { id } = await createAgent(h);
    expect(() =>
      h.scheduler.upsert(
        draft({
          kind: "cron",
          name: "过期",
          trigger: { at: START.getTime() - MIN },
          target: { type: "agent", agentId: id },
          prompt: "x",
        }),
      ),
    ).toThrow("触发时间已过");
  });

  test("启动时错过的触发不补跑；一次性任务过期记 missed 并停用", async () => {
    const dataDir = makeDir();
    const t0 = START.getTime();
    writeFileSync(
      path.join(dataDir, "schedules.json"),
      JSON.stringify({
        version: 1,
        paused: false,
        schedules: [
          {
            id: "once",
            name: "过期的一次性",
            enabled: true,
            kind: "cron",
            createdAt: t0 - 3600_000,
            updatedAt: t0 - 3600_000,
            trigger: { at: t0 - 30 * MIN },
            target: { type: "new", provider: "fake", cwd: "/work" },
            prompt: "x",
            onBusy: "skip",
          },
          {
            id: "recurring",
            name: "每小时",
            enabled: true,
            kind: "cron",
            createdAt: t0 - 3600_000,
            updatedAt: t0 - 3600_000,
            trigger: { cron: "0 * * * *" },
            target: { type: "new", provider: "fake", cwd: "/work" },
            prompt: "y",
            onBusy: "skip",
          },
        ],
      }),
    );
    const h = await setup({ dataDir });
    await settle();
    expect(h.sessions).toHaveLength(0); // 没有补跑（new 目标也没建会话）
    const runs = await h.scheduler.runs("once");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: "missed" });
    expect(h.scheduler.get("once")).toMatchObject({ enabled: false });
    expect(await h.scheduler.runs("recurring")).toEqual([]);
    // 之后仍按计划触发
    await advance(60 * MIN);
    await vi.waitFor(() => expect(h.sessions).toHaveLength(1)); // 恢复会话读真实磁盘，需等真实 IO
  });

  test("运行中系统时间前跳（休眠唤醒）：错过的触发记 missed，不补跑", async () => {
    const h = await setup();
    const { id, session } = await createAgent(h);
    h.scheduler.upsert(
      draft({
        kind: "cron",
        name: "每 5 分钟",
        trigger: { cron: "*/5 * * * *" },
        target: { type: "agent", agentId: id },
        prompt: "p",
      }),
    );
    vi.setSystemTime(new Date(START.getTime() + 20 * MIN + 3_000));
    await advance(30_000);
    expect(session.prompts).toEqual([]);
    const runs = await h.scheduler.runs(undefined);
    expect(runs.map((run) => run.outcome)).toEqual(["missed"]);
    // 之后恢复正常节奏
    await advance(5 * MIN);
    expect(session.prompts).toHaveLength(1);
  });

  test("目标忙：skip 记 skipped_busy", async () => {
    const h = await setup();
    const { id, session } = await createAgent(h);
    await h.manager.sendPrompt(id, "手动开始"); // 回合保持运行
    h.scheduler.upsert(
      draft({
        kind: "cron",
        name: "skip",
        trigger: { everyMinutes: 1 },
        target: { type: "agent", agentId: id },
        prompt: "巡检",
        onBusy: "skip",
      }),
    );
    await advance(MIN);
    expect(session.prompts).toEqual(["手动开始"]);
    expect((await h.scheduler.runs(undefined))[0]).toMatchObject({ outcome: "skipped_busy" });
  });

  test("目标忙：wait 等空闲后发送；超过 30 分钟记 skipped_busy", async () => {
    const h = await setup();
    const { id, session } = await createAgent(h);
    await h.manager.sendPrompt(id, "手动开始");
    h.scheduler.upsert(
      draft({
        kind: "cron",
        name: "wait",
        trigger: { at: START.getTime() + MIN },
        target: { type: "agent", agentId: id },
        prompt: "等一下再发",
        onBusy: "wait",
      }),
    );
    await advance(10 * MIN);
    expect(session.prompts).toEqual(["手动开始"]);
    session.finish("done");
    await advance(1_000);
    expect(session.prompts).toEqual(["手动开始", "等一下再发"]);

    // 超时分支
    const second = await createAgent(h);
    await h.manager.sendPrompt(second.id, "占用");
    h.scheduler.upsert(
      draft({
        kind: "cron",
        name: "wait-timeout",
        trigger: { at: Date.now() + MIN },
        target: { type: "agent", agentId: second.id },
        prompt: "永远等不到",
        onBusy: "wait",
      }),
    );
    await advance(MIN + 31 * MIN);
    expect(second.session.prompts).toEqual(["占用"]);
    const timeoutRun = (await h.scheduler.runs(undefined))[0]!;
    expect(timeoutRun).toMatchObject({ outcome: "skipped_busy" });
    expect(timeoutRun.message).toContain("30 分钟");
  });

  test("全局暂停：触发记 skipped_paused 不发送；runNow 不受暂停影响", async () => {
    const h = await setup();
    const { id, session } = await createAgent(h);
    const saved = h.scheduler.upsert(
      draft({
        kind: "cron",
        name: "p",
        trigger: { everyMinutes: 1 },
        target: { type: "agent", agentId: id },
        prompt: "巡检",
      }),
    );
    expect(h.scheduler.setPaused(true)).toBe(true);
    expect(h.scheduler.list().paused).toBe(true);
    await advance(MIN);
    expect(session.prompts).toEqual([]);
    expect((await h.scheduler.runs(undefined))[0]).toMatchObject({ outcome: "skipped_paused" });
    await h.scheduler.runNow(saved.id);
    expect(session.prompts).toEqual(["巡检"]);
  });

  test("dormant 会话到点自动恢复后发送", async () => {
    const dataDir = makeDir();
    // 第一个进程：建会话、跑一轮、关闭
    const first = await setup({ dataDir, startScheduler: false });
    const { id, session } = await createAgent(first);
    await first.manager.sendPrompt(id, "hello");
    session.finish("ok");
    await settle();
    await first.manager.shutdown();
    managers.pop();

    // 第二个进程：会话 dormant
    const h = await setup({ dataDir });
    expect(h.manager.getAgent(id).status).toBe("dormant");
    h.scheduler.upsert(
      draft({
        kind: "cron",
        name: "dormant",
        trigger: { everyMinutes: 1 },
        target: { type: "agent", agentId: id },
        prompt: "醒醒",
      }),
    );
    await advance(MIN);
    await vi.waitFor(() => expect(h.sessions).toHaveLength(1)); // 恢复会话读真实磁盘，需等真实 IO
    expect(h.sessions[0]!.prompts).toEqual(["醒醒"]);
    expect(h.manager.getAgent(id).status).toBe("running");
  });

  test("new 目标每次新建 origin = schedule 的会话并发送", async () => {
    const h = await setup();
    h.scheduler.upsert(
      draft({
        kind: "cron",
        name: "日报",
        trigger: { everyMinutes: 1 },
        target: { type: "new", provider: "fake", cwd: "/proj" },
        prompt: "写日报",
      }),
    );
    await advance(MIN);
    const agents = h.manager.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ origin: "schedule", title: "日报", cwd: "/proj" });
    expect(h.sessions[0]!.prompts).toEqual(["写日报"]);
    h.sessions[0]!.finish("");
    await advance(MIN);
    expect(h.manager.listAgents()).toHaveLength(2);
  });

  test("发送失败记 failed 并通知", async () => {
    const h = await setup();
    h.scheduler.upsert(
      draft({
        kind: "cron",
        name: "坏 provider",
        trigger: { everyMinutes: 1 },
        target: { type: "new", provider: "nope", cwd: "/proj" },
        prompt: "x",
      }),
    );
    await advance(MIN);
    expect((await h.scheduler.runs(undefined))[0]).toMatchObject({ outcome: "failed" });
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toMatchObject({ kind: "failed", name: "坏 provider" });
  });
});

describe("心跳", () => {
  test("空闲满 idleMinutes 触发一次，每个空闲期只触发一次，maxRuns 后停用", async () => {
    const h = await setup();
    const { id, session } = await createAgent(h);
    const saved = h.scheduler.upsert(
      draft({
        kind: "heartbeat",
        name: "心跳",
        agentId: id,
        idleMinutes: 30,
        prompt: "还在吗",
        maxRuns: 2,
      }),
    );
    await advance(29 * MIN);
    expect(session.prompts).toEqual([]);
    await advance(2 * MIN);
    expect(session.prompts).toEqual(["还在吗"]);
    // 心跳回合进行中：不会重复触发
    await advance(120 * MIN);
    expect(session.prompts).toHaveLength(1);
    // 回合结束 → 新的空闲期
    session.finish("在");
    await advance(29 * MIN);
    expect(session.prompts).toHaveLength(1);
    await advance(2 * MIN);
    expect(session.prompts).toHaveLength(2);
    expect(h.scheduler.get(saved.id)).toMatchObject({ runs: 2, enabled: false });
    session.finish("在");
    await advance(120 * MIN);
    expect(session.prompts).toHaveLength(2);
  });

  test("用户活动重置空闲计时", async () => {
    const h = await setup();
    const { id, session } = await createAgent(h);
    h.scheduler.upsert(
      draft({ kind: "heartbeat", name: "心跳", agentId: id, idleMinutes: 10, prompt: "hb" }),
    );
    await advance(8 * MIN);
    await h.manager.sendPrompt(id, "我来了");
    session.finish("好");
    await advance(8 * MIN);
    expect(session.prompts).toEqual(["我来了"]);
    await advance(3 * MIN);
    expect(session.prompts).toEqual(["我来了", "hb"]);
  });

  test("全局暂停时记 skipped_paused", async () => {
    const h = await setup();
    const { id, session } = await createAgent(h);
    h.scheduler.upsert(
      draft({ kind: "heartbeat", name: "心跳", agentId: id, idleMinutes: 1, prompt: "hb" }),
    );
    h.scheduler.setPaused(true);
    await advance(2 * MIN);
    expect(session.prompts).toEqual([]);
    expect((await h.scheduler.runs(undefined))[0]).toMatchObject({ outcome: "skipped_paused" });
  });
});

describe("目标循环", () => {
  const goalDraft = (agentId: string, extra: Record<string, unknown> = {}) =>
    draft({ kind: "goal", name: "目标", agentId, goal: "修复所有测试", maxIterations: 3, ...extra });

  test("启用即发首条提示；末行 doneMarker → done + 通知", async () => {
    const h = await setup();
    const { id, session } = await createAgent(h);
    const saved = h.scheduler.upsert(goalDraft(id));
    await settle();
    expect(session.prompts).toEqual([
      "目标：修复所有测试\n请持续推进直到完成。完成时在回复最后单独一行输出 GOAL_DONE。",
    ]);
    session.finish("全部修好了\nGOAL_DONE");
    await settle();
    expect(h.scheduler.get(saved.id)).toMatchObject({ state: "done", enabled: false });
    expect(h.notices).toMatchObject([{ kind: "done", scheduleId: saved.id }]);
    expect((await h.scheduler.runs(saved.id))[0]).toMatchObject({ outcome: "done" });
    expect(session.prompts).toHaveLength(1);
  });

  test("未完成则累计 iterations 并继续；达到 maxIterations → exhausted", async () => {
    const h = await setup();
    const { id, session } = await createAgent(h);
    const saved = h.scheduler.upsert(goalDraft(id));
    await settle();
    session.finish("还在做");
    await settle();
    expect(h.scheduler.get(saved.id)).toMatchObject({ iterations: 1, state: "running" });
    expect(session.prompts[1]).toBe(goalContinuePrompt(h.scheduler.get(saved.id) as never));
    session.finish("继续做");
    await settle();
    expect(session.prompts).toHaveLength(3);
    session.finish("还是没完");
    await settle();
    expect(h.scheduler.get(saved.id)).toMatchObject({ iterations: 3, state: "exhausted", enabled: false });
    expect(session.prompts).toHaveLength(3);
    expect(h.notices).toMatchObject([{ kind: "exhausted" }]);
  });

  test("turn_failed：stopOnFailure → failed；否则继续", async () => {
    const h = await setup();
    const a = await createAgent(h);
    const stop = h.scheduler.upsert(goalDraft(a.id, { stopOnFailure: true }));
    await settle();
    a.session.finish("", "failed");
    await settle();
    expect(h.scheduler.get(stop.id)).toMatchObject({ state: "failed", enabled: false });
    expect(h.notices).toMatchObject([{ kind: "failed" }]);

    const b = await createAgent(h);
    const keep = h.scheduler.upsert(goalDraft(b.id, { stopOnFailure: false }));
    await settle();
    b.session.finish("", "failed");
    await settle();
    expect(h.scheduler.get(keep.id)).toMatchObject({ state: "running", iterations: 1 });
    expect(b.session.prompts).toHaveLength(2);
  });

  test("用户中断 → stopped；可继续（runNow）", async () => {
    const h = await setup();
    const { id, session } = await createAgent(h);
    const saved = h.scheduler.upsert(goalDraft(id));
    await settle();
    await h.manager.cancel(id);
    await settle();
    expect(h.scheduler.get(saved.id)).toMatchObject({ state: "stopped", enabled: false });
    expect(session.prompts).toHaveLength(1);

    await h.scheduler.runNow(saved.id);
    await settle();
    expect(h.scheduler.get(saved.id)).toMatchObject({ state: "running", enabled: true });
    expect(session.prompts).toHaveLength(2);
    expect(session.prompts[1]).toContain("目标：修复所有测试"); // 尚无完成的轮次，重新发首条提示
  });

  test("用户手动发送也使循环 stopped，调度器自己的发送不会", async () => {
    const h = await setup();
    const { id, session } = await createAgent(h);
    const saved = h.scheduler.upsert(goalDraft(id));
    await settle();
    // 回合刚结束、continue 尚未发出的窗口里用户插入：用 onUserAction 通道模拟
    const listener = vi.fn();
    h.manager.subscribe({ onUserAction: listener });
    session.finish("还在做");
    await settle();
    expect(listener).not.toHaveBeenCalled(); // 调度器的 continue 带 internal 标记
    expect(h.scheduler.get(saved.id)).toMatchObject({ state: "running" });
    // 再结束一轮并让循环停下，随后用户手动发送不影响已结束的循环
    session.finish("done\nGOAL_DONE");
    await settle();
    await h.manager.sendPrompt(id, "用户消息");
    expect(listener).toHaveBeenCalledWith(id, "send");
    expect(h.scheduler.get(saved.id)).toMatchObject({ state: "done" });
  });

  test("judge 模式：隐藏评判会话判定 DONE，评判会话事后删除", async () => {
    const h = await setup();
    const { id, session } = await createAgent(h);
    const judged: string[] = [];
    h.autoReply = (s, text) => {
      if (text.includes("请判断目标是否已经完成")) {
        judged.push(text);
        queueMicrotask(() => s.finish("DONE"));
      }
    };
    const saved = h.scheduler.upsert(goalDraft(id, { judge: { provider: "fake" } }));
    await settle();
    // 评判模式不看 marker：这里没有 marker，仍由评判判定完成
    session.finish("好了");
    await settle();
    await advance(10);
    expect(judged).toHaveLength(1);
    expect(judged[0]).toContain("目标：修复所有测试");
    expect(judged[0]).toContain("好了");
    expect(h.scheduler.get(saved.id)).toMatchObject({ state: "done" });
    expect(h.manager.listAgents().filter((agent) => agent.origin === "judge")).toEqual([]);
  });

  test("judge 模式：CONTINUE 则继续下一轮", async () => {
    const h = await setup();
    const { id, session } = await createAgent(h);
    let originSeen: string | undefined;
    h.autoReply = (s, text) => {
      if (text.includes("请判断目标是否已经完成")) {
        originSeen = h.manager.listAgents().find((a) => a.origin === "judge")?.origin;
        queueMicrotask(() => s.finish("CONTINUE: 还差一步"));
      }
    };
    const saved = h.scheduler.upsert(goalDraft(id, { judge: { provider: "fake" } }));
    await settle();
    session.finish("做了一半\nGOAL_DONE"); // 评判模式下 marker 不作数
    await settle();
    await advance(10);
    expect(originSeen).toBe("judge");
    expect(h.scheduler.get(saved.id)).toMatchObject({ state: "running", iterations: 1 });
    expect(session.prompts).toHaveLength(2);
  });

  test("已有进行中的目标时不能再给同一会话启动另一个", async () => {
    const h = await setup();
    const { id } = await createAgent(h);
    h.scheduler.upsert(goalDraft(id));
    await settle();
    const other = await createAgent(h);
    expect(() => h.scheduler.upsert(goalDraft(id, { name: "另一个" }))).toThrow(/已有进行中/);
    expect(other.id).not.toBe(id);
  });

  test("会话正在运行时启动目标循环 → TURN_IN_PROGRESS", async () => {
    const h = await setup();
    const { id } = await createAgent(h);
    await h.manager.sendPrompt(id, "忙着");
    expect(() => h.scheduler.upsert(goalDraft(id))).toThrow(/正在运行/);
  });
});

describe("会话删除与持久化", () => {
  test("会话被删除后，指向它的 heartbeat / goal / agent 目标 cron 自动停用并记 failed", async () => {
    const h = await setup();
    const { id } = await createAgent(h);
    const cron = h.scheduler.upsert(
      draft({
        kind: "cron",
        name: "c",
        trigger: { everyMinutes: 5 },
        target: { type: "agent", agentId: id },
        prompt: "x",
      }),
    );
    const beat = h.scheduler.upsert(
      draft({ kind: "heartbeat", name: "h", agentId: id, idleMinutes: 5, prompt: "x" }),
    );
    const other = await createAgent(h);
    const goal = h.scheduler.upsert(
      draft({ kind: "goal", name: "g", agentId: other.id, goal: "g", maxIterations: 2 }),
    );
    await settle();
    await h.manager.deleteAgent(id);
    await h.manager.deleteAgent(other.id);
    await settle();
    expect(h.scheduler.get(cron.id)).toMatchObject({ enabled: false });
    expect(h.scheduler.get(beat.id)).toMatchObject({ enabled: false });
    expect(h.scheduler.get(goal.id)).toMatchObject({ enabled: false, state: "failed" });
    for (const schedule of [cron, beat, goal]) {
      const runs = await h.scheduler.runs(schedule.id);
      expect(runs[0]).toMatchObject({ outcome: "failed", message: "目标会话已删除" });
    }
  });

  test("持久化：重启后恢复调度表与暂停状态并继续触发；运行记录可读", async () => {
    const dataDir = makeDir();
    const first = await setup({ dataDir });
    const { id } = await createAgent(first);
    await first.manager.sendPrompt(id, "hi");
    first.sessions[0]!.finish("ok");
    await settle();
    const saved = first.scheduler.upsert(
      draft({
        kind: "cron",
        name: "持久",
        trigger: { everyMinutes: 10 },
        target: { type: "agent", agentId: id },
        prompt: "巡检",
      }),
    );
    first.scheduler.setPaused(true);
    await advance(10 * MIN); // 暂停中：记 skipped_paused
    await first.scheduler.stop();
    await first.manager.shutdown();
    managers.pop();

    const raw = JSON.parse(readFileSync(path.join(dataDir, "schedules.json"), "utf8"));
    expect(raw).toMatchObject({ version: 1, paused: true });
    expect(raw.schedules).toHaveLength(1);

    const second = await setup({ dataDir });
    expect(second.scheduler.list().paused).toBe(true);
    expect(second.scheduler.list().schedules).toMatchObject([{ id: saved.id, name: "持久" }]);
    expect((await second.scheduler.runs(saved.id))[0]).toMatchObject({ outcome: "skipped_paused" });
    second.scheduler.setPaused(false);
    await advance(10 * MIN);
    await vi.waitFor(() => expect(second.sessions).toHaveLength(1)); // 会话恢复后发送（读真实磁盘）
    expect(second.sessions[0]!.prompts).toEqual(["巡检"]);
  });

  test("重启后进行中的目标循环转为 stopped", async () => {
    const dataDir = makeDir();
    const first = await setup({ dataDir });
    const { id } = await createAgent(first);
    const goal = first.scheduler.upsert(
      draft({ kind: "goal", name: "g", agentId: id, goal: "g", maxIterations: 2 }),
    );
    await settle();
    await first.scheduler.stop();
    await first.manager.shutdown();
    managers.pop();
    const second = await setup({ dataDir });
    expect(second.scheduler.get(goal.id)).toMatchObject({ state: "stopped", enabled: false });
  });

  test("损坏的 schedules.json 记日志后视为空，原文件备份为 .bad", async () => {
    const dataDir = makeDir();
    writeFileSync(path.join(dataDir, "schedules.json"), "{ not json");
    const h = await setup({ dataDir });
    expect(h.scheduler.list()).toEqual({ schedules: [], paused: false });
    expect(existsSync(path.join(dataDir, "schedules.json.bad"))).toBe(true);
  });

  test("无法解析的单条调度项被跳过，其余保留", async () => {
    const dataDir = makeDir();
    writeFileSync(
      path.join(dataDir, "schedules.json"),
      JSON.stringify({
        version: 1,
        paused: false,
        schedules: [
          { id: "bad", kind: "cron", name: "x" },
          {
            id: "good",
            name: "ok",
            enabled: false,
            kind: "heartbeat",
            agentId: "a",
            idleMinutes: 5,
            prompt: "p",
            runs: 1,
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      }),
    );
    const h = await setup({ dataDir });
    expect(h.scheduler.list().schedules.map((s) => s.id)).toEqual(["good"]);
  });

  test("upsert 目标会话不存在 → AGENT_NOT_FOUND；更新保留 createdAt；delete 移除", async () => {
    const h = await setup();
    expect(() =>
      h.scheduler.upsert(
        draft({ kind: "heartbeat", name: "h", agentId: "ghost", idleMinutes: 5, prompt: "x" }),
      ),
    ).toThrow(/agent/i);
    const { id } = await createAgent(h);
    const created = h.scheduler.upsert(
      draft({ kind: "heartbeat", name: "h", agentId: id, idleMinutes: 5, prompt: "x" }),
    );
    vi.setSystemTime(new Date(START.getTime() + MIN));
    const updated = h.scheduler.upsert(
      draft({ id: created.id, kind: "heartbeat", name: "改名", agentId: id, idleMinutes: 5, prompt: "x" }),
    );
    expect(updated).toMatchObject({ name: "改名", createdAt: created.createdAt });
    expect(updated.updatedAt).toBeGreaterThan(created.updatedAt);
    h.scheduler.delete(created.id);
    expect(h.scheduler.list().schedules).toEqual([]);
    expect(h.changed.at(-1)).toMatchObject({ schedules: [] });
  });
});
