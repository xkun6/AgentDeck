// 会话列表：agent.list（进入时刷新 + 下拉刷新），置顶在前，默认隐藏归档与评判会话；显示标题 / provider / 运行状态 / 待审批标记。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { agentListAtom, agentListLoadedAtom, sidecarConnectionAtom } from "@/stores/agents";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import { useAgentProviders } from "@/hooks/use-agent-catalog";
import {
  AGENT_STATUS_LABELS,
  agentDisplayTitle,
  agentProviderLabel,
  formatAgentTime,
  isAgentRunning,
} from "@/lib/agent-session-display";
import { archivedCount, visibleSessions } from "./session-filter";
import s from "./mobile.module.css";

const PULL_TRIGGER_PX = 72;
const PULL_MAX_PX = 96;

export function SessionList({ onOpen }: { onOpen: (agentId: string) => void }) {
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

  const visible = useMemo(() => visibleSessions(agents, showArchived), [agents, showArchived]);
  const archived = useMemo(() => archivedCount(agents), [agents]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => new Date(), [agents]);

  return (
    <div className={s.page}>
      <header className={s.header}>
        <h1 className={s.title}>会话</h1>
        <button type="button" className={s.textButton} onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? "刷新中…" : "刷新"}
        </button>
      </header>
      {archived > 0 ? (
        <label className={s.toggleRow}>
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          <span>显示已归档（{archived}）</span>
        </label>
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
        {visible.map((agent) => {
          const runtime = runtimeBySession[agent.id];
          const running = isAgentRunning(agent, runtime);
          const needsApproval = agent.pendingPermissions.length > 0 || (runtime?.pendingApprovals.length ?? 0) > 0;
          return (
            <li key={agent.id}>
              <button type="button" className={s.row} onClick={() => onOpen(agent.id)}>
                <span className={s.rowTitleLine}>
                  {agent.pinned ? <span className={s.pin} aria-label="已置顶" title="已置顶">置顶</span> : null}
                  <span className={s.rowTitle}>{agentDisplayTitle(agent, runtime, providers)}</span>
                  {needsApproval ? <span className={s.badgeWarn}>待审批</span> : null}
                </span>
                <span className={s.rowMeta}>
                  <span data-running={running ? "true" : undefined}>{AGENT_STATUS_LABELS[agent.status]}</span>
                  <span>{agentProviderLabel(agent.provider, providers)}</span>
                  {agent.archived ? <span>已归档</span> : null}
                  <span>{formatAgentTime(agent.updatedAt, now)}</span>
                </span>
              </button>
            </li>
          );
        })}
        {loaded && visible.length === 0 ? <li className={s.empty}>还没有会话，到「新建」里开始一个</li> : null}
        {!loaded ? <li className={s.empty}>{connection === "open" ? "加载中…" : "等待连接电脑…"}</li> : null}
      </ul>
    </div>
  );
}
