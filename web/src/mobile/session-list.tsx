// 会话列表：agent.list（进入时刷新 + 下拉刷新），顶部按状态筛选，按项目（工作目录）分组成卡片、可折叠，置顶单列最前，默认隐藏归档与评判会话。
// 每组默认只显示最近几个，进行中与待处理的不受限制。子会话只在派单页（design.md 4.26），主会话行带派单进度入口。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { ChevronRight, RefreshCw } from "lucide-react";
import type { AgentSnapshot, ProviderInfo } from "@agentdeck/protocol";
import { agentListAtom, agentListLoadedAtom, sidecarConnectionAtom } from "@/stores/agents";
import { chatRuntimeBySessionAtom, type ChatSessionRuntime } from "@/stores/chat";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import { useAgentProviders } from "@/hooks/use-agent-catalog";
import { useDispatchGroups } from "@/hooks/use-dispatch-groups";
import { DISPATCH_STATUS_LABELS, dispatchMasterOf, dispatchSummaryText, type DispatchGroup } from "@/lib/dispatch";
import { pendingPermissionLabel } from "@/lib/permission-label";
import { readUiValue, writeUiValue } from "@/lib/ui-store";
import {
  agentStatusLabel,
  agentDisplayTitle,
  agentProviderLabel,
  formatAgentTime,
  isAgentRunning,
} from "@/lib/agent-session-display";
import { archivedCount, visibleSessions } from "./session-filter";
import { groupSessionsByProject, limitProjectRows } from "./session-groups";
import { ProgressRing, StatusTile, type StatusKind } from "./visual";
import s from "./mobile.module.css";

const PULL_TRIGGER_PX = 72;
const PULL_MAX_PX = 96;
const COLLAPSED_STORAGE_KEY = "agentdeck.mobile.collapsedProjects";

type SessionFilter = "all" | "active" | "attention";

interface RowState {
  needsApproval: boolean;
  approvalKind: ReturnType<typeof pendingKind>;
  /** 自身运行中，或自身空闲但子会话还在工作（与桌面侧栏的绿点一致，design.md 4.26） */
  active: boolean;
  statusLabel: string;
  kind: StatusKind;
}

function pendingKind(agent: AgentSnapshot, runtime: ChatSessionRuntime | undefined) {
  return agent.pendingPermissions[0]?.kind ?? runtime?.pendingApprovals[0]?.permission?.kind;
}

function rowStateOf(agent: AgentSnapshot, runtime: ChatSessionRuntime | undefined, group: DispatchGroup | undefined): RowState {
  const needsApproval = agent.pendingPermissions.length > 0 || (runtime?.pendingApprovals.length ?? 0) > 0;
  const running = isAgentRunning(agent, runtime);
  const waiting = !running && (group?.summary.working ?? 0) > 0;
  const kind: StatusKind = needsApproval
    ? "approval"
    : running
      ? "running"
      : waiting
        ? "waiting"
        : agent.status === "error"
          ? "failed"
          : agent.status === "idle"
            ? "idle"
            : "dormant";
  return {
    needsApproval,
    approvalKind: pendingKind(agent, runtime),
    active: running || waiting,
    statusLabel: waiting ? DISPATCH_STATUS_LABELS.waiting : agentStatusLabel(agent),
    kind,
  };
}

function readCollapsedProjects(): Set<string> {
  const stored = readUiValue<unknown>(COLLAPSED_STORAGE_KEY, []);
  return new Set(Array.isArray(stored) ? stored.filter((key): key is string => typeof key === "string") : []);
}

