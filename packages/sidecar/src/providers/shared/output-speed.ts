// 输出速度（tok/s）计算（design.md 4.30）：本回合输出 token ÷（当前或结束时刻 − 首个输出到达时刻 − 其间审批等待时长）。AgentDeck 原创。

/** 首个输出不足该时长时不计算（避免刚开始时的速度尖峰） */
const MIN_ELAPSED_MS = 1000;
/** 回合中最多每秒下发一次 */
const EMIT_INTERVAL_MS = 1000;

export class OutputSpeedTracker {
  private firstOutputAt: number | null = null;
  private lastEmitAt: number | null = null;
  /** 正在等待审批的请求（同一时刻可能有多个）；非空 = 暂停计时 */
  private readonly waiting = new Set<string>();
  private pausedSince: number | null = null;
  /** 首个输出之后、已结束的审批等待累计时长 */
  private pausedTotal = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** 新回合开始 */
  reset(): void {
    this.firstOutputAt = null;
    this.lastEmitAt = null;
    this.waiting.clear();
    this.pausedSince = null;
    this.pausedTotal = 0;
  }

  /**
   * 把会话事件喂进来：`permission_requested` 到 `permission_resolved` 之间是在等用户审批，不是模型在输出，
   * 这段时间从耗时里扣除（只扣首个输出之后的部分；首个输出之前的等待本来就不在分母里）。
   */
  observe(event: { type: string; request?: { id: string }; requestId?: string }): void {
    if (event.type === "permission_requested" && event.request) {
      if (this.waiting.size === 0) this.pausedSince = this.now();
      this.waiting.add(event.request.id);
    } else if (event.type === "permission_resolved" && event.requestId !== undefined) {
      if (!this.waiting.delete(event.requestId) || this.waiting.size > 0) return;
      if (this.pausedSince !== null) this.pausedTotal += this.pausedOverlap(this.pausedSince);
      this.pausedSince = null;
    }
  }

  private pausedOverlap(since: number): number {
    if (this.firstOutputAt === null) return 0;
    return Math.max(0, this.now() - Math.max(since, this.firstOutputAt));
  }

  /** 本回合第一个 assistant_message / reasoning 到达时调用（重复调用无效） */
  markOutput(): void {
    if (this.firstOutputAt === null) {
      this.firstOutputAt = this.now();
    }
  }

  /** 当前速度；没有首个输出、不足 1 秒或没有 token 时返回 undefined */
  speed(outputTokens: number): number | undefined {
    if (this.firstOutputAt === null || !(outputTokens > 0)) {
      return undefined;
    }
    const paused = this.pausedTotal + (this.pausedSince !== null ? this.pausedOverlap(this.pausedSince) : 0);
    const elapsed = this.now() - this.firstOutputAt - paused;
    if (elapsed < MIN_ELAPSED_MS) {
      return undefined;
    }
    return Math.round((outputTokens / (elapsed / 1000)) * 10) / 10;
  }

  /** 回合中的节流版本：距上次下发不足 1 秒返回 undefined；返回值时记为已下发 */
  throttledSpeed(outputTokens: number): number | undefined {
    const at = this.now();
    if (this.lastEmitAt !== null && at - this.lastEmitAt < EMIT_INTERVAL_MS) {
      return undefined;
    }
    const value = this.speed(outputTokens);
    if (value !== undefined) {
      this.lastEmitAt = at;
    }
    return value;
  }
}
