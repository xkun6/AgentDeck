// MCP 表单 / 浏览器流程卡片（design.md 4.32）：Claude control_request elicitation、Codex mcpServer/elicitation/request。
// form：按 fields 渲染输入控件，提交回传 { behavior: "allow", selectedActionId: "submit", updatedInput: { content } }；
// url：显示说明与链接，「已完成」回传 allow（selectedActionId "done"）；
// 「拒绝」回传 deny（selectedActionId "decline"）；「取消」回传 deny + interrupt:true（会中断本回合）。
import { useId, useState } from "react";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  ElicitationField,
  ToolCallDetail,
} from "@agentdeck/protocol";
import { openExternalUrl, normalizeExternalUrl } from "@/lib/external-links";
import type { PendingApproval } from "@/stores/chat";
import {
  buildContent,
  initialValues,
  RADIO_OPTION_LIMIT,
  validateField,
  type FieldValue,
  type FieldValues,
} from "./elicitation-form";
import { HANDLED_ELSEWHERE_MESSAGE, useApprovalFailure } from "./use-approval-failure";
import a from "./approval-dialog.module.css";
import s from "./elicitation-card.module.css";

type ElicitationDetail = Extract<ToolCallDetail, { type: "elicitation" }>;

export interface ElicitationCardProps {
  approval: PendingApproval;
  request: AgentPermissionRequest;
  detail: ElicitationDetail;
  onRespond: (approval: PendingApproval, response: AgentPermissionResponse) => Promise<void>;
  /** 除当前这条外还有几条待处理 */
  remaining?: number;
}

type ResponseKind = "submit" | "decline" | "cancel";

const FORMAT_INPUT_TYPE: Record<string, string> = { email: "email", uri: "url", date: "date" };

export function ElicitationCard({ approval, request, detail, onRespond, remaining }: ElicitationCardProps) {
  const fields = detail.fields ?? [];
  const isUrl = detail.mode === "url";
  const [values, setValues] = useState<FieldValues>(() => initialValues(fields));
  const [showErrors, setShowErrors] = useState(false);
  const [responding, setResponding] = useState<ResponseKind | null>(null);
  const [linkError, setLinkError] = useState(false);
  const { error, handledElsewhere, fail, clearError } = useApprovalFailure(approval);
  const idPrefix = useId();
  const locked = responding !== null || handledElsewhere;
  const description = request.description ?? approval.reason;
  const safeUrl = detail.url ? normalizeExternalUrl(detail.url) : null;

  const setValue = (key: string, value: FieldValue) => setValues((current) => ({ ...current, [key]: value }));

  const respond = async (kind: ResponseKind) => {
    if (locked) return;
    let response: AgentPermissionResponse;
    if (kind === "submit") {
      if (isUrl) {
        response = { behavior: "allow", selectedActionId: "done" };
      } else {
        const { content, errors } = buildContent(fields, values);
        if (Object.keys(errors).length > 0) {
          setShowErrors(true);
          return;
        }
        response = { behavior: "allow", selectedActionId: "submit", updatedInput: { content } };
      }
    } else if (kind === "decline") {
      response = { behavior: "deny", selectedActionId: "decline" };
    } else {
      response = { behavior: "deny", selectedActionId: "cancel", interrupt: true };
    }
    setResponding(kind);
    clearError();
    try {
      await onRespond(approval, response);
    } catch (err) {
      fail(err, "表单发送失败");
    } finally {
      setResponding(null);
    }
  };

  const openLink = async () => {
    setLinkError(false);
    const opened = await openExternalUrl(detail.url);
    if (!opened) setLinkError(true);
  };

  return (
    <div className={a.card} role="group" aria-label={isUrl ? "浏览器操作请求" : "表单请求"}>
      <div className={a.header}>
        {request.title || (isUrl ? `${detail.serverName} 需要你在浏览器中完成操作` : `${detail.serverName} 需要你填写表单`)}
      </div>
      {remaining && remaining > 0 ? <div className={a.queue}>还有 {remaining} 条待处理</div> : null}
      {description ? <div className={a.description}>{description}</div> : null}
      {detail.message ? <div className={s.message}>{detail.message}</div> : null}
      {isUrl ? (
        <div className={s.link}>
          {safeUrl ? (
            <button type="button" className={s.openLink} onClick={() => void openLink()} disabled={locked}>
              在浏览器中打开
            </button>
          ) : null}
          <div className={s.url}>{detail.url ?? "（缺少链接）"}</div>
          {detail.url && !safeUrl ? <div className={a.error} role="alert">链接协议不受支持，已禁止打开</div> : null}
          {linkError ? <div className={a.error} role="alert">无法打开链接，请手动复制上面的地址</div> : null}
          <div className={s.hint}>在浏览器里完成后，回到这里点「已完成」。</div>
        </div>
      ) : (
        <div className={s.fields}>
          {fields.map((field) => (
            <FieldControl
              key={field.key}
              field={field}
              id={`${idPrefix}-${field.key}`}
              value={values[field.key]}
              error={showErrors ? validateField(field, values[field.key]) : null}
              disabled={locked}
              onChange={(value) => setValue(field.key, value)}
            />
          ))}
        </div>
      )}
      {error ? <div className={a.error} role="alert">发送失败：{error}</div> : null}
      {handledElsewhere ? <div className={a.handled} role="status">{HANDLED_ELSEWHERE_MESSAGE}</div> : null}
      <div className={`${a.actions} ${s.actions}`}>
        <button type="button" className={a.allow} onClick={() => void respond("submit")} disabled={locked}>
          {responding === "submit" ? "发送中…" : isUrl ? "已完成" : "提交"}
        </button>
        <button type="button" className={a.deny} onClick={() => void respond("decline")} disabled={locked}>
          {responding === "decline" ? "发送中…" : "拒绝"}
        </button>
        <button
          type="button"
          className={a.deny}
          title="取消并中断本回合"
          onClick={() => void respond("cancel")}
          disabled={locked}
        >
          {responding === "cancel" ? "发送中…" : "取消"}
        </button>
      </div>
    </div>
  );
}