function SessionRow({
  agent,
  state,
  title,
  masterTitle,
  group,
  providers,
  now,
  onOpen,
  onOpenDispatch,
}: {
  agent: AgentSnapshot;
  state: RowState;
  title: string;
  masterTitle?: string;
  group?: DispatchGroup;
  providers: ProviderInfo[] | null;
  now: Date;
  onOpen: (agentId: string) => void;
  onOpenDispatch: (masterId: string) => void;
}) {
  return (
    <li className={s.rowWrap}>
      <button
        type="button"
        className={s.row}
        data-has-dispatch={group ? "true" : undefined}
        onClick={() => onOpen(agent.id)}
      >
        <StatusTile kind={state.kind} />
        <span className={s.rowBody}>
          <span className={s.rowTitleLine}>
            <span className={s.rowTitle}>{title}</span>
            {state.needsApproval ? <span className={s.badgeWarn}>{pendingPermissionLabel(state.approvalKind)}</span> : null}
            <span className={s.rowTime}>{formatAgentTime(agent.updatedAt, now)}</span>
          </span>
          <span className={s.rowMeta}>
            <span data-running={state.active ? "true" : undefined}>{state.statusLabel}</span>
            <span>{agentProviderLabel(agent.provider, providers)}</span>
            {agent.archived ? <span>已归档</span> : null}
            {masterTitle ? <span>主会话 {masterTitle}</span> : null}
          </span>
        </span>
      </button>
      {group ? (
        <button
          type="button"
          className={s.rowDispatch}
          data-attention={group.summary.attention > 0 ? "true" : undefined}
          aria-label={`查看派单进度：${title}`}
          title={dispatchSummaryText(group.summary)}
          onClick={() => onOpenDispatch(agent.id)}
        >
          <span className={s.rowDispatchChip}>
            <ProgressRing summary={group.summary} size={14} />
            派单 {group.summary.done}/{group.summary.total}
          </span>
        </button>
      ) : null}
    </li>
  );
}

