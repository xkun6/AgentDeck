import { useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useNavigate } from "react-router-dom";
import { LoadingState, StatusDot } from "@agentdeck/shared-ui";
import { Search } from "lucide-react";
import type { AgentSnapshot } from "@agentdeck/protocol";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import { agentListAtom, agentListLoadedAtom, sidecarConnectionAtom } from "@/stores/agents";
import { activeSessionIdAtom } from "@/stores/ui";
import { useAgentProviders } from "@/hooks/use-agent-catalog";
import {
  AGENT_STATUS_LABELS,
  agentDisplayTitle,
  agentProviderLabel,
  isAgentRunning,
} from "@/lib/agent-session-display";
import { dayKey, dayLabel, isToday, relativeTime, timeOfDay } from "@/lib/format";
import { workspaceNameFromPath } from "@/lib/workspaces";
import { TopBar } from "@/components/top-bar/top-bar";
import s from "./history.module.css";

type StatusFilter = "all" | "running" | "idle" | "error" | "closed";

const STATUS_LABELS: Record<StatusFilter, string> = {
  all: "全部",
  running: "运行中",
  idle: "空闲",
  error: "出错",
  closed: "已关闭",
};

function shortId(id: string): string {
  return id.slice(-6);
}

function statusKind(agent: AgentSnapshot, running: boolean): Exclude<StatusFilter, "all"> {
  if (running) return "running";
  if (agent.status === "error") return "error";
  if (agent.status === "closed") return "closed";
  return "idle";
}

interface Row {
  agent: AgentSnapshot;
  title: string;
  provider: string;
  kind: Exclude<StatusFilter, "all">;
}

export function HistoryRoute() {
  const navigate = useNavigate();
  const setActiveId = useSetAtom(activeSessionIdAtom);
  const agents = useAtomValue(agentListAtom);
  const loaded = useAtomValue(agentListLoadedAtom);
  const connection = useAtomValue(sidecarConnectionAtom);
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);
  const { data: providers } = useAgentProviders();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");

  const rows = useMemo<Row[]>(
    () =>
      agents.map((agent) => ({
        agent,
        title: agentDisplayTitle(agent, runtimeBySession[agent.id], providers),
        provider: agentProviderLabel(agent.provider, providers),
        kind: statusKind(agent, isAgentRunning(agent, runtimeBySession[agent.id])),
      })),
    [agents, providers, runtimeBySession],
  );

  const statusCounts = useMemo(() => {
    const counts: Record<StatusFilter, number> = { all: rows.length, running: 0, idle: 0, error: 0, closed: 0 };
    for (const row of rows) counts[row.kind] += 1;
    return counts;
  }, [rows]);

  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return rows.filter((row) => {
      if (statusFilter !== "all" && row.kind !== statusFilter) return false;
      if (!query) return true;
      return [row.title, row.agent.id, row.provider, row.agent.cwd, row.agent.model ?? ""]
        .some((value) => value.toLowerCase().includes(query));
    });
  }, [rows, searchQuery, statusFilter]);

  const dayGroups = useMemo(() => {
    const groups: { key: string; label: string; rows: Row[] }[] = [];
    for (const row of filtered) {
      const sec = Math.floor(row.agent.updatedAt / 1000);
      const key = dayKey(sec);
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.rows.push(row);
      else groups.push({ key, label: dayLabel(sec), rows: [row] });
    }
    return groups;
  }, [filtered]);

  const goSession = (agent: AgentSnapshot) => {
    setActiveId(agent.id);
    navigate(`/tasks/${encodeURIComponent(agent.id)}`);
  };

  const loading = !loaded && connection !== "error" && connection !== "closed";

  return (
    <main className={s.page}>
      <TopBar
        title="对话历史"
        sub={loading ? "加载中…" : `${filtered.length} / ${rows.length} 个会话`}
      />

      <div className={s.filters}>
        <div className={s.filtersRow}>
          <div className={s.seg} role="tablist" aria-label="状态筛选">
            {(Object.keys(STATUS_LABELS) as StatusFilter[]).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={statusFilter === key}
                className={s.segItem}
                data-active={statusFilter === key ? "true" : undefined}
                onClick={() => setStatusFilter(key)}
              >
                {STATUS_LABELS[key]}
                <span className={s.segCount}>{statusCounts[key]}</span>
              </button>
            ))}
          </div>

          <div className={s.searchBox}>
            <Search size={12} />
            <input
              type="search"
              placeholder="搜索标题、Agent、工作区与会话 ID…"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </div>
        </div>
      </div>

      <div className={s.scroll}>
        {loading ? (
          <LoadingState variant="page" label="正在加载会话…" />
        ) : dayGroups.length === 0 ? (
          <div className={s.emptyState}>
            {rows.length === 0 ? "暂无会话" : "没有匹配当前筛选的会话"}
          </div>
        ) : (
          dayGroups.map((group, groupIdx) => (
            <section key={group.key} className={s.dayGroup}>
              <div className={s.dayHead}>
                <span className={s.dayLabel}>{group.label}</span>
                <span className={s.dayCount}>{group.rows.length} 个会话</span>
              </div>

              {groupIdx === 0 ? (
                <div className={s.colHead} aria-hidden="true">
                  <span>ID</span>
                  <span>标题</span>
                  <span>Agent</span>
                  <span>模型</span>
                  <span>工作区</span>
                  <span>更新</span>
                  <span />
                </div>
              ) : null}

              {group.rows.map(({ agent, title, provider, kind }) => {
                const sec = Math.floor(agent.updatedAt / 1000);
                const updated = isToday(sec) ? timeOfDay(sec) : relativeTime(sec);
                return (
                  <div
                    key={agent.id}
                    className={s.convRow}
                    data-status={kind === "error" ? "failed" : kind}
                    role="button"
                    tabIndex={0}
                    title={`${title}\n${AGENT_STATUS_LABELS[agent.status]}`}
                    onClick={() => goSession(agent)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        goSession(agent);
                      }
                    }}
                  >
                    <span className={s.cellId}>{shortId(agent.id)}</span>
                    <span className={s.cellTitle}>
                      {kind === "running" ? (
                        <StatusDot tone="success" aria-hidden />
                      ) : kind === "error" ? (
                        <StatusDot tone="danger" aria-hidden />
                      ) : null}
                      <span className={s.titleText}>{title}</span>
                    </span>
                    <span className={s.sourceChip}>{provider}</span>
                    <span className={s.cellMono}>{agent.model || "默认"}</span>
                    <span className={s.cellMono} title={agent.cwd}>
                      {workspaceNameFromPath(agent.cwd) || "—"}
                    </span>
                    <span className={s.cellTimestamp}>{updated}</span>
                    <span />
                  </div>
                );
              })}
            </section>
          ))
        )}
      </div>

      <div className={s.foot}>
        <span>共 {filtered.length} 个会话</span>
      </div>
    </main>
  );
}