interface FieldControlProps {
  field: ElicitationField;
  id: string;
  value: FieldValue | undefined;
  error: string | null;
  disabled: boolean;
  onChange: (value: FieldValue) => void;
}

function FieldControl({ field, id, value, error, disabled, onChange }: FieldControlProps) {
  const label = field.title || field.key;
  const labelNode = (
    <>
      <span className={s.labelText}>{label}</span>
      {field.required ? <span className={s.required} aria-hidden="true"> *</span> : null}
    </>
  );
  const describedBy = [field.description ? `${id}-desc` : null, error ? `${id}-err` : null].filter(Boolean).join(" ") || undefined;
  const meta = (
    <>
      {field.description ? <div id={`${id}-desc`} className={s.description}>{field.description}</div> : null}
      {error ? <div id={`${id}-err`} className={s.fieldError} role="alert">{error}</div> : null}
    </>
  );

  if (field.type === "boolean") {
    return (
      <div className={s.field}>
        <label className={s.checkRow} htmlFor={id}>
          <input
            id={id}
            className={s.control}
            type="checkbox"
            checked={value === true}
            disabled={disabled}
            aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span>{labelNode}</span>
        </label>
        {meta}
      </div>
    );
  }

  if (field.type === "multiselect") {
    const selected = Array.isArray(value) ? value : [];
    return (
      <fieldset className={s.field} aria-describedby={describedBy}>
        <legend className={s.legend}>
          {labelNode}
          {field.min !== undefined || field.max !== undefined ? (
            <span className={s.hint}>
              {" "}（{field.min !== undefined ? `至少 ${field.min} 项` : ""}{field.min !== undefined && field.max !== undefined ? "，" : ""}{field.max !== undefined ? `最多 ${field.max} 项` : ""}）
            </span>
          ) : null}
        </legend>
        <div className={s.options}>
          {(field.options ?? []).map((option) => (
            <label key={option.value} className={s.checkRow} data-checked={selected.includes(option.value)}>
              <input
                className={s.control}
                type="checkbox"
                checked={selected.includes(option.value)}
                disabled={disabled}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, option.value]
                      : selected.filter((item) => item !== option.value),
                  )
                }
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
        {meta}
      </fieldset>
    );
  }

  if (field.type === "select") {
    const options = field.options ?? [];
    if (options.length <= RADIO_OPTION_LIMIT) {
      return (
        <fieldset className={s.field} aria-describedby={describedBy}>
          <legend className={s.legend}>{labelNode}</legend>
          <div className={s.options} role="radiogroup" aria-label={label}>
            {options.map((option) => (
              <label key={option.value} className={s.checkRow} data-checked={value === option.value}>
                <input
                  className={s.control}
                  type="radio"
                  name={id}
                  checked={value === option.value}
                  disabled={disabled}
                  onChange={() => onChange(option.value)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
          {meta}
        </fieldset>
      );
    }
    return (
      <div className={s.field}>
        <label className={s.label} htmlFor={id}>{labelNode}</label>
        <select
          id={id}
          className={s.input}
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{field.required ? "请选择" : "（不选择）"}</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        {meta}
      </div>
    );
  }

  const numeric = field.type === "number" || field.type === "integer";
  const inputType = field.secret ? "password" : numeric ? "text" : (field.format && FORMAT_INPUT_TYPE[field.format]) || "text";
  return (
    <div className={s.field}>
      <label className={s.label} htmlFor={id}>{labelNode}</label>
      <input
        id={id}
        className={s.input}
        type={inputType}
        inputMode={field.type === "integer" ? "numeric" : field.type === "number" ? "decimal" : undefined}
        autoComplete={field.secret ? "off" : undefined}
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        maxLength={field.maxLength}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
      />
      {meta}
    </div>
  );
}
