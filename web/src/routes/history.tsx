import { useEffect, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { useSearchParams } from "react-router-dom";
import { LoadingState, StatusDot } from "@agentdeck/shared-ui";
import { Pin, Search, Trash2, X } from "lucide-react";
import type { AgentSearchHit, AgentSnapshot } from "@agentdeck/protocol";
import { useAgentSession } from "@/hooks/use-agent-session";
import { useContentSearch } from "@/hooks/use-content-search";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import { agentListAtom, agentListLoadedAtom, sidecarConnectionAtom } from "@/stores/agents";
import { useAgentProviders } from "@/hooks/use-agent-catalog";
import { useDeleteAgentSession } from "@/hooks/use-delete-agent-session";
import {
  AGENT_STATUS_LABELS,
  agentDisplayTitle,
  agentProviderLabel,
  isAgentRunning,
} from "@/lib/agent-session-display";
import { useConfirm } from "@/lib/use-confirm";
import {
  batchSummary,
  inHistoryView,
  runBatch,
  splitPinned,
  type HistoryView,
} from "@/lib/session-list";
import { splitSnippet } from "@/lib/usage-stats";
import { dayKey, dayLabel, isToday, relativeTime, timeOfDay } from "@/lib/format";
import {
  agentInWorkspace,
  normalizeWorkspacePath,
  readSessionWorkspaceMap,
  subscribeWorkspaceChanges,
  workspaceNameFromPath,
} from "@/lib/workspaces";
import { TopBar } from "@/components/top-bar/top-bar";
import { useSessionActions } from "@/hooks/use-context-actions";
import { EntityContextMenu } from "@/components/context-menu/entity-context-menu";
import s from "./history.module.css";

type StatusFilter = "all" | "running" | "idle" | "dormant" | "error" | "closed";

const STATUS_LABELS: Record<StatusFilter, string> = {
  all: "全部",
  running: "运行中",
  idle: "空闲",
  dormant: AGENT_STATUS_LABELS.dormant,
  error: "出错",
  closed: "已关闭",
};

const SEARCH_ROLE_LABELS: Record<AgentSearchHit["role"], string> = {
  user: "用户",
  assistant: "助手",
  reasoning: "思考",
  tool: "工具",
};

const VIEW_LABELS: Record<HistoryView, string> = {
  all: "全部会话",
  archived: "已归档",
};

function shortId(id: string): string {
  return id.slice(-6);
}

function statusKind(agent: AgentSnapshot, running: boolean): Exclude<StatusFilter, "all"> {
  if (running) return "running";
  if (agent.status === "error") return "error";
  if (agent.status === "closed") return "closed";
  if (agent.status === "dormant") return "dormant";
  return "idle";
}

interface Row {
  agent: AgentSnapshot;
  title: string;
  provider: string;
  kind: Exclude<StatusFilter, "all">;
}

export function HistoryRoute() {
  const agents = useAtomValue(agentListAtom);
  const loaded = useAtomValue(agentListLoadedAtom);
  const connection = useAtomValue(sidecarConnectionAtom);
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);
  const { data: providers } = useAgentProviders();
  const deleteSession = useDeleteAgentSession();
  const sessionActions = useSessionActions();
  const sessionApi = useAgentSession();
  const { confirm } = useConfirm();
  const [view, setView] = useState<HistoryView>("all");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchFeedback, setBatchFeedback] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  // 从项目详情跳转时带 ?workspace=，只看该项目的会话
  const [searchParams, setSearchParams] = useSearchParams();
  const workspacePath = normalizeWorkspacePath(searchParams.get("workspace"));
  const [sessionWorkspaceMap, setSessionWorkspaceMap] = useState(readSessionWorkspaceMap);

  useEffect(() => {
    return subscribeWorkspaceChanges(() => {
      setSessionWorkspaceMap(readSessionWorkspaceMap());
    });
  }, []);

  const clearWorkspaceFilter = () => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("workspace");
        return next;
      },
      { replace: true },
    );
  };

  const rows = useMemo<Row[]>(
    () =>
      agents
        .filter(
          (agent) => !workspacePath || agentInWorkspace(agent, workspacePath, sessionWorkspaceMap),
        )
        .map((agent) => ({
          agent,
          title: agentDisplayTitle(agent, runtimeBySession[agent.id], providers),
          provider: agentProviderLabel(agent.provider, providers),
          kind: statusKind(agent, isAgentRunning(agent, runtimeBySession[agent.id])),
        })),
    [agents, providers, runtimeBySession, sessionWorkspaceMap, workspacePath],
  );

  const viewRows = useMemo(() => rows.filter((row) => inHistoryView(row.agent, view)), [rows, view]);
  const archivedCount = useMemo(
    () => rows.filter((row) => inHistoryView(row.agent, "archived")).length,
    [rows],
  );

  const statusCounts = useMemo(() => {
    const counts: Record<StatusFilter, number> = { all: viewRows.length, running: 0, idle: 0, dormant: 0, error: 0, closed: 0 };
    for (const row of viewRows) counts[row.kind] += 1;
    return counts;
  }, [viewRows]);

  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return viewRows.filter((row) => {
      if (statusFilter !== "all" && row.kind !== statusFilter) return false;
      if (!query) return true;
      return [row.title, row.agent.id, row.provider, row.agent.cwd, row.agent.model ?? ""]
        .some((value) => value.toLowerCase().includes(query));
    });
  }, [viewRows, searchQuery, statusFilter]);

  // 「全部会话」视图里置顶的会话单列「置顶」分组放最前，其余按日期分组
  const dayGroups = useMemo(() => {
    const groups: { key: string; label: string; rows: Row[]; pinned?: boolean }[] = [];
    const { pinned, rest } = splitPinned(filtered, view);
    if (pinned.length > 0) groups.push({ key: "pinned", label: "置顶", rows: pinned, pinned: true });
    for (const row of rest) {
      const sec = Math.floor(row.agent.updatedAt / 1000);
      const key = dayKey(sec);
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.rows.push(row);
      else groups.push({ key, label: dayLabel(sec), rows: [row] });
    }
    return groups;
  }, [filtered, view]);

  const goSession = sessionActions.openSession;

  // 内容匹配（design.md 4.19）：搜索框非空时 300ms 防抖调用 agent.search，结果按会话行信息展示
  const contentSearch = useContentSearch(searchQuery);
  const rowById = useMemo(() => new Map(rows.map((row) => [row.agent.id, row])), [rows]);
  const contentHits = useMemo(
    () => contentSearch.hits.filter((hit) => rowById.has(hit.agentId)),
    [contentSearch.hits, rowById],
  );

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelected(new Set());
    setBatchFeedback(null);
  };
  const changeView = (next: HistoryView) => {
    setView(next);
    setSelected(new Set());
    setBatchFeedback(null);
  };
  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allFilteredSelected = filtered.length > 0 && filtered.every((row) => selected.has(row.agent.id));
  const toggleSelectAll = () =>
    setSelected(allFilteredSelected ? new Set() : new Set(filtered.map((row) => row.agent.id)));

  /** 逐个调用 RPC，结束后汇总提示；失败的保持选中便于重试。 */
  const runBatchAction = async (label: string, op: (id: string) => Promise<unknown>) => {
    setBatchBusy(true);
    try {
      const result = await runBatch(Array.from(selected), op);
      setBatchFeedback(batchSummary(label, result));
      setSelected(new Set(result.failed));
    } finally {
      setBatchBusy(false);
    }
  };
  const batchUpdate = (label: string, patch: { pinned?: boolean; archived?: boolean }) =>
    runBatchAction(label, async (id) => {
      const row = rows.find((item) => item.agent.id === id);
      if (patch.archived === true && row?.kind === "running") {
        throw new Error("运行中的会话不能归档");
      }
      await sessionApi.updateSession(id, patch);
    });
  const batchDelete = async () => {
    const count = selected.size;
    const confirmed = await confirm({
      title: "删除会话",
      body: `确定删除选中的 ${count} 个会话？会话记录会从本机删除，无法恢复。运行中的会话会先被停止。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!confirmed) return;
    await runBatchAction("删除", (id) => sessionApi.deleteSession(id));
  };

  const loading = !loaded && connection !== "error" && connection !== "closed";

  return (
    <main className={s.page}>
      <TopBar
        title="对话历史"
        sub={loading ? "加载中…" : `${filtered.length} / ${viewRows.length} 个会话`}
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

          <div className={s.seg} role="tablist" aria-label="会话视图">
            {(Object.keys(VIEW_LABELS) as HistoryView[]).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={view === key}
                className={s.segItem}
                data-active={view === key ? "true" : undefined}
                onClick={() => changeView(key)}
              >
                {VIEW_LABELS[key]}
                {key === "archived" ? <span className={s.segCount}>{archivedCount}</span> : null}
              </button>
            ))}
          </div>

          {workspacePath ? (
            <span className={s.workspaceTag} title={workspacePath}>
              <span className={s.workspaceTagText}>
                项目：{workspaceNameFromPath(workspacePath)}
              </span>
              <button
                type="button"
                className={s.workspaceTagClear}
                aria-label="清除项目筛选"
                title="清除项目筛选"
                onClick={clearWorkspaceFilter}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          ) : null}

          <button
            type="button"
            className={s.selectToggle}
            data-active={selectMode ? "true" : undefined}
            aria-pressed={selectMode}
            onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
          >
            {selectMode ? "退出选择" : "选择"}
          </button>

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
        {contentSearch.query ? (
          <section className={s.dayGroup} aria-label="内容匹配">
            <div className={s.dayHead}>
              <span className={s.dayLabel}>内容匹配</span>
              <span className={s.dayCount}>
                {contentSearch.loading
                  ? "搜索中…"
                  : contentSearch.error
                    ? "搜索失败"
                    : `${contentHits.length} 条${contentSearch.truncated ? "（已截断）" : ""}`}
              </span>
            </div>
            {contentSearch.error ? (
              <div className={s.contentHint} role="alert">{contentSearch.error}</div>
            ) : !contentSearch.loading && contentHits.length === 0 ? (
              <div className={s.contentHint}>没有匹配的会话内容</div>
            ) : (
              contentHits.map((hit) => {
                const row = rowById.get(hit.agentId)!;
                const parts = splitSnippet(hit.snippet, hit.matchStart, hit.matchLength);
                const sec = Math.floor(hit.timestamp / 1000);
                return (
                  <button
                    key={`${hit.agentId}-${hit.seq}-${hit.role}`}
                    type="button"
                    className={s.hitRow}
                    onClick={() => goSession(row.agent, { seq: hit.seq })}
                  >
                    <span className={s.hitHead}>
                      <span className={s.hitTitle}>{row.title}</span>
                      <span className={s.sourceChip}>{SEARCH_ROLE_LABELS[hit.role]}</span>
                      <span className={s.cellTimestamp}>{isToday(sec) ? timeOfDay(sec) : relativeTime(sec)}</span>
                    </span>
                    <span className={s.hitSnippet}>
                      {parts.before}
                      <mark className={s.hitMark}>{parts.match}</mark>
                      {parts.after}
                    </span>
                  </button>
                );
              })
            )}
          </section>
        ) : null}
        {loading ? (
          <LoadingState variant="page" label="正在加载会话…" />
        ) : dayGroups.length === 0 ? (
          <div className={s.emptyState}>
            {viewRows.length === 0
              ? view === "archived" ? "暂无已归档的会话" : "暂无会话"
              : "没有匹配当前筛选的会话"}
          </div>
        ) : (
          dayGroups.map((group, groupIdx) => (
            <section key={group.key} className={s.dayGroup}>
              <div className={s.dayHead}>
                <span className={s.dayLabel}>
                  {group.pinned ? <Pin size={12} className={s.titlePin} aria-hidden="true" /> : null}
                  {group.label}
                </span>
                <span className={s.dayCount}>{group.rows.length} 个会话</span>
              </div>

              {groupIdx === 0 ? (
                <div className={s.colHead} data-bulk={selectMode ? "true" : undefined} aria-hidden="true">
                  {selectMode ? <span /> : null}
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
                const isSelected = selected.has(agent.id);
                return (
                  <EntityContextMenu key={agent.id} items={() => sessionActions.buildMenu(agent, title)}>
                  <div
                    className={s.convRow}
                    data-status={kind === "error" ? "failed" : kind}
                    data-bulk={selectMode ? "true" : undefined}
                    data-selected={isSelected ? "true" : undefined}
                    role="button"
                    tabIndex={0}
                    title={`${title}\n${AGENT_STATUS_LABELS[agent.status]}`}
                    onClick={() => (selectMode ? toggleSelected(agent.id) : goSession(agent))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        if (selectMode) toggleSelected(agent.id);
                        else goSession(agent);
                      }
                    }}
                  >
                    {selectMode ? (
                      <span className={s.cellSelect}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          aria-label={`选择会话：${title}`}
                          onChange={() => toggleSelected(agent.id)}
                          onClick={(event) => event.stopPropagation()}
                        />
                      </span>
                    ) : null}
                    <span className={s.cellId}>{shortId(agent.id)}</span>
                    <span className={s.cellTitle}>
                      {agent.pinned && !group.pinned ? (
                        <Pin size={12} className={s.titlePin} aria-hidden="true" />
                      ) : null}
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
                    <button
                      type="button"
                      className={s.cellMore}
                      aria-label={`删除会话：${title}`}
                      title="删除会话"
                      disabled={selectMode}
                      onClick={(event) => {
                        event.stopPropagation();
                        void deleteSession(agent, title);
                      }}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      <Trash2 size={12} aria-hidden="true" />
                    </button>
                  </div>
                  </EntityContextMenu>
                );
              })}
            </section>
          ))
        )}
      </div>

      {selectMode ? (
        <div className={s.bulkBar} data-active={selected.size > 0 ? "true" : undefined} role="toolbar" aria-label="批量操作">
          <button type="button" disabled={batchBusy || filtered.length === 0} onClick={toggleSelectAll}>
            {allFilteredSelected ? "取消全选" : "全选当前筛选结果"}
          </button>
          <span>已选 {selected.size} 个</span>
          {batchFeedback ? <span className={s.bulkFeedback} role="status">{batchFeedback}</span> : null}
          <span className={s.bulkSpacer} />
          <button type="button" disabled={batchBusy || selected.size === 0} onClick={() => void batchUpdate("置顶", { pinned: true })}>
            置顶
          </button>
          <button type="button" disabled={batchBusy || selected.size === 0} onClick={() => void batchUpdate("取消置顶", { pinned: false })}>
            取消置顶
          </button>
          {view === "archived" ? (
            <button type="button" disabled={batchBusy || selected.size === 0} onClick={() => void batchUpdate("取消归档", { archived: false })}>
              取消归档
            </button>
          ) : (
            <button type="button" disabled={batchBusy || selected.size === 0} onClick={() => void batchUpdate("归档", { archived: true })}>
              归档
            </button>
          )}
          <button
            type="button"
            className={s.bulkDelete}
            disabled={batchBusy || selected.size === 0}
            onClick={() => void batchDelete()}
          >
            删除
          </button>
        </div>
      ) : null}

      <div className={s.foot}>
        <span>共 {filtered.length} 个会话</span>
      </div>
    </main>
  );
}
