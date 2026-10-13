// 时间线里 sub_agent 父卡片展开后的详情（design.md 4.11）：类型、任务描述、动作列表与其余日志。
// 交互参照 paseo packages/app/src/components/tool-call-details.tsx 的 SubAgentDetailSection，用 React + CSS Modules 重写。
import { useMemo } from "react";
import type { ChatSubAgentInfo, ChatToolItem } from "../chat-types";
import { parseSubAgentLog } from "./subagent-presentation";
import s from "./subagent-tool-detail.module.css";

const STATUS_TEXT: Record<ChatToolItem["status"], string> = {
  running: "运行中",
  done: "已完成",
  error: "失败或已取消",
};

export function SubAgentToolDetail({
  info,
  status,
}: {
  info: ChatSubAgentInfo;
  status: ChatToolItem["status"];
}) {
  const { actions, remainingLog } = useMemo(() => parseSubAgentLog(info.log), [info.log]);
  return (
    <div className={s.detail} data-testid="subagent-tool-detail">
      <div className={s.meta}>
        <span className={s.type}>{info.subAgentType ?? "Task"}</span>
        <span className={s.status} data-status={status}>{STATUS_TEXT[status]}</span>
      </div>
      {info.description ? <div className={s.description}>{info.description}</div> : null}
      {actions.length > 0 ? (
        <ol className={s.actions}>
          {actions.map((action) => (
            <li key={action.index} className={s.action}>
              <span className={s.actionTool}>{action.toolName}</span>
              {action.summary ? <span className={s.actionSummary}>{action.summary}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
      {remainingLog ? <div className={s.log}>{remainingLog}</div> : null}
      {actions.length === 0 && !remainingLog ? (
        <div className={s.empty}>{status === "running" ? "子代理已启动，暂无动作" : "没有记录到子代理动作"}</div>
      ) : null}
    </div>
  );
}
