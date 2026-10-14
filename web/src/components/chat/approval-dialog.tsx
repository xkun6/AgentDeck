// 审批卡片：按 AgentPermissionRequest.actions 渲染按钮（design.md 4.3 / 5.3）。
// Claude allow/deny、approve/keep_planning，Codex accept/decline，ACP 为 optionId，
// 一律回传 { behavior, selectedActionId }；没有 actions 时给默认的 允许 / 拒绝。
import { useEffect, useRef, useState } from "react";
import type {
  AgentPermissionAction,
  AgentPermissionRequest,
  AgentPermissionResponse,
} from "@agentdeck/protocol";
import { describeToolDetail } from "@/lib/agent-tool-detail";
import type { PendingApproval } from "@/stores/chat";
import { ElicitationCard } from "./elicitation-card";
import { MessageText } from "./message-text";
import { QuestionCard } from "./question-card";
import { HANDLED_ELSEWHERE_MESSAGE, useApprovalFailure } from "./use-approval-failure";
import s from "./approval-dialog.module.css";

export interface ApprovalDialogProps {
  approval: PendingApproval;
  onRespond: (approval: PendingApproval, response: AgentPermissionResponse) => Promise<void>;
  /** 除当前这条外还有几条待处理（≥1 时在卡片上提示；处理完当前一条后自动显示下一条） */
  remaining?: number;
}

const DEFAULT_ACTIONS: AgentPermissionAction[] = [
  { id: "allow", label: "允许", behavior: "allow" },
  { id: "deny", label: "拒绝", behavior: "deny" },
];

function defaultTitle(request: AgentPermissionRequest | undefined): string {
  if (request?.kind === "plan") return "需要批准计划";
  if (request?.kind === "question") return "Agent 需要你的回答";
  if (request?.kind === "mode") return "需要确认切换模式";
  if (request?.kind === "elicitation") return "Agent 需要你填写表单";
  return "需要确认执行";
}

/** message：拒绝 / 继续规划时附带的理由（给 Agent 的意见）；空串视为没有，允许类动作忽略 */
export function responseForAction(
  action: AgentPermissionAction,
  hasActions: boolean,
  message?: string,
): AgentPermissionResponse {
  const selected = hasActions ? { selectedActionId: action.id } : {};
  if (action.behavior === "allow") return { behavior: "allow", ...selected };
  const reason = message?.trim();
  return { behavior: "deny", ...selected, ...(reason ? { message: reason } : {}) };
}

/**
 * 按钮样式：「始终允许」类（persist）用次要样式避免误点；defaultDeny 时拒绝为主按钮、允许类不抢眼
 * （每条 allow 都是 s.allowNeutral，包括普通「允许一次」）。
 */
