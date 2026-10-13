// 详情页顶部的「由 <父会话> 委派」链接（design.md 4.26）：子会话由其它会话经 agentdeck MCP 的 delegate 创建。
import { useAtomValue } from "jotai";
import { useNavigate } from "react-router-dom";
import { useAgentProviders } from "@/hooks/use-agent-catalog";
import { agentDisplayTitle } from "@/lib/agent-session-display";
import { agentSnapshotsAtom } from "@/stores/agents";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import s from "./delegated-from.module.css";

export function DelegatedFromLink({ parentAgentId }: { parentAgentId: string }) {
  const navigate = useNavigate();
  const snapshots = useAtomValue(agentSnapshotsAtom);
  const runtimes = useAtomValue(chatRuntimeBySessionAtom);
  const { data: providers } = useAgentProviders();
  const parent = snapshots[parentAgentId];
  if (!parent) {
    return <span className={s.missing}>由已删除的会话委派</span>;
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
    </span>
  );
}
