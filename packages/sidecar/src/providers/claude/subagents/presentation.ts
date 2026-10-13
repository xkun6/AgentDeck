// Derived from paseo packages/server/src/server/agent/providers/claude/subagents/presentation.ts (Apache-2.0); modified for AgentDeck
// 改动：模型显示名按 id 自行格式化（如 claude-haiku-4-5-20251001 → Haiku 4.5），不依赖 paseo models.ts。

export interface ClaudeSubagentUsage {
  totalTokens?: number;
}

export interface ClaudeSubagentPresentationFacts {
  title?: string;
  model?: string;
  effort?: string;
  usage?: ClaudeSubagentUsage;
}

/** 子代理次级标签：类型 · 模型 · effort · Nk tokens（缺项跳过） */
export function buildClaudeSubagentSubtitle(
  facts: ClaudeSubagentPresentationFacts,
): string | undefined {
  const parts = [
    readPart(facts.title),
    formatModel(facts.model),
    formatEffort(facts.effort),
    formatTokens(facts.usage?.totalTokens),
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** 子代理 assistant 帧上的模型 id；占位值（<synthetic>）返回 null */
export function resolveObservedClaudeModelId(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || trimmed === "<synthetic>") {
    return null;
  }
  return trimmed;
}

function readPart(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function formatModel(modelId: string | undefined): string | undefined {
  const normalized = readPart(modelId);
  if (!normalized) return undefined;
  const match = normalized.match(
    /^(?:claude[-_ ])?(fable|opus|sonnet|haiku)[-_ ]+(\d+)(?:[-.](\d{1,2}))?(?:[-_ ]+\d{8})?(\[1m\])?$/i,
  );
  if (!match) return normalized;
  const family = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1).toLowerCase();
  const version = match[3] ? `${match[2]}.${match[3]}` : match[2]!;
  return `${family} ${version}${match[4] ? " (1M)" : ""}`;
}

function formatEffort(effort: string | undefined): string | undefined {
  const normalized = readPart(effort);
  if (!normalized) return undefined;
  if (normalized === "xhigh") return "Extra High";
  return normalized
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatTokens(totalTokens: number | undefined): string | undefined {
  if (typeof totalTokens !== "number" || totalTokens <= 0) return undefined;
  if (totalTokens < 1000) return `${Math.round(totalTokens)} tokens`;
  return `${Math.round(totalTokens / 100) / 10}k tokens`;
}