function actionClass(action: AgentPermissionAction, defaultDeny: boolean): string {
  if (action.behavior === "deny") return defaultDeny ? s.denyPrimary : s.deny;
  if (action.persist) return s.allowAlways;
  return defaultDeny ? s.allowNeutral : s.allow;
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
      return (
        <div className={s.plan} data-kind="plan">
          <MessageText text={detail.text} />
        </div>
      );
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

export function ApprovalDialog({ approval, onRespond, remaining }: ApprovalDialogProps) {
  const request = approval.permission;
  // Agent 提问（design.md 4.13）：逐题作答，不走通用的允许 / 拒绝
  if (request?.kind === "question" && request.detail?.type === "question") {
    return (
      <QuestionCard
        approval={approval}
        request={request}
        questions={request.detail.questions}
        onRespond={onRespond}
        remaining={remaining}
      />
    );
  }
  // MCP 表单 / 浏览器流程（design.md 4.32）
  if (request?.kind === "elicitation" && request.detail?.type === "elicitation") {
    return (
      <ElicitationCard
        approval={approval}
        request={request}
        detail={request.detail}
        onRespond={onRespond}
        remaining={remaining}
      />
    );
  }
  return <PermissionCard approval={approval} onRespond={onRespond} remaining={remaining} />;
}

function PermissionCard({ approval, onRespond, remaining }: ApprovalDialogProps) {
  const request = approval.permission;
  const [responding, setResponding] = useState<string | null>(null);
  const { error, handledElsewhere, fail, clearError } = useApprovalFailure(approval);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  const reasonRef = useRef<HTMLInputElement>(null);
  const hasActions = Boolean(request?.actions && request.actions.length > 0);
  const actions = hasActions ? request!.actions! : DEFAULT_ACTIONS;
  const title = request?.title || defaultTitle(request);
  const description = request?.description ?? approval.reason;
  const denyActions = actions.filter((action) => action.behavior === "deny");
  // defaultDeny（Claude default_to_no）：不预选「允许」，拒绝排在最前并作为主按钮
  const defaultDeny = request?.defaultDeny === true;
  const orderedActions = defaultDeny ? [...denyActions, ...actions.filter((action) => action.behavior === "allow")] : actions;
  const hintActions = actions.filter((action) => action.description);
  // plan 的「继续规划」附的是给 Agent 的意见，其余是拒绝理由
  const reasonLabel = request?.kind === "plan" ? "意见" : "理由";

  // 展开后聚焦输入框；手机软键盘弹出有动画，等它升起后再把输入框滚进可视区
  useEffect(() => {
    if (!reasonOpen) return;
    const input = reasonRef.current;
    input?.focus();
    const timer = setTimeout(() => input?.scrollIntoView?.({ block: "center", behavior: "smooth" }), 250);
    return () => clearTimeout(timer);
  }, [reasonOpen]);

  const respond = async (action: AgentPermissionAction) => {
    if (responding || handledElsewhere) return;
    setResponding(action.id);
    clearError();
    try {
      await onRespond(approval, responseForAction(action, hasActions, reasonOpen ? reason : ""));
    } catch (err) {
      fail(err, "审批响应发送失败");
    } finally {
      setResponding(null);
    }
  };

  return (
    <div className={s.card} role="group" aria-label="审批请求">
      <div className={s.header}>{title}</div>
      {remaining && remaining > 0 ? <div className={s.queue}>还有 {remaining} 条待处理</div> : null}
      {description ? <div className={s.description}>{description}</div> : null}
      <ApprovalDetail request={request} fallback={approval.command} />
      {error ? <div className={s.error} role="alert">发送失败：{error}</div> : null}
      {handledElsewhere ? <div className={s.handled} role="status">{HANDLED_ELSEWHERE_MESSAGE}</div> : null}
      <div className={s.actions}>
        {orderedActions.map((action) => (
          <button
            key={action.id}
            type="button"
            className={actionClass(action, defaultDeny)}
            title={action.description}
            data-persist={action.persist}
            data-primary={defaultDeny && action.behavior === "deny" ? "true" : undefined}
            onClick={() => void respond(action)}
            disabled={responding !== null || handledElsewhere}
          >
            {responding === action.id ? "发送中…" : action.label}
          </button>
        ))}
        {denyActions.length > 0 ? (
          <button
            type="button"
            className={s.reasonToggle}
            aria-expanded={reasonOpen}
            aria-label={`${reasonOpen ? "收起" : "添加"}${reasonLabel}`}
            onClick={() => setReasonOpen((open) => !open)}
            disabled={responding !== null || handledElsewhere}
          >
            {reasonLabel}
          </button>
        ) : null}
      </div>
      {hintActions.length > 0 ? (
        <ul className={s.hints}>
          {hintActions.map((action) => (
            <li key={action.id}>
              <span className={s.hintLabel}>{action.label}</span>：{action.description}
            </li>
          ))}
        </ul>
      ) : null}
      {reasonOpen ? (
        <input
          ref={reasonRef}
          className={s.reasonInput}
          type="text"
          value={reason}
          placeholder={`${reasonLabel}（可选），回车提交「${denyActions[0]?.label ?? "拒绝"}」`}
          aria-label={reasonLabel}
          disabled={responding !== null || handledElsewhere}
          onChange={(event) => setReason(event.target.value)}
          onKeyDown={(event) => {
            // 输入法选词时的回车不提交
            if (event.key !== "Enter" || event.nativeEvent.isComposing || denyActions.length === 0) return;
            event.preventDefault();
            void respond(denyActions[0]!);
          }}
        />
      ) : null}
    </div>
  );
}
