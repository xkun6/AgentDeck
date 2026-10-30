// 派单回传（design.md 4.26）：派单方发出的回合结束后，把结果作为一条内部消息发回派单会话，
// 让它不必阻塞等待；之后回收干活会话的进程。记录只在内存，sidecar 重启后丢失。
import type { AgentSnapshot } from "@agentdeck/protocol";

import type { AgentManager } from "../agent/agent-manager.js";
import { AgentRpcError } from "../agent/errors.js";
import { createSilentLogger, type Logger } from "../logger.js";

/** 回合结束后的稳定时间：防止把后台子代理完成后 CLI 自发的下一轮截断，也让前端排队消息优先发出 */
export const REPORT_SETTLE_MS = 1500;
/** 发送失败（如恢复失败）的重试：TURN_IN_PROGRESS 不算，它等下一次空闲 */
export const REPORT_RETRY_MS = 60_000;
export const REPORT_MAX_RETRIES = 5;

export function isBusy(snapshot: AgentSnapshot): boolean {
  return snapshot.status === "running" || snapshot.status === "starting" || Boolean(snapshot.activeTurnId);
}

export interface InteropReportsOptions {
  manager: Pick<AgentManager, "subscribe" | "getAgent" | "sendPrompt" | "reclaimIfIdle">;
  /** 组装一个回合的回传文本 */
  describeTurn(agentId: string, sinceSeq: number, reportTo: string): Promise<string>;
  settleMs?: number;
  retryMs?: number;
  logger?: Logger;
}

interface ExpectedTurn {
  reportTo: string;
  sinceSeq: number;
  timer?: NodeJS.Timeout;
  /** 正在组装回传：此时记录保留，别的逻辑仍视为未完成，wait / cancel 也还能撤回 */
  composing?: boolean;
}

interface QueuedReport {
  /** 来源会话，派单方等到结果时据此撤回 */
  from: string;
  text: string;
}

export class InteropReports {
  private readonly manager: InteropReportsOptions["manager"];
  private readonly describeTurn: InteropReportsOptions["describeTurn"];
  private readonly settleMs: number;
  private readonly retryMs: number;
  private readonly logger: Logger;
  /** 等待回传的回合，键为执行方会话 */
  private readonly expected = new Map<string, ExpectedTurn>();
  /** 待投递的回传，键为接收方会话 */
  private readonly pending = new Map<string, QueuedReport[]>();
  private readonly flushTimers = new Map<string, NodeJS.Timeout>();
  /** 回传正在发送的接收方：sendPrompt 返回前快照可能还没变成 running */
  private readonly delivering = new Set<string>();
  /** 接收方连续发送失败的次数 */
  private readonly failures = new Map<string, number>();
  private readonly unsubscribe: () => void;
  private stopped = false;

  constructor(options: InteropReportsOptions) {
    this.manager = options.manager;
    this.describeTurn = options.describeTurn;
    this.settleMs = options.settleMs ?? REPORT_SETTLE_MS;
    this.retryMs = options.retryMs ?? REPORT_RETRY_MS;
    this.logger = options.logger ?? createSilentLogger();
    this.unsubscribe = this.manager.subscribe({
      onState: (snapshot) => this.handleState(snapshot),
      onRemoved: (agentId) => this.handleRemoved(agentId),
    });
  }

  /** 登记回传：须在 sendPrompt 返回后调用，此时快照已是 running 或该回合已结束 */
  expect(agentId: string, reportTo: string, sinceSeq: number): void {
    this.clearExpected(agentId);
    this.expected.set(agentId, { reportTo, sinceSeq });
    this.handleState(this.manager.getAgent(agentId));
  }

  /** 它派出的任务还有没回传或没处理完的：此时结束回合不算完成 */
  hasOutstanding(agentId: string): boolean {
    if (this.pending.has(agentId) || this.delivering.has(agentId)) {
      return true;
    }
    for (const turn of this.expected.values()) {
      if (turn.reportTo === agentId) {
        return true;
      }
    }
    return false;
  }

  /** 派单方经 wait 拿到了结果：不再回传，稳定后回收干活的会话 */
  settleWaited(agentId: string, reportTo: string): void {
    this.settle(agentId, reportTo);
    this.startTimer(() => this.reclaimFinished(agentId));
  }

  /** 派单方已拿到结果或自己中断了回合：不再回传，已入队未送达的也撤回 */
  settle(agentId: string, reportTo: string): void {
    if (this.expected.get(agentId)?.reportTo === reportTo) {
      this.clearExpected(agentId);
    }
    const queue = this.pending.get(reportTo);
    if (queue) {
      const rest = queue.filter((report) => report.from !== agentId);
      if (rest.length > 0) {
        this.pending.set(reportTo, rest);
      } else {
        this.dropQueue(reportTo);
      }
    }
  }

  enqueue(reportTo: string, from: string, text: string): void {
    const queue = this.pending.get(reportTo);
    if (queue) {
      queue.push({ from, text });
    } else {
      this.pending.set(reportTo, [{ from, text }]);
    }
    this.scheduleFlush(reportTo);
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe();
    for (const agentId of [...this.expected.keys()]) {
      this.clearExpected(agentId);
    }
    for (const reportTo of [...this.pending.keys()]) {
      this.dropQueue(reportTo);
    }
  }

