import type { AgentProviderId, UsageSummary, UsageTurnRecord } from "@agentdeck/protocol";

export const DEFAULT_RANGE_MS = 30 * 24 * 60 * 60 * 1000;
const TOP_AGENTS = 10;

export interface SummaryContext {
  now: number;
  backfilling: boolean;
  /** provider 注册表里的显示名；未知时回退为 id */
  providerLabel: (provider: AgentProviderId) => string | undefined;
  /** 会话仍存在时返回其标题（可为 null）；返回 undefined 表示会话已被删除 */
  agentTitle: (agentId: string) => string | null | undefined;
}

interface Tally {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
}

const emptyTally = (): Tally => ({ inputTokens: 0, outputTokens: 0, costUsd: 0, turns: 0 });

function addTo(tally: Tally, record: UsageTurnRecord): void {
  tally.inputTokens += record.inputTokens ?? 0;
  tally.outputTokens += record.outputTokens ?? 0;
  tally.costUsd += record.costUsd ?? 0;
  tally.turns += 1;
}

/** sidecar 进程本地日期 yyyy-MM-dd */
export function localDay(ts: number): string {
  const date = new Date(ts);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 最近邻（nearest-rank）百分位；values 为空返回 undefined */
export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

/** design.md 4.20：聚合账本。sinceMs 缺省为最近 30 天，untilMs 缺省不设上限 */
export function summarizeUsage(
  records: readonly UsageTurnRecord[],
  range: { sinceMs?: number; untilMs?: number },
  ctx: SummaryContext,
): UsageSummary {
  const since = range.sinceMs ?? ctx.now - DEFAULT_RANGE_MS;
  const until = range.untilMs ?? Number.POSITIVE_INFINITY;

  const totals = {
    turns: 0,
    failedTurns: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
  const days = new Map<string, Tally & { cachedInputTokens: number }>();
  const providers = new Map<AgentProviderId, Tally>();
  const models = new Map<string, Tally & { provider: AgentProviderId; model: string | null }>();
  const agents = new Map<string, Tally & { provider: AgentProviderId }>();
  const ttfts: number[] = [];
  const durations: number[] = [];
  // 输出速度按 Σ合格输出 token ÷ Σ合格生成时长 汇总（design.md 4.20 / 4.30），旧记录没有这两个字段则不参与
  let speedTokens = 0;
  let speedMs = 0;

  for (const record of records) {
    if (record.ts < since || record.ts > until) {
      continue;
    }
    totals.turns += 1;
    if (record.outcome === "failed") {
      totals.failedTurns += 1;
    }
    totals.inputTokens += record.inputTokens ?? 0;
    totals.cachedInputTokens += record.cachedInputTokens ?? 0;
    totals.outputTokens += record.outputTokens ?? 0;
    totals.costUsd += record.costUsd ?? 0;

    const day = localDay(record.ts);
    let dayTally = days.get(day);
    if (!dayTally) {
      dayTally = { ...emptyTally(), cachedInputTokens: 0 };
      days.set(day, dayTally);
    }
    addTo(dayTally, record);
    dayTally.cachedInputTokens += record.cachedInputTokens ?? 0;

    addTo(getOrCreate(providers, record.provider, emptyTally), record);
    addTo(
      getOrCreate(models, `${record.provider}\u0000${record.model ?? ""}`, () => ({
        ...emptyTally(),
        provider: record.provider,
        model: record.model ?? null,
      })),
      record,
    );
    addTo(
      getOrCreate(agents, record.agentId, () => ({ ...emptyTally(), provider: record.provider })),
      record,
    );

    if (record.ttftMs !== undefined) {
      ttfts.push(record.ttftMs);
    }
    if (record.durationMs !== undefined) {
      durations.push(record.durationMs);
    }
    if (isPositiveFinite(record.speedOutputTokens) && isPositiveFinite(record.speedGenerationMs)) {
      speedTokens += record.speedOutputTokens;
      speedMs += record.speedGenerationMs;
    }
  }

  const byTokensDesc = (a: Tally, b: Tally) =>
    b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) || b.costUsd - a.costUsd;

  const perf: UsageSummary["perf"] = {};
  assignDefined(perf, "ttftP50Ms", percentile(ttfts, 0.5));
  assignDefined(perf, "ttftP95Ms", percentile(ttfts, 0.95));
  assignDefined(perf, "durationP50Ms", percentile(durations, 0.5));
  assignDefined(perf, "durationP95Ms", percentile(durations, 0.95));
  assignDefined(perf, "outputTokensPerSec", speedMs > 0 ? Math.round((speedTokens / (speedMs / 1000)) * 10) / 10 : undefined);

  return {
    backfilling: ctx.backfilling,
    totals,
    byDay: [...days.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([day, tally]) => ({ day, ...tally })),
    byProvider: [...providers.entries()]
      .sort(([, a], [, b]) => byTokensDesc(a, b))
      .map(([provider, tally]) => ({
        provider,
        label: ctx.providerLabel(provider) ?? provider,
        ...tally,
      })),
    byModel: [...models.values()].sort(byTokensDesc),
    topAgents: [...agents.entries()]
      .sort(([, a], [, b]) => byTokensDesc(a, b))
      .slice(0, TOP_AGENTS)
      .map(([agentId, tally]) => {
        const title = ctx.agentTitle(agentId);
        return { agentId, title: title ?? null, ...tally, deleted: title === undefined };
      }),
    perf,
  };
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = create();
    map.set(key, value);
  }
  return value;
}

function isPositiveFinite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function assignDefined<K extends keyof UsageSummary["perf"]>(
  target: UsageSummary["perf"],
  key: K,
  value: number | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
