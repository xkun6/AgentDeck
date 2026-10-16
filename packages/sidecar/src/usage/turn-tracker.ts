import type {
  AgentProviderId,
  AgentStreamEnvelope,
  UsageTurnRecord,
} from "@agentdeck/protocol";

interface OpenTurn {
  startedAt: number;
  origin: "user" | "background";
  model: string | null;
  firstAssistantAt?: number;
}

/**
 * 把单个会话的事件流折叠成回合账本记录（design.md 4.20）。
 * 实时记录（AgentManager）与历史回填共用：按顺序喂入 envelope，回合结束（completed / failed / canceled）时返回一条记录。
 */
export class UsageTurnTracker {
  private readonly open = new Map<string, OpenTurn>();

  constructor(
    private readonly agentId: string,
    private readonly provider: AgentProviderId,
  ) {}

  /** `model` 为该事件处理时快照中的 model（null = provider 默认），仅在 turn_started 时被记下 */
  observe(envelope: AgentStreamEnvelope, model: string | null): UsageTurnRecord | null {
    const event = envelope.event;
    switch (event.type) {
      case "turn_started":
        this.open.set(event.turnId, {
          startedAt: envelope.timestamp,
          origin: event.origin === "background" ? "background" : "user",
          model,
        });
        return null;
      case "timeline": {
        if (event.item.type === "assistant_message" && event.turnId !== undefined) {
          const turn = this.open.get(event.turnId);
          if (turn && turn.firstAssistantAt === undefined) {
            turn.firstAssistantAt = envelope.timestamp;
          }
        }
        return null;
      }
      case "turn_completed":
        return this.finish(envelope, event.turnId, "completed", model, event.usage);
      case "turn_failed":
        return this.finish(envelope, event.turnId, "failed", model);
      case "turn_canceled":
        return this.finish(envelope, event.turnId, "canceled", model);
      default:
        return null;
    }
  }

  private finish(
    envelope: AgentStreamEnvelope,
    turnId: string,
    outcome: UsageTurnRecord["outcome"],
    model: string | null,
    usage?: {
      inputTokens?: number;
      cachedInputTokens?: number;
      outputTokens?: number;
      totalCostUsd?: number;
      speedOutputTokens?: number;
      speedGenerationMs?: number;
    },
  ): UsageTurnRecord {
    const turn = this.open.get(turnId);
    this.open.delete(turnId);
    const durationMs = turn ? Math.max(0, envelope.timestamp - turn.startedAt) : undefined;
    const ttftMs =
      turn?.firstAssistantAt !== undefined
        ? Math.max(0, turn.firstAssistantAt - turn.startedAt)
        : undefined;
    return {
      ts: envelope.timestamp,
      agentId: this.agentId,
      provider: this.provider,
      model: turn ? turn.model : model,
      turnId,
      origin: turn?.origin ?? "user",
      outcome,
      ...finiteField("inputTokens", usage?.inputTokens),
      ...finiteField("cachedInputTokens", usage?.cachedInputTokens),
      ...finiteField("outputTokens", usage?.outputTokens),
      ...finiteField("costUsd", usage?.totalCostUsd),
      ...finiteField("speedOutputTokens", usage?.speedOutputTokens),
      ...finiteField("speedGenerationMs", usage?.speedGenerationMs),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(ttftMs !== undefined ? { ttftMs } : {}),
    };
  }
}

function finiteField<K extends string>(key: K, value: number | undefined): { [P in K]?: number } {
  return typeof value === "number" && Number.isFinite(value)
    ? ({ [key]: value } as { [P in K]?: number })
    : {};
}
