// 手机端派单页（design.md 4.26）：总览列出主会话，详情列出主会话与它派发的子会话，点行进入普通会话页。
import { useCallback, useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import type { AgentSnapshot } from "@agentdeck/protocol";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import { useAgentProviders } from "@/hooks/use-agent-catalog";
import { useDispatchGroups } from "@/hooks/use-dispatch-groups";
import { agentDisplayTitle, agentProviderLabel, formatAgentTime } from "@/lib/agent-session-display";
import {
  DISPATCH_STATUS_LABELS,
  dispatchSummaryText,
  findDispatchGroupThrough,
  type DispatchNode,
  type DispatchStatus,
} from "@/lib/dispatch";
import { dispatcherIdOf, isDispatchedAgent } from "@/lib/session-list";
import { workspaceNameFromPath } from "@/lib/workspaces";
import { agentListLoadedAtom, agentSnapshotsAtom, sidecarConnectionAtom } from "@/stores/agents";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import { ProgressRing, StatusTile } from "./visual";
import s from "./mobile.module.css";

function useTitleOf(): (agent: AgentSnapshot) => string {
  const runtimes = useAtomValue(chatRuntimeBySessionAtom);
  const providers = useAgentProviders().data ?? null;
  return (agent) => agentDisplayTitle(agent, runtimes[agent.id], providers);
}

/** 进入页面（已连接时）刷新一次；返回手动刷新 */
function useRefreshList() {
  const actions = useAgentSession();
  const connection = useAtomValue(sidecarConnectionAtom);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  useEffect(() => {
    if (connection === "open") void refresh();
  }, [connection, refresh]);
  return { refresh, refreshing, error, connection };
}

function StatusText({ status }: { status: DispatchStatus }) {
  return (
    <span className={s.dispatchStatus} data-status={status}>
      {DISPATCH_STATUS_LABELS[status]}
    </span>
  );
}

function NodeRows({
  nodes,
  depth = 0,
  onOpen,
}: {
  nodes: readonly DispatchNode[];
  depth?: number;
  onOpen: (agentId: string) => void;
}) {
  const titleOf = useTitleOf();
  const providers = useAgentProviders().data ?? null;
  const now = new Date();
  return (
    <>
      {nodes.map((node) => (
        <li key={node.agent.id} className={s.rowWrap}>
          <button
            type="button"
            className={s.row}
            style={depth > 0 ? { paddingLeft: 12 + depth * 16 } : undefined}
            onClick={() => onOpen(node.agent.id)}
          >
            <StatusTile kind={node.status} />
            <span className={s.rowBody}>
              <span className={s.rowTitleLine}>
                <span className={s.rowTitle}>{titleOf(node.agent)}</span>
                <span className={s.rowTime}>{formatAgentTime(node.agent.updatedAt, now)}</span>
              </span>
              <span className={s.rowMeta}>
                <StatusText status={node.status} />
                <span>{agentProviderLabel(node.agent.provider, providers)}</span>
                <span>{workspaceNameFromPath(node.agent.cwd)}</span>
              </span>
            </span>
          </button>
          {node.children.length > 0 ? (
            <ul className={s.dispatchNested}>
              <NodeRows nodes={node.children} depth={depth + 1} onOpen={onOpen} />
            </ul>
          ) : null}
        </li>
      ))}
    </>
  );
}

export function DispatchOverview({
  onOpenDetail,
  onOpenSession,
}: {
  onOpenDetail: (agentId: string) => void;
  onOpenSession: (agentId: string) => void;
}) {
  const groups = useDispatchGroups();
  const loaded = useAtomValue(agentListLoadedAtom);
  const titleOf = useTitleOf();
  const { refresh, refreshing, error, connection } = useRefreshList();
  const orphans = groups.find((group) => !group.master);
  // 有工作中或需要处理的排在前面，其余保持最近更新的顺序
  const masters = groups
    .filter((group) => group.master)
    .sort(
      (a, b) =>
        Number(b.summary.working + b.summary.attention > 0) - Number(a.summary.working + a.summary.attention > 0),
    );
  const now = new Date();
  return (
    <div className={s.page}>
      <header className={s.header}>
        <h1 className={s.title}>派单</h1>
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
      {error ? (
        <div className={s.error} role="alert">
          {error}
        </div>
      ) : null}
      <ul className={s.list} aria-label="主会话列表">
        {masters.map(({ master, summary }) => (
          <li key={master!.agent.id} className={s.dispatchCardWrap}>
            <button type="button" className={s.dispatchCard} onClick={() => onOpenDetail(master!.agent.id)}>
              <ProgressRing summary={summary} size={48} label />
              <span className={s.rowBody}>
                <span className={s.rowTitleLine}>
                  <span className={s.rowTitle}>{titleOf(master!.agent)}</span>
                </span>
                <span className={s.dispatchSummary} data-attention={summary.attention > 0 ? "true" : undefined}>
                  {dispatchSummaryText(summary)}
                </span>
                <span className={s.rowMeta}>
                  <span>{workspaceNameFromPath(master!.agent.cwd)}</span>
                  <span>{formatAgentTime(master!.agent.updatedAt, now)}</span>
                </span>
              </span>
              <ChevronRight className={s.rowChevron} aria-hidden="true" />
            </button>
          </li>
        ))}
        {orphans ? (
          <li className={s.project}>
            <div className={s.projectHead} data-static="true">
              <span className={s.projectName}>主会话已删除</span>
            </div>
            <ul className={s.projectRows}>
              <NodeRows nodes={orphans.children} onOpen={onOpenSession} />
            </ul>
          </li>
        ) : null}
        {loaded && groups.length === 0 ? (
          <li className={s.empty}>还没有派单。会话用 delegate 派发任务后，会在这里显示主会话和子会话</li>
        ) : null}
        {!loaded ? <li className={s.empty}>{connection === "open" ? "加载中…" : "等待连接电脑…"}</li> : null}
      </ul>
    </div>
  );
}

export function DispatchDetail({
  agentId,
  onBack,
  onOpenSession,
}: {
  agentId: string;
  onBack: () => void;
  onOpenSession: (agentId: string) => void;
}) {
  const groups = useDispatchGroups({ includeArchived: true });
  const loaded = useAtomValue(agentListLoadedAtom);
  const titleOf = useTitleOf();
  const { error } = useRefreshList();
  const group = groups.find((entry) => entry.master?.agent.id === agentId);
  const master = group?.master;
  return (
    <div className={s.page}>
      <header className={s.header}>
        <button type="button" className={s.iconButton} onClick={onBack} aria-label="返回">
          <ChevronLeft aria-hidden="true" />
        </button>
        <h1 className={s.titleSmall}>{master ? titleOf(master.agent) : "派单详情"}</h1>
      </header>
      {error ? (
        <div className={s.error} role="alert">
          {error}
        </div>
      ) : null}
      {master && group ? (
        <>
          <div className={s.dispatchHero}>
            <ProgressRing summary={group.summary} size={56} label />
            <span className={s.dispatchSummary} data-attention={group.summary.attention > 0 ? "true" : undefined}>
              {dispatchSummaryText(group.summary)}
            </span>
          </div>
          <ul className={s.list} aria-label="派单详情">
            <li className={s.project}>
              <ul className={s.projectRows}>
                <li className={s.rowWrap}>
                  <button type="button" className={s.row} onClick={() => onOpenSession(master.agent.id)}>
                    <StatusTile kind={master.status} />
                    <span className={s.rowBody}>
                      <span className={s.rowTitleLine}>
                        <span className={s.pin}>主会话</span>
                        <span className={s.rowTitle}>{titleOf(master.agent)}</span>
                      </span>
                      <span className={s.rowMeta}>
                        <StatusText status={master.status} />
                        {master.agent.archived ? <span>已归档</span> : null}
                      </span>
                    </span>
                  </button>
                </li>
                <NodeRows nodes={group.children} onOpen={onOpenSession} />
              </ul>
            </li>
          </ul>
        </>
      ) : (
        <div className={s.empty}>{loaded ? "这个会话没有派发子会话，或主会话已被删除" : "加载中…"}</div>
      )}
    </div>
  );
}

/** 会话页顶栏下方：子会话显示「由 X 委派」与派单页入口，主会话显示派单进度；普通会话不显示 */
export function SessionDispatchBar({
  agent,
  onOpenSession,
  onOpenDispatch,
}: {
  agent: AgentSnapshot;
  onOpenSession: (agentId: string) => void;
  onOpenDispatch: (masterId: string | null) => void;
}) {
  const groups = useDispatchGroups({ includeArchived: true });
  const snapshots = useAtomValue(agentSnapshotsAtom);
  const titleOf = useTitleOf();
  if (isDispatchedAgent(agent)) {
    const dispatcherId = dispatcherIdOf(agent);
    const dispatcher = dispatcherId !== undefined ? snapshots[dispatcherId] : undefined;
    const masterId = findDispatchGroupThrough(groups, snapshots, agent.id)?.master?.agent.id ?? null;
    return (
      <div className={s.dispatchBar}>
        {dispatcher ? (
          <>
            <span>由</span>
            <button type="button" className={s.dispatchLink} onClick={() => onOpenSession(dispatcher.id)}>
              {titleOf(dispatcher)}
            </button>
            <span>委派</span>
          </>
        ) : (
          <span>主会话已删除</span>
        )}
        <button type="button" className={s.dispatchLink} onClick={() => onOpenDispatch(masterId)}>
          派单页
        </button>
      </div>
    );
  }
  const group = groups.find((entry) => entry.master?.agent.id === agent.id);
  if (!group) return null;
  return (
    <div className={s.dispatchBar}>
      <ProgressRing summary={group.summary} size={14} />
      <button
        type="button"
        className={s.dispatchLink}
        data-attention={group.summary.attention > 0 ? "true" : undefined}
        onClick={() => onOpenDispatch(agent.id)}
      >
        派单 {group.summary.done}/{group.summary.total}
      </button>
      <span>{dispatchSummaryText(group.summary)}</span>
    </div>
  );
}