  private handleState(snapshot: AgentSnapshot): void {
    const turn = this.expected.get(snapshot.id);
    if (turn) {
      const outstanding = this.hasOutstanding(snapshot.id);
      if ((snapshot.status === "closed" || snapshot.status === "dormant") && !outstanding) {
        this.clearExpected(snapshot.id);
      } else if (isBusy(snapshot) || snapshot.backgroundActive === true || outstanding) {
        clearTimeout(turn.timer);
        delete turn.timer;
      } else if (!turn.timer && !turn.composing) {
        turn.timer = this.startTimer(() => void this.fire(snapshot.id, turn));
      }
    }
    if (this.pending.has(snapshot.id)) {
      if (isBusy(snapshot)) {
        this.clearFlushTimer(snapshot.id);
      } else {
        this.scheduleFlush(snapshot.id);
      }
    }
  }

  private handleRemoved(agentId: string): void {
    this.clearExpected(agentId);
    this.dropQueue(agentId);
  }

  private async fire(agentId: string, turn: ExpectedTurn): Promise<void> {
    if (this.expected.get(agentId) !== turn) {
      return;
    }
    delete turn.timer;
    if (this.hasOutstanding(agentId)) {
      return; // 稳定期间又有了未完成的任务：等它们结束后由 recheck 重新安排
    }
    turn.composing = true;
    let text: string | null = null;
    try {
      text = await this.describeTurn(agentId, turn.sinceSeq, turn.reportTo);
    } catch (error) {
      this.logger.warn("组装派单回传失败（%s）：%s", agentId, error instanceof Error ? error.message : String(error));
    }
    if (this.expected.get(agentId) !== turn) {
      return; // 组装期间被 wait / cancel 撤回，或派单方又发了新回合
    }
    this.expected.delete(agentId);
    if (text !== null) {
      this.enqueue(turn.reportTo, agentId, text);
      this.reclaimFinished(agentId);
    }
    this.recheck(turn.reportTo);
  }

  private reclaimFinished(agentId: string): void {
    if (this.stopped || this.hasOutstanding(agentId) || this.expected.has(agentId)) {
      return;
    }
    void this.manager.reclaimIfIdle(agentId).catch((error: unknown) => {
      this.logger.warn("回收干活的会话 %s 失败：%s", agentId, error instanceof Error ? error.message : String(error));
    });
  }

  /** 未完成任务减少后重新判断：干活的会话可能正等着这一项 */
  private recheck(agentId: string): void {
    if (this.stopped) {
      return;
    }
    let snapshot: AgentSnapshot;
    try {
      snapshot = this.manager.getAgent(agentId);
    } catch {
      return;
    }
    this.handleState(snapshot);
  }

  private scheduleFlush(reportTo: string): void {
    if (!this.flushTimers.has(reportTo)) {
      this.flushTimers.set(reportTo, this.startTimer(() => void this.flush(reportTo)));
    }
  }

  private async flush(reportTo: string): Promise<void> {
    this.flushTimers.delete(reportTo);
    const queue = this.pending.get(reportTo);
    if (!queue) {
      return;
    }
    let target: AgentSnapshot;
    try {
      target = this.manager.getAgent(reportTo);
    } catch {
      this.dropQueue(reportTo);
      return;
    }
    if (target.archived) {
      this.logger.warn("派单会话 %s 已归档，放弃 %d 条回传", reportTo, queue.length);
      this.dropQueue(reportTo);
      return;
    }
    if (isBusy(target)) {
      return; // 等它本回合结束，由 handleState 重新安排
    }
    this.pending.delete(reportTo);
    this.delivering.add(reportTo);
    try {
      await this.manager.sendPrompt(reportTo, queue.map((report) => report.text).join("\n\n---\n\n"), undefined, {
        internal: true,
      });
      this.failures.delete(reportTo);
    } catch (error) {
      if (error instanceof AgentRpcError && error.code === "TURN_IN_PROGRESS") {
        // 正好被别的发送抢先：放回队首，等下一次空闲
        this.pending.set(reportTo, [...queue, ...(this.pending.get(reportTo) ?? [])]);
        return;
      }
      const failures = (this.failures.get(reportTo) ?? 0) + 1;
      const giveUp = failures > REPORT_MAX_RETRIES;
      this.logger.warn(
        "向派单会话 %s 发送回传失败（第 %d 次）%s：%s",
        reportTo,
        failures,
        giveUp ? "，放弃" : "，稍后重试",
        error instanceof Error ? error.message : String(error),
      );
      if (giveUp) {
        this.failures.delete(reportTo);
      } else {
        this.failures.set(reportTo, failures);
        this.pending.set(reportTo, [...queue, ...(this.pending.get(reportTo) ?? [])]);
        this.clearFlushTimer(reportTo);
        this.flushTimers.set(reportTo, this.startTimer(() => void this.flush(reportTo), this.retryMs));
      }
    } finally {
      this.delivering.delete(reportTo);
      this.recheck(reportTo);
    }
  }

  private startTimer(run: () => void, delayMs = this.settleMs): NodeJS.Timeout {
    const timer = setTimeout(run, delayMs);
    timer.unref();
    return timer;
  }

  private clearExpected(agentId: string): void {
    const turn = this.expected.get(agentId);
    if (!turn) {
      return;
    }
    clearTimeout(turn.timer);
    this.expected.delete(agentId);
    this.recheck(turn.reportTo);
  }

  private clearFlushTimer(reportTo: string): void {
    clearTimeout(this.flushTimers.get(reportTo));
    this.flushTimers.delete(reportTo);
  }

  private dropQueue(reportTo: string): void {
    this.clearFlushTimer(reportTo);
    this.failures.delete(reportTo);
    this.pending.delete(reportTo);
    this.recheck(reportTo);
  }
}
