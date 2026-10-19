import { randomUUID } from "node:crypto";

import type {
  AgentSnapshot,
  AgentStreamEnvelope,
  CronSchedule,
  GoalSchedule,
  HeartbeatSchedule,
  Schedule,
  ScheduleNotice,
  ScheduleRun,
} from "@agentdeck/protocol";

import type { AgentManager } from "../agent/agent-manager.js";
import { AgentInvalidParamsError, AgentRpcError } from "../agent/errors.js";
import { createSilentLogger, type Logger } from "../logger.js";
import { nextCronAfter } from "./cron.js";
import type { ParsedScheduleDraft } from "./schema.js";
import type { ScheduleStore } from "./store.js";

/** 定时器最长睡眠：兼顾系统时间跳变与休眠唤醒，取简单可靠的 30 秒上限 */
export const TICK_MAX_MS = 30_000;
/** 触发时刻已过去超过该时长（系统休眠 / 时间前跳）视为错过，不补跑 */
export const LATE_TOLERANCE_MS = 90_000;
/** onBusy = wait 时最多等待的时长 */
export const WAIT_BUSY_MAX_MS = 30 * 60_000;
/** 评判会话最长等待时长 */
export const JUDGE_TIMEOUT_MS = 10 * 60_000;
const SEND_RETRY_DELAY_MS = 200;
const SEND_RETRY_MAX = 3;
const JUDGE_REPLY_MAX_CHARS = 8_000;
const RUNS_LIMIT_DEFAULT = 100;
const RUNS_LIMIT_MAX = 1_000;
const TARGET_GONE_MESSAGE = "目标会话已删除";

export type SchedulerManager = Pick<
  AgentManager,
  "subscribe" | "getAgent" | "createAgent" | "sendPrompt" | "deleteAgent"
>;

export interface SchedulerOptions {
  manager: SchedulerManager;
  store: ScheduleStore;
  logger?: Logger;
  now?: () => number;
}

export interface SchedulerListener {
  onChanged?(schedules: Schedule[], paused: boolean): void;
  onNotice?(notice: ScheduleNotice): void;
}

interface TurnResult {
  kind: "completed" | "failed" | "canceled";
  /** 本回合最后一条助手消息的文本 */
  text: string;
  error?: string;
  background: boolean;
}

interface TurnTracker {
  background: boolean;
  messageId: string | null;
  text: string;
}

