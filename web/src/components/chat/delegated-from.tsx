// 详情页顶部的派单入口（design.md 4.26）：子会话显示「由 <主会话> 委派」，主会话显示派单进度，都可进入派单页。
import { useAtomValue } from "jotai";
import { useNavigate } from "react-router-dom";
import { useAgentProviders } from "@/hooks/use-agent-catalog";
import { agentDisplayTitle } from "@/lib/agent-session-display";
import { findDispatchGroupThrough } from "@/lib/dispatch";
import { useDispatchGroups } from "@/hooks/use-dispatch-groups";
import { agentSnapshotsAtom } from "@/stores/agents";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import s from "./delegated-from.module.css";

/** 主会话的对话页：「派单 2/5」，进入它的派单详情；没有子会话时不显示 */
export function DispatchProgressLink({ agentId }: { agentId: string }) {
  const navigate = useNavigate();
  const group = useDispatchGroups({ includeArchived: true }).find((entry) => entry.master?.agent.id === agentId);
  if (!group) return null;
  const { done, total, attention } = group.summary;
  return (
    <button
      type="button"
      className={s.link}
      data-attention={attention > 0 ? "true" : undefined}
      title="查看这个会话派发的子会话"
      onClick={() => navigate(`/dispatch/${encodeURIComponent(agentId)}`)}
    >
      派单 {done}/{total}
    </button>
  );
}

/** 没有记录上级的旧子会话（origin 为 delegate）：只能进总览 */
export function DispatchOverviewLink() {
  const navigate = useNavigate();
  return (
    <button type="button" className={s.link} title="查看派单总览" onClick={() => navigate("/dispatch")}>
      派单页
    </button>
  );
}

export function DelegatedFromLink({ parentAgentId }: { parentAgentId: string }) {
  const navigate = useNavigate();
  const snapshots = useAtomValue(agentSnapshotsAtom);
  const runtimes = useAtomValue(chatRuntimeBySessionAtom);
  const { data: providers } = useAgentProviders();
  const groups = useDispatchGroups({ includeArchived: true });
  const parent = snapshots[parentAgentId];
  // 多层派单时上一级不是主会话：进所属主会话的详情，找不到主会话时进总览
  const masterId = findDispatchGroupThrough(groups, snapshots, parentAgentId)?.master?.agent.id;
  const goDispatch = () => navigate(masterId ? `/dispatch/${encodeURIComponent(masterId)}` : "/dispatch");
  if (!parent) {
    return (
      <span className={s.wrap}>
        <span className={s.missing}>由已删除的会话委派</span>
        <button type="button" className={s.link} title="查看派单总览" onClick={goDispatch}>
          派单页
        </button>
      </span>
    );
  }
  const title = agentDisplayTitle(parent, runtimes[parentAgentId], providers);
  return (
    <span className={s.wrap}>
      由
      <button
        type="button"
        className={s.link}
        title={`打开父会话：${title}`}
        onClick={() => navigate(`/tasks/${encodeURIComponent(parentAgentId)}`)}
      >
        {title}
      </button>
      委派
      <button
        type="button"
        className={s.link}
        title="查看主会话派发的全部子会话"
        onClick={goDispatch}
      >
        派单页
      </button>
    </span>
  );
}
