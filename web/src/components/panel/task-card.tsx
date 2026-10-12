import { useAtomValue } from "jotai";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import { formatTokens, relativeTime } from "@/lib/format";
import { Dot, Pill } from "@/components/ui/pill";
import { sessionTokens, shortId, type PanelSession } from "./panel-session";
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
  const toolCount = runtime?.messages.reduce(
    (count, message) => count + message.parts.filter((part) => part.type === "tool").length,
    0,
  ) ?? 0;
  const tokens = sessionTokens(agent);
  const desc = agent.preview?.trim() || "尚未输出内容…";

  return (
    <button className={s.card} type="button" onClick={onClick}>
      <div className={s.head}>
        <span className={s.headId}>{shortId(agent.id)}</span>
        <span className={s.headSep}>·</span>
        <span>{provider}</span>
        {agent.model ? (
          <>
            <span className={s.headSep}>·</span>
            <span>{agent.model}</span>
          </>
        ) : null}
        <span className={s.headSep}>·</span>
        <span>{relativeTime(agent.createdAt / 1000)} 启动</span>
        <span className={s.headSpacer} />
        <Pill tone="ok">
          <Dot tone="live" />
          运行中
        </Pill>
      </div>

      <div className={s.title}>{title}</div>
      <div className={s.desc}>{desc}</div>

      <div className={s.foot}>
        <span>
          {toolCount} 工具
          {pendingCount > 0 && (
            <>
              {" · "}
              <span className={s.footAttn}>{pendingCount} 待审批</span>
            </>
          )}
        </span>
        {tokens > 0 && (
          <>
            <span className={s.footSep}>|</span>
            <span>{formatTokens(tokens)} tokens</span>
          </>
        )}
        <span className={s.footEnter}>→ 进入工作台</span>
      </div>
    </button>
  );
}
