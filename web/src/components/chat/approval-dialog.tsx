// 审批卡片：按 AgentPermissionRequest.actions 渲染按钮（design.md 4.3 / 5.3）。
// Claude allow/deny、approve/keep_planning，Codex accept/decline，ACP 为 optionId，
// 一律回传 { behavior, selectedActionId }；没有 actions 时给默认的 允许 / 拒绝。
import { useState } from "react";
import type {
  AgentPermissionAction,
  AgentPermissionRequest,
  AgentPermissionResponse,
} from "@agentdeck/protocol";
import { describeToolDetail } from "@/lib/agent-tool-detail";
import type { PendingApproval } from "@/stores/chat";
import { QuestionCard } from "./question-card";
import s from "./approval-dialog.module.css";

export interface ApprovalDialogProps {
  approval: PendingApproval;
  onRespond: (approval: PendingApproval, response: AgentPermissionResponse) => Promise<void>;
}

const DEFAULT_ACTIONS: AgentPermissionAction[] = [
  { id: "allow", label: "允许", behavior: "allow" },
  { id: "deny", label: "拒绝", behavior: "deny" },
];

function defaultTitle(request: AgentPermissionRequest | undefined): string {
  if (request?.kind === "plan") return "需要批准计划";
  if (request?.kind === "question") return "Agent 需要你的回答";
  if (request?.kind === "mode") return "需要确认切换模式";
  return "需要确认执行";
}

export function responseForAction(action: AgentPermissionAction, hasActions: boolean): AgentPermissionResponse {
  const selected = hasActions ? { selectedActionId: action.id } : {};
  return action.behavior === "allow"
    ? { behavior: "allow", ...selected }
    : { behavior: "deny", ...selected };
}

function ApprovalDetail({ request, fallback }: { request?: AgentPermissionRequest; fallback: string }) {
  const detail = request?.detail;
  if (!detail) {
    return fallback ? <pre className={s.command}>{fallback}</pre> : null;
  }
  const display = describeToolDetail(detail);
  switch (detail.type) {
    case "shell":
      return (
        <>
          <pre className={s.command} data-kind="shell">{detail.command}</pre>
          {detail.cwd ? <div className={s.meta}>工作目录：{detail.cwd}</div> : null}
        </>
      );
    case "edit":
    case "write":
      return (
        <>
          <div className={s.meta}>
            {detail.type === "edit" ? "修改文件" : "写入文件"}：{detail.filePath}
            {display.preview ? `（${display.preview}）` : ""}
          </div>
          {display.output ? <pre className={s.diff} data-kind={detail.type}>{display.output}</pre> : null}
        </>
      );
    case "plan":
      return <pre className={s.plan}>{detail.text}</pre>;
    default:
      return (
        <>
          {display.context ? <pre className={s.command}>{display.context}</pre> : null}
          {display.output && display.output !== display.context ? (
            <pre className={s.diff}>{display.output}</pre>
          ) : null}
        </>
      );
  }
}

export function ApprovalDialog({ approval, onRespond }: ApprovalDialogProps) {
  const request = approval.permission;
  // Agent 提问（design.md 4.13）：逐题作答，不走通用的允许 / 拒绝
  if (request?.kind === "question" && request.detail?.type === "question") {
    return (
      <QuestionCard
        approval={approval}
        request={request}
        questions={request.detail.questions}
        onRespond={onRespond}
      />
    );
  }
  return <PermissionCard approval={approval} onRespond={onRespond} />;
}

function PermissionCard({ approval, onRespond }: ApprovalDialogProps) {
  const request = approval.permission;
  const [responding, setResponding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasActions = Boolean(request?.actions && request.actions.length > 0);
  const actions = hasActions ? request!.actions! : DEFAULT_ACTIONS;
  const title = request?.title || defaultTitle(request);
  const description = request?.description ?? approval.reason;

  const respond = async (action: AgentPermissionAction) => {
    if (responding) return;
    setResponding(action.id);
    setError(null);
    try {
      await onRespond(approval, responseForAction(action, hasActions));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message || "审批响应发送失败");
    } finally {
      setResponding(null);
    }
  };

  return (
    <div className={s.card} role="group" aria-label="审批请求">
      <div className={s.header}>{title}</div>
      {description ? <div className={s.description}>{description}</div> : null}
      <ApprovalDetail request={request} fallback={approval.command} />
      {error ? <div className={s.error} role="alert">发送失败：{error}</div> : null}
      <div className={s.actions}>
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className={action.behavior === "allow" ? s.allow : s.deny}
            onClick={() => void respond(action)}
            disabled={responding !== null}
          >
            {responding === action.id ? "发送中…" : action.label}
          </button>
        ))}
      </div>
    </div>
  );
}