export function SessionList({
  onOpen,
  onOpenDispatch = () => {},
}: {
  onOpen: (agentId: string) => void;
  onOpenDispatch?: (masterId: string) => void;
}) {
  const agents = useAtomValue(agentListAtom);
  const loaded = useAtomValue(agentListLoadedAtom);
  const connection = useAtomValue(sidecarConnectionAtom);
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);
  const actions = useAgentSession();
  const providers = useAgentProviders().data ?? null;
  const [showArchived, setShowArchived] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pull, setPull] = useState(0);
  const [pickedFilter, setPickedFilter] = useState<SessionFilter>("all");
  const [collapsed, setCollapsed] = useState(readCollapsedProjects);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const touchStartY = useRef<number | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      await actions.listSessions();
    } catch (e) {
      setError(humanizeSidecarError(e));
    } finally {
      setRefreshing(false);
    }
  }, [actions]);

  // 进入页面（已连接时）刷新一次
  useEffect(() => {
    if (connection === "open") void refresh();
  }, [connection, refresh]);

  const dispatchGroups = useDispatchGroups({ includeArchived: true });
  const groupByMaster = useMemo(
    () => new Map(dispatchGroups.flatMap((group) => (group.master ? [[group.master.agent.id, group] as const] : []))),
    [dispatchGroups],
  );
  const stateOf = (agent: AgentSnapshot) =>
    rowStateOf(agent, runtimeBySession[agent.id], groupByMaster.get(agent.id));

  const visible = useMemo(() => visibleSessions(agents, showArchived), [agents, showArchived]);
  const activeTotal = visible.filter((agent) => stateOf(agent).active).length;
  const attentionTotal = visible.filter((agent) => stateOf(agent).needsApproval).length;
  // 选中的筛选项没有会话了（任务刚结束）就回到全部，不留空列表
  const filter: SessionFilter =
    (pickedFilter === "active" && activeTotal === 0) || (pickedFilter === "attention" && attentionTotal === 0)
      ? "all"
      : pickedFilter;
  const filtered =
    filter === "all"
      ? visible
      : visible.filter((agent) => {
          const state = stateOf(agent);
          return filter === "active" ? state.active : state.needsApproval;
        });
  const { pinned, projects } = groupSessionsByProject(filtered);
  const archived = useMemo(() => archivedCount(agents), [agents]);
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => new Date(), [agents]);

  const toggleCollapsed = (key: string) => {
    const next = new Set(collapsed);
    if (!next.delete(key)) next.add(key);
    setCollapsed(next);
    writeUiValue(COLLAPSED_STORAGE_KEY, [...next]);
  };

  const renderRow = (agent: AgentSnapshot) => {
    const master = dispatchMasterOf(agent, agentById);
    return (
      <SessionRow
        key={agent.id}
        agent={agent}
        state={stateOf(agent)}
        title={agentDisplayTitle(agent, runtimeBySession[agent.id], providers)}
        masterTitle={master ? agentDisplayTitle(master, runtimeBySession[master.id], providers) : undefined}
        group={groupByMaster.get(agent.id)}
        providers={providers}
        now={now}
        onOpen={onOpen}
        onOpenDispatch={onOpenDispatch}
      />
    );
  };

  const filters: Array<{ key: SessionFilter; label: string; count: number }> = [
    { key: "all", label: "全部", count: visible.length },
    ...(activeTotal > 0 ? [{ key: "active" as const, label: "进行中", count: activeTotal }] : []),
    ...(attentionTotal > 0 ? [{ key: "attention" as const, label: "待处理", count: attentionTotal }] : []),
  ];

  return (
    <div className={s.page}>
      <header className={s.header}>
        <h1 className={s.title}>会话</h1>
        <button
          type="button"
          className={s.iconButton}
          aria-label={refreshing ? "刷新中…" : "刷新"}
          data-spinning={refreshing ? "true" : undefined}
          onClick={() => void refresh()}
          disabled={refreshing}
        >
          <RefreshCw aria-hidden="true" />
        </button>
      </header>
      {filters.length > 1 ? (
        <div className={s.filterBar} role="group" aria-label="按状态筛选">
          {filters.map((item) => (
            <button
              key={item.key}
              type="button"
              className={s.filterChip}
              data-kind={item.key}
              data-active={filter === item.key ? "true" : undefined}
              aria-pressed={filter === item.key}
              onClick={() => setPickedFilter(item.key)}
            >
              {item.label}
              <span className={s.filterCount}>{item.count}</span>
            </button>
          ))}
        </div>
      ) : null}
      {error ? (
        <div className={s.error} role="alert">
          {error}
        </div>
      ) : null}
      {pull > 0 ? (
        <div className={s.pullHint}>{pull >= PULL_TRIGGER_PX ? "松开刷新" : "下拉刷新"}</div>
      ) : null}
      <ul
        ref={listRef}
        className={s.list}
        aria-label="会话列表"
        onTouchStart={(e) => {
          touchStartY.current = listRef.current && listRef.current.scrollTop <= 0 ? e.touches[0]!.clientY : null;
        }}
        onTouchMove={(e) => {
          if (touchStartY.current === null) return;
          const dy = e.touches[0]!.clientY - touchStartY.current;
          setPull(dy > 0 ? Math.min(dy, PULL_MAX_PX) : 0);
        }}
        onTouchEnd={() => {
          if (pull >= PULL_TRIGGER_PX) void refresh();
          touchStartY.current = null;
          setPull(0);
        }}
      >
        {pinned.length > 0 ? (
          <li className={s.project}>
            <div className={s.projectHead} data-static="true">
              <span className={s.projectName}>置顶</span>
              <span className={s.projectCount}>{pinned.length}</span>
            </div>
            <ul className={s.projectRows}>{pinned.map(renderRow)}</ul>
          </li>
        ) : null}
        {projects.map((project) => {
          const isCollapsed = collapsed.has(project.key);
          const states = project.agents.map(stateOf);
          const activeCount = states.filter((state) => state.active).length;
          const approvalCount = states.filter((state) => state.needsApproval).length;
          const { shown, hidden } =
            showArchived || filter !== "all" || expanded.has(project.key)
              ? { shown: project.agents, hidden: 0 }
              : limitProjectRows(project.agents, (agent) => {
                  const state = stateOf(agent);
                  return state.active || state.needsApproval;
                });
          return (
            <li key={project.key} className={s.project}>
              <button
                type="button"
                className={s.projectHead}
                aria-expanded={!isCollapsed}
                title={project.path}
                onClick={() => toggleCollapsed(project.key)}
              >
                <span className={s.projectName}>{project.name}</span>
                <span className={s.projectCount}>{project.agents.length}</span>
                {approvalCount > 0 ? <span className={s.badgeWarn}>{approvalCount} 待处理</span> : null}
                {activeCount > 0 ? (
                  <span className={s.projectActive}>
                    <span className={s.dot} data-tone="success" aria-hidden="true" />
                    {activeCount} 进行中
                  </span>
                ) : null}
                <ChevronRight className={s.projectChevron} data-open={!isCollapsed ? "true" : undefined} aria-hidden="true" />
              </button>
              {!isCollapsed ? (
                <ul className={s.projectRows}>
                  {shown.map(renderRow)}
                  {hidden > 0 ? (
                    <li>
                      <button
                        type="button"
                        className={s.projectMore}
                        onClick={() => setExpanded((current) => new Set(current).add(project.key))}
                      >
                        显示其余 {hidden} 个会话
                      </button>
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </li>
          );
        })}
        {loaded && visible.length === 0 ? <li className={s.empty}>还没有会话，点右下角的 + 开始一个</li> : null}
        {!loaded ? <li className={s.empty}>{connection === "open" ? "加载中…" : "等待连接电脑…"}</li> : null}
        {archived > 0 ? (
          <li>
            <label className={s.toggleRow}>
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
              <span>显示已归档（{archived}）</span>
            </label>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
