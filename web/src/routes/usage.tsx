// 「用量统计」页（design.md 4.20）：数据来自 sidecar 的 usage.summary（跨会话账本），图表为纯 CSS。
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useNavigate } from "react-router-dom";
import { LoadingState } from "@agentdeck/shared-ui";
import type { UsageSummary } from "@agentdeck/protocol";
import { TopBar } from "@/components/top-bar/top-bar";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import { formatCostUsd, formatDurationMs, formatTokPerSec, formatTokens } from "@/lib/format";
import {
  USAGE_RANGES,
  dayTotalTokens,
  fillDays,
  modelLabel,
  tokenShares,
  usageSinceMs,
  type UsageRangeId,
} from "@/lib/usage-stats";
import { sidecarConnectionAtom } from "@/stores/agents";
import s from "./usage.module.css";

const BACKFILL_POLL_MS = 3000;

export function UsageRoute() {
  const actions = useAgentSession();
  const connected = useAtomValue(sidecarConnectionAtom) === "open";
  const [range, setRange] = useState<UsageRangeId>("30d");
  const { data, error, isLoading } = useQuery({
    queryKey: ["agentdeck", "usage-summary", range],
    queryFn: () => actions.usageSummary({ sinceMs: usageSinceMs(range, Date.now()) }),
    enabled: connected,
    // 回填期间轮询，完成后不再自动刷新（切换范围或重新进入页面时重新取）
    refetchInterval: (query) => (query.state.data?.backfilling ? BACKFILL_POLL_MS : false),
    staleTime: 0,
    retry: false,
  });

  return (
    <main className={s.page}>
      <TopBar title="用量统计" sub="跨会话 tokens、费用与响应性能" />
      <div className={s.toolbar}>
        <div className={s.seg} role="tablist" aria-label="时间范围">
          {USAGE_RANGES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={range === item.id}
              className={s.segItem}
              data-active={range === item.id ? "true" : undefined}
              onClick={() => setRange(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {data?.backfilling ? (
          <span className={s.backfill} role="status">正在统计历史会话…</span>
        ) : null}
      </div>
      <div className={s.scroll}>
        {!connected ? (
          <div className={s.empty}>Agent 服务未连接</div>
        ) : isLoading ? (
          <LoadingState variant="page" label="正在统计…" />
        ) : error ? (
          <div className={s.empty} role="alert">{humanizeSidecarError(error)}</div>
        ) : data ? (
          <UsageContent summary={data} range={range} />
        ) : null}
      </div>
    </main>
  );
}

function UsageContent({ summary, range }: { summary: UsageSummary; range: UsageRangeId }) {
  const { totals } = summary;
  if (totals.turns === 0) {
    return <div className={s.empty}>{summary.backfilling ? "历史会话统计中，请稍候…" : "所选时间范围内暂无用量记录"}</div>;
  }
  return (
    <div className={s.content}>
      <section className={s.cards} aria-label="总量">
        <Card label="回合数" value={String(totals.turns)} sub={totals.failedTurns > 0 ? `失败 ${totals.failedTurns}` : undefined} />
        <Card label="输入 tokens" value={formatTokens(totals.inputTokens)} />
        <Card label="缓存 tokens" value={formatTokens(totals.cachedInputTokens)} />
        <Card label="输出 tokens" value={formatTokens(totals.outputTokens)} />
        <Card label="费用" value={formatCostUsd(totals.costUsd)} />
      </section>

      <DayChart summary={summary} range={range} />

      <div className={s.twoCols}>
        <ShareList
          title="按 Agent"
          items={tokenShares(summary.byProvider).map((item) => ({
            key: item.provider,
            label: item.label,
            tokens: item.tokens,
            percent: item.percent,
            turns: item.turns,
            costUsd: item.costUsd,
          }))}
        />
        <ShareList
          title="按模型"
          items={tokenShares(summary.byModel).map((item) => ({
            key: `${item.provider}/${item.model ?? ""}`,
            label: `${modelLabel(item.model)} · ${item.provider}`,
            tokens: item.tokens,
            percent: item.percent,
            turns: item.turns,
            costUsd: item.costUsd,
          }))}
        />
      </div>

      <TopAgents summary={summary} />
      <Perf summary={summary} />
    </div>
  );
}

function Card({ label, value, sub }: { label: string; value: string; sub?: string | undefined }) {
  return (
    <div className={s.card}>
      <span className={s.cardLabel}>{label}</span>
      <span className={s.cardValue}>{value}</span>
      {sub ? <span className={s.cardSub}>{sub}</span> : null}
    </div>
  );
}

function DayChart({ summary, range }: { summary: UsageSummary; range: UsageRangeId }) {
  const days = useMemo(() => {
    const now = Date.now();
    return fillDays(summary.byDay, usageSinceMs(range, now), now);
  }, [summary.byDay, range]);
  const max = Math.max(1, ...days.map(dayTotalTokens));
  const pct = (value: number) => `${(value / max) * 100}%`;
  return (
    <section className={s.panel} aria-label="每日用量">
      <header className={s.panelHead}>
        <h2 className={s.panelTitle}>每日 tokens</h2>
        <span className={s.legend}>
          <span className={s.legendItem} data-kind="input">输入</span>
          <span className={s.legendItem} data-kind="cached">缓存</span>
          <span className={s.legendItem} data-kind="output">输出</span>
        </span>
      </header>
      <div className={s.chart} role="img" aria-label={`最近 ${days.length} 天每日 tokens 柱状图`}>
        {days.map((day) => (
          <div
            key={day.day}
            className={s.bar}
            title={`${day.day}\n输入 ${formatTokens(day.inputTokens)} · 缓存 ${formatTokens(day.cachedInputTokens)} · 输出 ${formatTokens(day.outputTokens)}\n${day.turns} 个回合`}
          >
            <div className={s.stack} style={{ height: pct(dayTotalTokens(day)) }}>
              <span className={s.stackOutput} style={{ flexGrow: day.outputTokens }} />
              <span className={s.stackCached} style={{ flexGrow: day.cachedInputTokens }} />
              <span className={s.stackInput} style={{ flexGrow: day.inputTokens }} />
            </div>
          </div>
        ))}
      </div>
      <div className={s.axis}>
        <span>{days[0]?.day}</span>
        <span>{days[days.length - 1]?.day}</span>
      </div>
    </section>
  );
}

interface ShareItem {
  key: string;
  label: string;
  tokens: number;
  percent: number;
  turns: number;
  costUsd: number;
}

function ShareList({ title, items }: { title: string; items: ShareItem[] }) {
  return (
    <section className={s.panel} aria-label={title}>
      <h2 className={s.panelTitle}>{title}</h2>
      <ul className={s.shareList}>
        {items.map((item) => (
          <li key={item.key} className={s.shareRow} title={`${item.turns} 个回合 · ${formatCostUsd(item.costUsd)}`}>
            <span className={s.shareLabel}>{item.label}</span>
            <span className={s.shareTrack}>
              <span className={s.shareFill} style={{ width: `${item.percent}%` }} />
            </span>
            <span className={s.shareValue}>{formatTokens(item.tokens)} · {item.percent}%</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TopAgents({ summary }: { summary: UsageSummary }) {
  const navigate = useNavigate();
  return (
    <section className={s.panel} aria-label="高用量会话">
      <h2 className={s.panelTitle}>高用量会话 Top {summary.topAgents.length}</h2>
      <ul className={s.topList}>
        {summary.topAgents.map((agent) => {
          const title = agent.title ?? (agent.deleted ? "（已删除的会话）" : "未命名会话");
          const content = (
            <>
              <span className={s.topTitle}>{title}</span>
              <span className={s.topMeta}>{agent.provider}</span>
              <span className={s.topMeta}>{agent.turns} 回合</span>
              <span className={s.topMeta}>输入 {formatTokens(agent.inputTokens)}</span>
              <span className={s.topMeta}>输出 {formatTokens(agent.outputTokens)}</span>
              <span className={s.topMeta}>{formatCostUsd(agent.costUsd)}</span>
            </>
          );
          return (
            <li key={agent.agentId}>
              {agent.deleted ? (
                <div className={s.topRow} data-deleted="true">{content}</div>
              ) : (
                <button
                  type="button"
                  className={s.topRow}
                  onClick={() => navigate(`/tasks/${encodeURIComponent(agent.agentId)}`)}
                >
                  {content}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Perf({ summary }: { summary: UsageSummary }) {
  const { perf } = summary;
  return (
    <section className={s.panel} aria-label="性能指标">
      <h2 className={s.panelTitle}>性能指标</h2>
      <div className={s.perfGrid}>
        <Card label="首字延迟 P50" value={formatDurationMs(perf.ttftP50Ms)} />
        <Card label="首字延迟 P95" value={formatDurationMs(perf.ttftP95Ms)} />
        <Card label="回合耗时 P50" value={formatDurationMs(perf.durationP50Ms)} />
        <Card label="回合耗时 P95" value={formatDurationMs(perf.durationP95Ms)} />
        <Card label="输出速度 P50" value={perf.outputTokensPerSecP50 === undefined ? "—" : `${formatTokPerSec(perf.outputTokensPerSecP50)} tok/s`} />
      </div>
    </section>
  );
}
