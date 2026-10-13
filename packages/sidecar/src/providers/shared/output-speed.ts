// 输出速度（tok/s）计算（design.md 4.30）：本回合输出 token ÷（当前或结束时刻 − 首个输出到达时刻）。AgentDeck 原创。

/** 首个输出不足该时长时不计算（避免刚开始时的速度尖峰） */
const MIN_ELAPSED_MS = 1000;
/** 回合中最多每秒下发一次 */
const EMIT_INTERVAL_MS = 1000;

export class OutputSpeedTracker {
  private firstOutputAt: number | null = null;
  private lastEmitAt: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** 新回合开始 */
  reset(): void {
    this.firstOutputAt = null;
    this.lastEmitAt = null;
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
    const elapsed = this.now() - this.firstOutputAt;
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
