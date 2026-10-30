// 委派卡片（design.md 4.26）：时间线里 agentdeck MCP 互通工具（delegate / send_to_agent / …）的工具卡片，
// 显示目标会话标题、实时状态，并可跳转到该会话。
import { createContext, useContext, useState } from "react";
import { useAtomValue } from "jotai";
import { useInRouterContext, useNavigate } from "react-router-dom";
import { ExternalLink, GitBranch } from "lucide-react";
import { useAgentProviders } from "@/hooks/use-agent-catalog";
import { agentDisplayTitle, agentProviderLabel, agentStatusLabel } from "@/lib/agent-session-display";
import { INTEROP_TOOL_LABELS } from "@/lib/interop-tools";
import { agentSnapshotsAtom } from "@/stores/agents";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import type { ChatToolItem } from "./chat-types";
import s from "./delegate-card.module.css";

/** 工具结果里的 status（子会话回合结局）→ 中文 */
const RESULT_STATUS_LABELS: Record<string, string> = {
  completed: "已完成",
  failed: "失败",
  canceled: "已中断",
  running: "运行中",
};

type Tone = "running" | "ok" | "error" | "idle";

function statusTone(label: string | undefined, toolStatus: ChatToolItem["status"]): Tone {
  if (toolStatus === "error" || label === "失败" || label === "出错") return "error";
  if (label === "运行中" || label === "启动中" || toolStatus === "running") return "running";
  if (label === "已完成") return "ok";
  return "idle";
}

/** 打开另一个会话。手机端没有 Router（hash 路由自管），由页面注入；桌面端不提供，走 Router */
export const OpenSessionContext = createContext<((agentId: string) => void) | null>(null);

function OpenSessionAction({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className={s.action} title="跳转到该会话" onClick={onClick}>
      <ExternalLink size={12} aria-hidden="true" />
      <span>查看会话</span>
    </button>
  );
}

function RouterOpenSessionAction({ agentId }: { agentId: string }) {
  const navigate = useNavigate();
  return <OpenSessionAction onClick={() => navigate(`/tasks/${encodeURIComponent(agentId)}`)} />;
}

function OpenSessionButton({ agentId }: { agentId: string }) {
  const openSession = useContext(OpenSessionContext);
  const inRouter = useInRouterContext();
  if (openSession) return <OpenSessionAction onClick={() => openSession(agentId)} />;
  return inRouter ? <RouterOpenSessionAction agentId={agentId} /> : null;
}

export function DelegateCard({ tool }: { tool: ChatToolItem }) {
  const info = tool.delegate!;
  const snapshots = useAtomValue(agentSnapshotsAtom);
  const runtimes = useAtomValue(chatRuntimeBySessionAtom);
  const { data: providers } = useAgentProviders();
  const [open, setOpen] = useState(false);

  const target = info.agentId ? snapshots[info.agentId] : undefined;
  const targetTitle = target
    ? agentDisplayTitle(target, runtimes[target.id], providers)
    : (info.title ??
      (info.provider
        ? `${agentProviderLabel(info.provider, providers)} 子会话`
        : info.agentId
          ? "已删除的会话"
          : "子会话"));

  // 目标会话还在列表里时用实时状态，否则退回工具结果里记录的回合结局
  const statusLabel = target
    ? agentStatusLabel(target)
    : info.result?.status
      ? (RESULT_STATUS_LABELS[info.result.status] ?? info.result.status)
      : tool.status === "running"
        ? "进行中"
        : undefined;
  const tone = statusTone(statusLabel, tool.status);
  const failure = info.errorText ?? info.result?.error;
  const detail = info.result?.reply ?? info.result?.note;
  const hasBody = Boolean(info.request || detail || failure);

  return (
    <div className={s.card} data-tone={tone} data-testid="delegate-card">
      <div className={s.header}>
        <span className={s.icon} aria-hidden="true">
          <GitBranch size={12} />
        </span>
        <span className={s.label}>{INTEROP_TOOL_LABELS[info.tool]}</span>
        <span className={s.target} title={targetTitle}>
          {targetTitle}
        </span>
        {statusLabel ? (
          <span className={s.status} data-tone={tone}>
            {statusLabel}
          </span>
        ) : null}
        <span className={s.spacer} />
        {hasBody ? (
          <button type="button" className={s.action} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            {open ? "收起" : "详情"}
          </button>
        ) : null}
        {info.agentId && target ? <OpenSessionButton agentId={info.agentId} /> : null}
      </div>
      {open && hasBody ? (
        <div className={s.body}>
          {info.request ? <pre className={s.request}>{info.request}</pre> : null}
          {detail ? <pre className={s.reply}>{detail}</pre> : null}
          {failure ? (
            <pre className={s.reply} data-error="true">
              {failure}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
