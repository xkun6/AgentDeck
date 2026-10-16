// 输出速度（tok/s）计算（design.md 4.30）：口径对齐 cc-switch——按单次模型响应记账，只计输出 ≥100 token 且生成 ≥100ms 的响应，速度 = Σ合格输出 ÷ Σ合格生成时长。AgentDeck 原创。

/** 输出少于该值的响应（工具调用这类）不计入速度 */
const MIN_RESPONSE_TOKENS = 100;
/** 生成时长短于该值的响应不计入（中转站缓冲后一次性吐出的突发） */
const MIN_RESPONSE_MS = 100;
/** 回合中最多每秒下发一次 */
const EMIT_INTERVAL_MS = 1000;

function isEligible(outputTokens: number, generationMs: number): boolean {
  return outputTokens >= MIN_RESPONSE_TOKENS && generationMs >= MIN_RESPONSE_MS;
}

/**
 * 「生成段」= 模型有输出（思考块 / 文字 / 工具参数等任意类型）到达起，到响应结束或被审批等打断为止。
 * 一次响应可被切成多段，时长累加；首 token 等待、工具执行、审批等待都在生成段之外。
 */
export class OutputSpeedTracker {
  /** 当前生成段起点；null = 当前不在生成 */
  private activeSince: number | null = null;
  /** 当前响应已结束生成段的累计时长 */
  private responseMs = 0;
  /** 合格响应的累计输出 token 与生成时长 */
  private eligibleTokens = 0;
  private eligibleMs = 0;
  private lastEmitAt: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** 新回合开始：全部清零 */
  reset(): void {
    this.activeSince = null;
    this.responseMs = 0;
    this.eligibleTokens = 0;
    this.eligibleMs = 0;
    this.lastEmitAt = null;
  }

  /** 模型有输出到达时调用：不在生成段内则开一段（段内重复调用无效） */
  markOutput(): void {
    if (this.activeSince === null) {
      this.activeSince = this.now();
    }
  }

  /** 开始调工具 / 等审批等：关闭当前生成段，时长计入当前响应 */
  markIdle(): void {
    if (this.activeSince === null) {
      return;
    }
    this.responseMs += Math.max(0, this.now() - this.activeSince);
    this.activeSince = null;
  }

  /** 一次模型响应结束：闭段，达门槛则计入合格累计；没有生成时长的响应（如已结束过）自然被忽略 */
  endResponse(outputTokens: number): void {
    this.markIdle();
    if (isEligible(outputTokens, this.responseMs)) {
      this.eligibleTokens += outputTokens;
      this.eligibleMs += this.responseMs;
    }
    this.responseMs = 0;
  }

  /** 把会话事件喂进来：`permission_requested` 表示开始等用户审批，不是模型在输出，关闭当前生成段 */
  observe(event: { type: string }): void {
    if (event.type === "permission_requested") {
      this.markIdle();
    }
  }

  /** 当前速度：合格累计 + 进行中且已达门槛的响应；没有合格响应时返回 undefined */
  speed(currentResponseTokens = 0): number | undefined {
    let tokens = this.eligibleTokens;
    let ms = this.eligibleMs;
    const currentMs = this.responseMs + (this.activeSince !== null ? Math.max(0, this.now() - this.activeSince) : 0);
    if (isEligible(currentResponseTokens, currentMs)) {
      tokens += currentResponseTokens;
      ms += currentMs;
    }
    if (ms <= 0) {
      return undefined;
    }
    return Math.round((tokens / (ms / 1000)) * 10) / 10;
  }

  /** 回合中的节流版本：距上次下发不足 1 秒返回 undefined；返回值时记为已下发 */
  throttledSpeed(currentResponseTokens = 0): number | undefined {
    const at = this.now();
    if (this.lastEmitAt !== null && at - this.lastEmitAt < EMIT_INTERVAL_MS) {
      return undefined;
    }
    const value = this.speed(currentResponseTokens);
    if (value !== undefined) {
      this.lastEmitAt = at;
    }
    return value;
  }
}
