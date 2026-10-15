// 输出速度（tok/s）计算（design.md 4.30）：纯生成速度 = 本回合输出 token ÷ 模型实际在流式输出的累计时长。AgentDeck 原创。

/** 累计生成时长不足该值时不计算（避免刚开始时的速度尖峰） */
const MIN_ELAPSED_MS = 1000;
/** 回合中最多每秒下发一次 */
const EMIT_INTERVAL_MS = 1000;

/**
 * 「生成段」= 一次模型响应从首个输出（思考块 / 文字 / 工具参数等任意类型）到达，到该响应结束。
 * 首 token 等待、工具执行、审批等待都在生成段之外，不计入分母。
 */
export class OutputSpeedTracker {
  /** 当前生成段起点；null = 当前不在生成 */
  private activeSince: number | null = null;
  /** 已结束生成段的累计时长 */
  private activeTotal = 0;
  private lastEmitAt: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** 新回合开始：全部清零 */
  reset(): void {
    this.activeSince = null;
    this.activeTotal = 0;
    this.lastEmitAt = null;
  }

  /** 模型有输出到达时调用：不在生成段内则开一段（段内重复调用无效） */
  markOutput(): void {
    if (this.activeSince === null) {
      this.activeSince = this.now();
    }
  }

  /** 一次模型响应结束 / 开始调工具 / 等审批 / 回合结束时调用：关闭当前生成段，时长计入累计 */
  markIdle(): void {
    if (this.activeSince === null) {
      return;
    }
    this.activeTotal += Math.max(0, this.now() - this.activeSince);
    this.activeSince = null;
  }

  /** 把会话事件喂进来：`permission_requested` 表示开始等用户审批，不是模型在输出，关闭当前生成段 */
  observe(event: { type: string }): void {
    if (event.type === "permission_requested") {
      this.markIdle();
    }
  }

  /** 当前速度；没有 token 或累计生成时长不足 1 秒时返回 undefined */
  speed(outputTokens: number): number | undefined {
    if (!(outputTokens > 0)) {
      return undefined;
    }
    const active = this.activeTotal + (this.activeSince !== null ? Math.max(0, this.now() - this.activeSince) : 0);
    if (active < MIN_ELAPSED_MS) {
      return undefined;
    }
    return Math.round((outputTokens / (active / 1000)) * 10) / 10;
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