function isBusy(agent: AgentSnapshot): boolean {
  return agent.status === "running" || agent.status === "starting" || Boolean(agent.activeTurnId);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTurnInProgress(error: unknown): boolean {
  return error instanceof AgentRpcError && error.code === "TURN_IN_PROGRESS";
}

export function goalFirstPrompt(goal: GoalSchedule): string {
  return `目标：${goal.goal}\n请持续推进直到完成。完成时在回复最后单独一行输出 ${goal.doneMarker}。`;
}

export function goalContinuePrompt(goal: GoalSchedule): string {
  return `继续推进目标：${goal.goal}。完成时在最后单独一行输出 ${goal.doneMarker}。`;
}

export function goalJudgePrompt(goal: GoalSchedule, reply: string): string {
  const text = reply.length > JUDGE_REPLY_MAX_CHARS ? reply.slice(-JUDGE_REPLY_MAX_CHARS) : reply;
  return `目标：${goal.goal}\n\nAgent 的最后一条回复：\n${text}\n\n请判断目标是否已经完成。只回答 DONE 或 CONTINUE: <理由>，不要输出其它内容。`;
}

/** 评判回复首个非空行以 DONE 开头即完成，其余（含 CONTINUE / 无法解析）视为未完成 */
export function parseJudgeReply(text: string): boolean {
  const first = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return first !== undefined && /^DONE\b/i.test(first);
}

/** 末行（忽略末尾空行）去空白后等于 marker */
export function endsWithMarker(text: string, marker: string): boolean {
  const lines = text.split("\n").map((line) => line.trim());
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.length > 0 && lines[lines.length - 1] === marker.trim();
}

/**
 * 调度器（design.md 4.25）：定时任务（cron / every / at）、心跳、目标循环。
 * 单个定时器睡到最近一次触发（最长 30 秒，兼顾系统时间跳变）；错过的触发不补跑。
 */
export class Scheduler {
  private readonly manager: SchedulerManager;
  private readonly store: ScheduleStore;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly listeners = new Set<SchedulerListener>();

  private readonly schedules = new Map<string, Schedule>();
  private paused = false;
  /** cron / every / at 的下一次触发时间 */
  private readonly nextAt = new Map<string, number>();
  /** agentId -> 最近一次回合结束（进入空闲）的时间；回合进行中为缺省 */
  private readonly idleSince = new Map<string, number>();
  /** 心跳 id -> 已触发过的空闲期（idleSince 值），保证每个空闲期只触发一次 */
  private readonly heartbeatFired = new Map<string, number>();
  private readonly inflight = new Set<string>();
  private readonly trackers = new Map<string, TurnTracker>();
  private readonly turnWaiters = new Map<string, Array<(result: TurnResult) => void>>();
  private timer: NodeJS.Timeout | null = null;
  private lastTick = 0;
  private unsubscribe: (() => void) | null = null;
  private started = false;

  constructor(options: SchedulerOptions) {
    this.manager = options.manager;
    this.store = options.store;
    this.logger = options.logger ?? createSilentLogger();
    this.now = options.now ?? Date.now;
  }

  subscribe(listener: SchedulerListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    await this.store.trimRuns();
    const state = await this.store.load();
    this.paused = state.paused;
    for (const schedule of state.schedules) {
      this.schedules.set(schedule.id, schedule);
    }
    this.unsubscribe = this.manager.subscribe({
      onStream: (envelope) => this.handleStream(envelope),
      onRemoved: (agentId) => this.handleAgentRemoved(agentId),
      onUserAction: (agentId) => this.handleUserAction(agentId),
    });
    const now = this.now();
    this.lastTick = now;
    let dirty = false;
    for (const schedule of [...this.schedules.values()]) {
      if (!schedule.enabled) {
        continue;
      }
      if (this.boundAgentId(schedule) && !this.agentExists(this.boundAgentId(schedule)!)) {
        this.disableForGoneTarget(schedule);
        dirty = true;
        continue;
      }
      if (schedule.kind === "cron") {
        if (this.initNext(schedule, now, true)) {
          dirty = true;
        }
      } else if (schedule.kind === "heartbeat") {
        this.trackIdle(schedule.agentId);
      } else if (schedule.state === "running") {
        // 重启后无法确认循环是否仍在进行中：转为 stopped，用户可在界面继续
        this.patch(schedule.id, { enabled: false, state: "stopped" });
        dirty = true;
      }
    }
    if (dirty) {
      this.persist();
    }
    this.rearm();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.store.flush();
  }

  // -------------------------------------------------------------------------
  // RPC 入口
  // -------------------------------------------------------------------------

  list(): { schedules: Schedule[]; paused: boolean } {
    return { schedules: this.snapshotSchedules(), paused: this.paused };
  }

  get(id: string): Schedule {
    const schedule = this.schedules.get(id);
    if (!schedule) {
      throw new AgentInvalidParamsError(`任务不存在：${id}`);
    }
    return structuredClone(schedule);
  }

  async runs(id: string | undefined, limit?: number): Promise<ScheduleRun[]> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > RUNS_LIMIT_MAX)) {
      throw new AgentInvalidParamsError(`limit 需为 1–${RUNS_LIMIT_MAX} 的整数`);
    }
    return this.store.readRuns(id, limit ?? RUNS_LIMIT_DEFAULT);
  }

  setPaused(paused: boolean): boolean {
    this.paused = paused;
    this.persist();
    this.emitChanged();
    return paused;
  }

  delete(id: string): void {
    if (!this.schedules.delete(id)) {
      throw new AgentInvalidParamsError(`任务不存在：${id}`);
    }
    this.nextAt.delete(id);
    this.heartbeatFired.delete(id);
    this.persist();
    this.emitChanged();
    this.rearm();
  }

  /** 新建 / 更新；`draft` 已通过 zod 校验。目标会话不存在 → AGENT_NOT_FOUND */
  upsert(draft: ParsedScheduleDraft): Schedule {
    const now = this.now();
    const existing = draft.id ? this.schedules.get(draft.id) : undefined;
    if (draft.id && !existing) {
      throw new AgentInvalidParamsError(`任务不存在：${draft.id}`);
    }
    const base = {
      id: existing?.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    let schedule: Schedule;
    let kick: "first" | "continue" | null = null;

    if (draft.kind === "cron") {
      if (draft.target.type === "agent") {
        this.manager.getAgent(draft.target.agentId);
      }
      if ("at" in draft.trigger && draft.enabled && draft.trigger.at <= now) {
        throw new AgentInvalidParamsError("一次性任务的触发时间已过");
      }
      schedule = { ...draft, ...base, kind: "cron" };
    } else if (draft.kind === "heartbeat") {
      this.manager.getAgent(draft.agentId);
      const previous = existing?.kind === "heartbeat" ? existing : undefined;
      let runs = draft.runs ?? previous?.runs ?? 0;
      // 重新启用已达上限的心跳：从头计数
      if (draft.enabled && draft.maxRuns !== undefined && runs >= draft.maxRuns && !previous?.enabled) {
        runs = 0;
      }
      schedule = { ...draft, ...base, kind: "heartbeat", runs };
    } else {
      const agent = this.manager.getAgent(draft.agentId);
      const previous = existing?.kind === "goal" ? existing : undefined;
      const requestedRunning =
        draft.enabled && (draft.state === undefined || draft.state === "running");
      let iterations = draft.iterations ?? previous?.iterations ?? 0;
      let state: GoalSchedule["state"];
      if (requestedRunning) {
        state = "running";
        const alreadyRunning = previous?.state === "running" && previous.enabled;
        if (!alreadyRunning) {
          if (this.runningGoalFor(draft.agentId, existing?.id)) {
            throw new AgentInvalidParamsError("该会话已有进行中的目标循环");
          }
          if (isBusy(agent)) {
            throw new AgentRpcError("TURN_IN_PROGRESS", "会话正在运行，请等待当前回合结束后再启动目标循环");
          }
          const terminal = previous !== undefined && previous.state !== "stopped";
          if (draft.iterations === undefined && (previous === undefined || terminal)) {
            iterations = 0;
          }
          kick = iterations === 0 ? "first" : "continue";
        }
      } else if (draft.state !== undefined && draft.state !== "running") {
        state = draft.state;
      } else {
        state = previous && previous.state !== "running" ? previous.state : "stopped";
      }
      schedule = {
        ...draft,
        ...base,
        kind: "goal",
        enabled: state === "running",
        iterations,
        state,
      };
    }

    this.schedules.set(schedule.id, schedule);
    if (schedule.kind === "cron") {
      this.nextAt.delete(schedule.id);
      if (schedule.enabled) {
        this.initNext(schedule, now, false);
      }
    } else if (schedule.kind === "heartbeat") {
      this.heartbeatFired.delete(schedule.id);
      if (schedule.enabled) {
        this.trackIdle(schedule.agentId);
      }
    }
    this.persist();
    this.emitChanged();
    this.rearm();
    if (kick) {
      void this.sendGoalPrompt(schedule.id, kick);
    }
    return structuredClone(schedule);
  }

  /** cron / heartbeat：立即发送一次（不受全局暂停影响，不等待发送完成）；goal：继续循环 */
  async runNow(id: string): Promise<void> {
    const schedule = this.schedules.get(id);
    if (!schedule) {
      throw new AgentInvalidParamsError(`任务不存在：${id}`);
    }
    if (schedule.kind === "cron") {
      await this.fireCron(schedule, true);
    } else if (schedule.kind === "heartbeat") {
      await this.fireHeartbeat(schedule, true);
    } else {
      if (schedule.state === "running" && schedule.enabled) {
        throw new AgentInvalidParamsError("目标循环正在进行中");
      }
      const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = schedule;
      this.upsert({ ...rest, id, enabled: true, state: "running" } as ParsedScheduleDraft);
    }
  }

  // -------------------------------------------------------------------------
  // 定时器
  // -------------------------------------------------------------------------

  /** 计算 cron / every / at 的 nextAt；at 已过期（仅启动时）记 missed 并停用，返回 true 表示改动了调度表 */
  private initNext(schedule: CronSchedule, now: number, atStartup: boolean): boolean {
    const trigger = schedule.trigger;
    if ("at" in trigger) {
      if (trigger.at <= now && atStartup) {
        this.record({
          scheduleId: schedule.id,
          outcome: "missed",
          message: "应用未运行期间错过了一次性任务的触发时间",
        });
        this.patch(schedule.id, { enabled: false });
        return true;
      }
      this.nextAt.set(schedule.id, trigger.at);
    } else if ("everyMinutes" in trigger) {
      this.nextAt.set(schedule.id, now + trigger.everyMinutes * 60_000);
    } else {
      const next = nextCronAfter(trigger.cron, now);
      if (next !== null) {
        this.nextAt.set(schedule.id, next);
      } else {
        this.nextAt.delete(schedule.id);
      }
    }
    return false;
  }

  private tick = (): void => {
    this.timer = null;
    if (!this.started) {
      return;
    }
    const now = this.now();
    if (now < this.lastTick - 1_000) {
      // 系统时间回拨：按新时间重算所有下一次触发
      for (const schedule of this.schedules.values()) {
        if (schedule.kind === "cron" && schedule.enabled) {
          this.initNext(schedule, now, false);
        }
      }
    }
    this.lastTick = now;
    let dirty = false;

    for (const schedule of [...this.schedules.values()]) {
      if (!schedule.enabled) {
        continue;
      }
      if (schedule.kind === "cron") {
        const next = this.nextAt.get(schedule.id);
        if (next === undefined || next > now) {
          continue;
        }
        const late = now - next;
        const trigger = schedule.trigger;
        if ("at" in trigger) {
          this.nextAt.delete(schedule.id);
          this.patch(schedule.id, { enabled: false });
          dirty = true;
        } else if ("everyMinutes" in trigger) {
          this.nextAt.set(schedule.id, now + trigger.everyMinutes * 60_000);
        } else {
          const following = nextCronAfter(trigger.cron, now);
          if (following !== null) {
            this.nextAt.set(schedule.id, following);
          } else {
            this.nextAt.delete(schedule.id);
          }
        }
        if (late > LATE_TOLERANCE_MS) {
          this.record({
            scheduleId: schedule.id,
            outcome: "missed",
            message: `错过触发时间（晚了 ${Math.round(late / 1000)} 秒，不补跑）`,
          });
        } else {
          void this.fireCron(schedule, false);
        }
      } else if (schedule.kind === "heartbeat") {
        const due = this.heartbeatDue(schedule);
        if (due !== null && due <= now) {
          const idle = this.idleSince.get(schedule.agentId)!;
          if (!this.agentBusy(schedule.agentId)) {
            this.heartbeatFired.set(schedule.id, idle);
            void this.fireHeartbeat(schedule, false);
          }
        }
      }
    }
    if (dirty) {
      this.persist();
      this.emitChanged();
    }
    this.rearm();
  };

  private heartbeatDue(schedule: HeartbeatSchedule): number | null {
    const idle = this.idleSince.get(schedule.agentId);
    if (idle === undefined || this.heartbeatFired.get(schedule.id) === idle) {
      return null;
    }
    return idle + schedule.idleMinutes * 60_000;
  }

  private rearm(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.started) {
      return;
    }
    const now = this.now();
    let wake = now + TICK_MAX_MS;
    for (const schedule of this.schedules.values()) {
      if (!schedule.enabled) {
        continue;
      }
      if (schedule.kind === "cron") {
        const next = this.nextAt.get(schedule.id);
        if (next !== undefined && next < wake) {
          wake = next;
        }
      } else if (schedule.kind === "heartbeat") {
        const due = this.heartbeatDue(schedule);
        // 已到期却未触发（如会话状态异常忙）时至少隔 1 秒再查，避免空转
        const at = due !== null && due <= now ? now + 1_000 : due;
        if (at !== null && at < wake) {
          wake = at;
        }
      }
    }
    const delay = Math.max(1, Math.min(wake - now, TICK_MAX_MS));
    this.timer = setTimeout(this.tick, delay);
    this.timer.unref?.();
  }

  // -------------------------------------------------------------------------
  // cron 触发
  // -------------------------------------------------------------------------

  private async fireCron(schedule: CronSchedule, manual: boolean): Promise<void> {
    if (this.inflight.has(schedule.id)) {
      this.record({
        scheduleId: schedule.id,
        outcome: "skipped_busy",
        message: "上一次触发仍在等待目标会话空闲",
      });
      return;
    }
    if (this.paused && !manual) {
      this.record({ scheduleId: schedule.id, outcome: "skipped_paused", message: "已全局暂停" });
      return;
    }
    this.inflight.add(schedule.id);
    try {
      await this.deliverCron(schedule);
    } catch (error) {
      this.logger.warn("定时任务 %s 触发出错：%s", schedule.id, errorMessage(error));
      this.fail(schedule, errorMessage(error));
    } finally {
      this.inflight.delete(schedule.id);
    }
  }

  private async deliverCron(schedule: CronSchedule): Promise<void> {
    const target = schedule.target;
    let agentId: string;
    let retries = 0;
    if (target.type === "agent") {
      agentId = target.agentId;
      let snapshot: AgentSnapshot;
      try {
        snapshot = this.manager.getAgent(agentId);
      } catch {
        this.targetGone(schedule);
        return;
      }
      if (isBusy(snapshot)) {
        if (schedule.onBusy === "skip") {
          this.record({
            scheduleId: schedule.id,
            agentId,
            outcome: "skipped_busy",
            message: "目标会话正在运行，已跳过",
          });
          return;
        }
        const idle = await this.waitIdle(agentId, WAIT_BUSY_MAX_MS);
        if (!this.schedules.has(schedule.id)) {
          return;
        }
        if (!idle) {
          if (!this.agentExists(agentId)) {
            return; // 会话已被删除，handleAgentRemoved 已处理
          }
          this.record({
            scheduleId: schedule.id,
            agentId,
            outcome: "skipped_busy",
            message: "等待目标会话空闲超时（30 分钟）",
          });
          return;
        }
        retries = SEND_RETRY_MAX;
      }
    } else {
      const created = await this.manager.createAgent({
        provider: target.provider,
        cwd: target.cwd,
        ...(target.model ? { model: target.model } : {}),
        ...(target.modeId ? { modeId: target.modeId } : {}),
        ...(target.thinkingOptionId ? { thinkingOptionId: target.thinkingOptionId } : {}),
        title: target.title?.trim() || schedule.name,
        origin: "schedule",
      });
      agentId = created.id;
    }
    try {
      const { turnId } = await this.sendInternal(agentId, schedule.prompt, retries);
      this.record({ scheduleId: schedule.id, agentId, turnId, outcome: "sent" });
    } catch (error) {
      if (isTurnInProgress(error)) {
        this.record({
          scheduleId: schedule.id,
          agentId,
          outcome: "skipped_busy",
          message: "目标会话正在运行，已跳过",
        });
        return;
      }
      if (error instanceof AgentRpcError && error.code === "AGENT_NOT_FOUND") {
        this.targetGone(schedule);
        return;
      }
      this.fail(schedule, errorMessage(error), agentId);
    }
  }

  // -------------------------------------------------------------------------
  // 心跳
  // -------------------------------------------------------------------------

  private async fireHeartbeat(schedule: HeartbeatSchedule, manual: boolean): Promise<void> {
    const { id, agentId } = schedule;
    if (this.paused && !manual) {
      this.record({ scheduleId: id, agentId, outcome: "skipped_paused", message: "已全局暂停" });
      return;
    }
    let snapshot: AgentSnapshot;
    try {
      snapshot = this.manager.getAgent(agentId);
    } catch {
      this.targetGone(schedule);
      return;
    }
    if (isBusy(snapshot)) {
      this.record({ scheduleId: id, agentId, outcome: "skipped_busy", message: "会话正在运行，已跳过" });
      return;
    }
    try {
      const { turnId } = await this.sendInternal(agentId, schedule.prompt, 0);
      this.record({ scheduleId: id, agentId, turnId, outcome: "sent" });
      const current = this.schedules.get(id);
      if (current?.kind === "heartbeat") {
        const runs = current.runs + 1;
        const exhausted = current.maxRuns !== undefined && runs >= current.maxRuns;
        this.patch(id, exhausted ? { runs, enabled: false } : { runs });
        this.persist();
        this.emitChanged();
        if (exhausted) {
          this.nextAt.delete(id);
        }
      }
    } catch (error) {
      if (isTurnInProgress(error)) {
        this.record({ scheduleId: id, agentId, outcome: "skipped_busy", message: "会话正在运行，已跳过" });
        return;
      }
      this.fail(schedule, errorMessage(error), agentId);
    }
  }

  // -------------------------------------------------------------------------
  // 目标循环
  // -------------------------------------------------------------------------

  private runningGoalFor(agentId: string, exceptId?: string): GoalSchedule | undefined {
    for (const schedule of this.schedules.values()) {
      if (
        schedule.kind === "goal" &&
        schedule.agentId === agentId &&
        schedule.enabled &&
        schedule.state === "running" &&
        schedule.id !== exceptId
      ) {
        return schedule;
      }
    }
    return undefined;
  }

  private currentGoal(id: string): GoalSchedule | undefined {
    const schedule = this.schedules.get(id);
    return schedule?.kind === "goal" && schedule.enabled && schedule.state === "running"
      ? schedule
      : undefined;
  }

  private async sendGoalPrompt(id: string, mode: "first" | "continue"): Promise<void> {
    const goal = this.currentGoal(id);
    if (!goal) {
      return;
    }
    if (this.paused) {
      this.record({
        scheduleId: id,
        agentId: goal.agentId,
        outcome: "skipped_paused",
        message: "已全局暂停，目标循环已暂停",
      });
      this.finishGoal(id, "stopped");
      return;
    }
    try {
      const text = mode === "first" ? goalFirstPrompt(goal) : goalContinuePrompt(goal);
      const { turnId } = await this.sendInternal(goal.agentId, text, SEND_RETRY_MAX);
      this.record({
        scheduleId: id,
        agentId: goal.agentId,
        turnId,
        outcome: "sent",
        message: `第 ${goal.iterations + 1} 轮`,
      });
    } catch (error) {
      if (error instanceof AgentRpcError && error.code === "AGENT_NOT_FOUND") {
        this.targetGone(goal);
        return;
      }
      this.fail(goal, `发送提示失败：${errorMessage(error)}`, goal.agentId);
    }
  }

  private finishGoal(id: string, state: GoalSchedule["state"]): void {
    const goal = this.schedules.get(id);
    if (goal?.kind !== "goal") {
      return;
    }
    this.patch(id, { enabled: false, state });
    this.persist();
    this.emitChanged();
  }

  private async onGoalTurnEnd(id: string, result: TurnResult): Promise<void> {
    let goal = this.currentGoal(id);
    if (!goal) {
      return;
    }
    if (result.kind === "canceled") {
      this.finishGoal(id, "stopped");
      return;
    }
    if (result.kind === "failed" && goal.stopOnFailure) {
      this.fail(goal, `回合失败：${result.error ?? "未知错误"}`, goal.agentId);
      return;
    }
    if (result.kind === "completed") {
      const done = goal.judge
        ? await this.judge(goal, result.text)
        : endsWithMarker(result.text, goal.doneMarker);
      goal = this.currentGoal(id);
      if (!goal) {
        return; // 评判期间用户介入 / 任务被删除
      }
      if (done) {
        this.finishGoal(id, "done");
        this.record({
          scheduleId: id,
          agentId: goal.agentId,
          outcome: "done",
          message: `目标已完成（共 ${goal.iterations + 1} 轮）`,
        });
        this.emitNotice({
          scheduleId: id,
          name: goal.name,
          kind: "done",
          message: `目标循环已完成：${goal.goal}`,
          agentId: goal.agentId,
        });
        return;
      }
    }
    const iterations = goal.iterations + 1;
    this.patch(id, { iterations });
    if (iterations >= goal.maxIterations) {
      this.finishGoal(id, "exhausted");
      const message = `已达最大迭代次数 ${goal.maxIterations}，目标未完成`;
      this.record({ scheduleId: id, agentId: goal.agentId, outcome: "failed", message });
      this.emitNotice({
        scheduleId: id,
        name: goal.name,
        kind: "exhausted",
        message,
        agentId: goal.agentId,
      });
      return;
    }
    this.persist();
    this.emitChanged();
    await this.sendGoalPrompt(id, "continue");
  }

  /** 新建隐藏评判会话判定目标是否完成；任何失败都按「未完成」处理 */
  private async judge(goal: GoalSchedule, reply: string): Promise<boolean> {
    let judgeId: string | null = null;
    try {
      const source = this.manager.getAgent(goal.agentId);
      const created = await this.manager.createAgent({
        provider: goal.judge!.provider,
        cwd: source.cwd,
        ...(goal.judge!.model ? { model: goal.judge!.model } : {}),
        title: `评判：${goal.name}`,
        origin: "judge",
      });
      judgeId = created.id;
      const waiting = this.waitTurnEnd(judgeId, JUDGE_TIMEOUT_MS);
      await this.sendInternal(judgeId, goalJudgePrompt(goal, reply), 0);
      const result = await waiting;
      if (!result || result.kind !== "completed") {
        this.logger.warn("目标 %s 的评判会话未正常完成，按未完成处理", goal.id);
        return false;
      }
      return parseJudgeReply(result.text);
    } catch (error) {
      this.logger.warn("目标 %s 评判失败，按未完成处理：%s", goal.id, errorMessage(error));
      return false;
    } finally {
      if (judgeId) {
        this.cancelWaiters(judgeId);
        await this.manager.deleteAgent(judgeId).catch((error: unknown) => {
          this.logger.warn("删除评判会话 %s 失败：%s", judgeId, errorMessage(error));
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // 事件
  // -------------------------------------------------------------------------

  private handleStream(envelope: AgentStreamEnvelope): void {
    const { agentId, event } = envelope;
    switch (event.type) {
      case "turn_started":
        this.idleSince.delete(agentId);
        this.trackers.set(agentId, {
          // 缓存保活回合（design.md 4.36）与 CLI 自发轮次一样不算所等待回合的结果
          background: event.origin === "background" || event.origin === "keepalive",
          messageId: null,
          text: "",
        });
        return;
      case "timeline": {
        const item = event.item;
        if (item.type !== "assistant_message" || item.source === "command") {
          return;
        }
        let tracker = this.trackers.get(agentId);
        if (!tracker) {
          tracker = { background: false, messageId: null, text: "" };
          this.trackers.set(agentId, tracker);
        }
        if (item.messageId !== undefined && item.messageId !== tracker.messageId) {
          tracker.messageId = item.messageId;
          tracker.text = item.text;
        } else {
          tracker.text += item.text;
        }
        return;
      }
      case "turn_completed":
      case "turn_failed":
      case "turn_canceled": {
        const tracker = this.trackers.get(agentId);
        this.trackers.delete(agentId);
        this.idleSince.set(agentId, this.now());
        const result: TurnResult = {
          kind:
            event.type === "turn_completed"
              ? "completed"
              : event.type === "turn_failed"
                ? "failed"
                : "canceled",
          text: tracker?.text ?? "",
          background: tracker?.background ?? false,
          ...(event.type === "turn_failed" ? { error: event.error } : {}),
        };
        const waiters = this.turnWaiters.get(agentId);
        if (waiters?.length) {
          this.turnWaiters.delete(agentId);
          for (const waiter of waiters) {
            waiter(result);
          }
        }
        if (!result.background) {
          for (const schedule of this.schedules.values()) {
            if (schedule.kind === "goal" && schedule.agentId === agentId) {
              const id = schedule.id;
              // 延后一拍：让 AgentManager 处理完本次回合结束事件（状态回到 idle）后再发下一条
              void Promise.resolve().then(() => this.onGoalTurnEnd(id, result));
            }
          }
        }
        // 心跳的空闲计时从回合结束开始，需要重新计算唤醒时间
        this.rearm();
        return;
      }
      default:
        return;
    }
  }

  private handleUserAction(agentId: string): void {
    // 用户在目标循环的会话里手动发送 / 插话 / 中断：循环暂停为 stopped（调度器自己的发送带 internal 标记，不会进这里）
    for (const schedule of this.schedules.values()) {
      if (schedule.kind === "goal" && schedule.enabled && schedule.state === "running" && schedule.agentId === agentId) {
        this.finishGoal(schedule.id, "stopped");
      }
    }
  }

  private handleAgentRemoved(agentId: string): void {
    this.idleSince.delete(agentId);
    this.trackers.delete(agentId);
    let dirty = false;
    for (const schedule of [...this.schedules.values()]) {
      if (schedule.enabled && this.boundAgentId(schedule) === agentId) {
        this.targetGone(schedule);
        dirty = true;
      }
    }
    if (dirty) {
      this.rearm();
    }
  }

  // -------------------------------------------------------------------------
  // 帮助方法
  // -------------------------------------------------------------------------

  private boundAgentId(schedule: Schedule): string | null {
    if (schedule.kind === "cron") {
      return schedule.target.type === "agent" ? schedule.target.agentId : null;
    }
    return schedule.agentId;
  }

  private agentExists(agentId: string): boolean {
    try {
      this.manager.getAgent(agentId);
      return true;
    } catch {
      return false;
    }
  }

  private agentBusy(agentId: string): boolean {
    try {
      return isBusy(this.manager.getAgent(agentId));
    } catch {
      return false;
    }
  }

  /** 确保该会话有空闲起点：当前不在运行时从现在起算 */
  private trackIdle(agentId: string): void {
    if (!this.idleSince.has(agentId) && !this.agentBusy(agentId)) {
      this.idleSince.set(agentId, this.now());
    }
  }

  private async sendInternal(
    agentId: string,
    text: string,
    retries: number,
  ): Promise<{ turnId: string }> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.manager.sendPrompt(agentId, text, undefined, { internal: true });
      } catch (error) {
        if (!isTurnInProgress(error) || attempt >= retries) {
          throw error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, SEND_RETRY_DELAY_MS));
      }
    }
  }

  private waitIdle(agentId: string, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let unsubscribe: (() => void) | null = null;
      let timer: NodeJS.Timeout | null = null;
      const finish = (value: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        unsubscribe?.();
        if (timer) {
          clearTimeout(timer);
        }
        resolve(value);
      };
      unsubscribe = this.manager.subscribe({
        onState: (agent) => {
          if (agent.id === agentId && !isBusy(agent)) {
            finish(true);
          }
        },
        onRemoved: (id) => {
          if (id === agentId) {
            finish(false);
          }
        },
      });
      timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      try {
        if (!isBusy(this.manager.getAgent(agentId))) {
          finish(true);
        }
      } catch {
        finish(false);
      }
    });
  }

  private waitTurnEnd(agentId: string, timeoutMs: number): Promise<TurnResult | null> {
    return new Promise<TurnResult | null>((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      const waiter = (result: TurnResult): void => {
        if (timer) {
          clearTimeout(timer);
        }
        resolve(result);
      };
      const list = this.turnWaiters.get(agentId) ?? [];
      list.push(waiter);
      this.turnWaiters.set(agentId, list);
      timer = setTimeout(() => {
        const current = this.turnWaiters.get(agentId);
        if (current) {
          this.turnWaiters.set(
            agentId,
            current.filter((item) => item !== waiter),
          );
        }
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
    });
  }

  private cancelWaiters(agentId: string): void {
    this.turnWaiters.delete(agentId);
  }

  /** 会话已被删除：停用指向它的任务并记一条 failed */
  private targetGone(schedule: Schedule): void {
    this.disableForGoneTarget(schedule);
    this.persist();
    this.fail(schedule, TARGET_GONE_MESSAGE, this.boundAgentId(schedule) ?? undefined, false);
  }

  private disableForGoneTarget(schedule: Schedule): void {
    this.nextAt.delete(schedule.id);
    if (schedule.kind === "goal") {
      this.patch(schedule.id, { enabled: false, state: "failed" });
    } else {
      this.patch(schedule.id, { enabled: false });
    }
  }

  /** 记 failed 运行记录并发失败通知；目标循环同时转为 failed */
  private fail(schedule: Schedule, message: string, agentId?: string, finishGoal = true): void {
    if (schedule.kind === "goal" && finishGoal) {
      this.finishGoal(schedule.id, "failed");
    }
    this.record({ scheduleId: schedule.id, outcome: "failed", message, ...(agentId ? { agentId } : {}) });
    this.emitNotice({
      scheduleId: schedule.id,
      name: schedule.name,
      kind: "failed",
      message,
      ...(agentId ? { agentId } : {}),
    });
  }

  private patch(id: string, patch: Partial<Schedule>): void {
    const current = this.schedules.get(id);
    if (!current) {
      return;
    }
    this.schedules.set(id, { ...current, ...patch, updatedAt: this.now() } as Schedule);
  }

  private record(run: Omit<ScheduleRun, "ts">): void {
    void this.store.appendRun({ ...run, ts: this.now() }).catch((error: unknown) => {
      this.logger.error("追加运行记录失败：%s", errorMessage(error));
    });
    this.emitChanged();
  }

  private persist(): void {
    void this.store.save({ paused: this.paused, schedules: this.snapshotSchedules() }).catch((error: unknown) => {
      this.logger.error("持久化调度失败：%s", errorMessage(error));
    });
  }

  private snapshotSchedules(): Schedule[] {
    return [...this.schedules.values()].map((schedule) => structuredClone(schedule));
  }

  private emitChanged(): void {
    const schedules = this.snapshotSchedules();
    for (const listener of this.listeners) {
      try {
        listener.onChanged?.(schedules, this.paused);
      } catch (error) {
        this.logger.error("schedule.changed 监听器出错：%s", String(error));
      }
    }
  }

  private emitNotice(notice: ScheduleNotice): void {
    for (const listener of this.listeners) {
      try {
        listener.onNotice?.(notice);
      } catch (error) {
        this.logger.error("schedule.notice 监听器出错：%s", String(error));
      }
    }
  }
}
