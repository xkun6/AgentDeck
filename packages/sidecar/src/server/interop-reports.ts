// 派单回传（design.md 4.26）：派单方发出的回合结束后，把结果作为一条内部消息发回派单会话，
// 让它不必阻塞等待。记录只在内存，sidecar 重启后丢失。
import type { AgentSnapshot } from "@agentdeck/protocol";

import type { AgentManager } from "../agent/agent-manager.js";
import { AgentRpcError } from "../agent/errors.js";
import { createSilentLogger, type Logger } from "../logger.js";

/** 回合结束后的稳定时间：防止把后台子代理完成后 CLI 自发的下一轮截断，也让前端排队消息优先发出 */
export const REPORT_SETTLE_MS = 1500;

export function isBusy(snapshot: AgentSnapshot): boolean {
  return snapshot.status === "running" || snapshot.status === "starting" || Boolean(snapshot.activeTurnId);
}

export interface InteropReportsOptions {
  manager: Pick<AgentManager, "subscribe" | "getAgent" | "sendPrompt">;
  /** 组装一个回合的回传文本 */
  describeTurn(agentId: string, sinceSeq: number, reportTo: string): Promise<string>;
  settleMs?: number;
  logger?: Logger;
}

interface ExpectedTurn {
  reportTo: string;
  sinceSeq: number;
  timer?: NodeJS.Timeout;
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
  private readonly logger: Logger;
  /** 等待回传的回合，键为执行方会话 */
  private readonly expected = new Map<string, ExpectedTurn>();
  /** 待投递的回传，键为接收方会话 */
  private readonly pending = new Map<string, QueuedReport[]>();
  private readonly flushTimers = new Map<string, NodeJS.Timeout>();
  private readonly unsubscribe: () => void;
  private stopped = false;

  constructor(options: InteropReportsOptions) {
    this.manager = options.manager;
    this.describeTurn = options.describeTurn;
    this.settleMs = options.settleMs ?? REPORT_SETTLE_MS;
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
      if (snapshot.status === "closed" || snapshot.status === "dormant") {
        this.clearExpected(snapshot.id);
      } else if (isBusy(snapshot) || snapshot.backgroundActive === true) {
        clearTimeout(turn.timer);
        delete turn.timer;
      } else if (!turn.timer) {
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
    this.expected.delete(agentId);
    try {
      const text = await this.describeTurn(agentId, turn.sinceSeq, turn.reportTo);
      if (!this.stopped) {
        this.enqueue(turn.reportTo, agentId, text);
      }
    } catch (error) {
      this.logger.warn("组装派单回传失败（%s）：%s", agentId, error instanceof Error ? error.message : String(error));
    }
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
    try {
      await this.manager.sendPrompt(reportTo, queue.map((report) => report.text).join("\n\n---\n\n"), undefined, {
        internal: true,
      });
    } catch (error) {
      if (error instanceof AgentRpcError && error.code === "TURN_IN_PROGRESS") {
        // 正好被别的发送抢先：放回队首，等下一次空闲
        this.pending.set(reportTo, [...queue, ...(this.pending.get(reportTo) ?? [])]);
        return;
      }
      this.logger.warn(
        "向派单会话 %s 发送回传失败：%s",
        reportTo,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private startTimer(run: () => void): NodeJS.Timeout {
    const timer = setTimeout(run, this.settleMs);
    timer.unref();
    return timer;
  }

  private clearExpected(agentId: string): void {
    clearTimeout(this.expected.get(agentId)?.timer);
    this.expected.delete(agentId);
  }

  private clearFlushTimer(reportTo: string): void {
    clearTimeout(this.flushTimers.get(reportTo));
    this.flushTimers.delete(reportTo);
  }

  private dropQueue(reportTo: string): void {
    this.clearFlushTimer(reportTo);
    this.pending.delete(reportTo);
  }
}
