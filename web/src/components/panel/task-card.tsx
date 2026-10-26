import { useAtomValue } from "jotai";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import { formatTokens, relativeTime } from "@/lib/format";
import { pendingPermissionLabel } from "@/lib/permission-label";
import { Dot, Pill } from "@/components/ui/pill";
import { sessionTokens, type PanelSession } from "./panel-session";
import s from "./task-card.module.css";

interface TaskCardProps {
  session: PanelSession;
  onClick: () => void;
}

export function TaskCard({ session, onClick }: TaskCardProps) {
  const { agent, title, provider } = session;
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);
  const runtime = runtimeBySession[agent.id];
  const pendingCount = runtime?.pendingApprovals.length ?? agent.pendingPermissions.length;
  const pendingKind = runtime?.pendingApprovals[0]?.permission?.kind ?? agent.pendingPermissions[0]?.kind;
  const toolCount = runtime?.messages.reduce(
    (count, message) => count + message.parts.filter((part) => part.type === "tool").length,
    0,
  ) ?? 0;
  const tokens = sessionTokens(agent);
  const desc = agent.preview?.trim() || "尚未输出内容…";

  return (
    <button className={s.card} type="button" onClick={onClick}>
      <div className={s.head}>
        <span className={s.title}>{title}</span>
        <Pill tone="ok">
          <Dot tone="live" />
          运行中
        </Pill>
      </div>
      <div className={s.desc}>{desc}</div>
      <div className={s.foot}>
        <span>{provider}</span>
        {agent.model ? <span>{agent.model}</span> : null}
        <span>{relativeTime(agent.createdAt / 1000)}启动</span>
        <span>{toolCount} 次工具调用</span>
        {tokens > 0 ? <span>{formatTokens(tokens)} tokens</span> : null}
        {pendingCount > 0 ? (
          <span className={s.footAttn}>
            {pendingCount} {pendingPermissionLabel(pendingKind)}
          </span>
        ) : null}
      </div>
    </button>
  );
}
