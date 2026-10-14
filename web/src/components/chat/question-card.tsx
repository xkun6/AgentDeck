// Agent 提问卡片（Claude AskUserQuestion，design.md 4.13；Codex request_user_input，design.md 4.33）：
// 逐题单选 / 多选，默认每题末尾有「其他」自由输入（isOther 为 false 时不提供）；
// 没有选项的纯文本题只渲染一个输入框，isSecret 的输入遮罩。
// 提交回传 { behavior: "allow", selectedActionId: "submit", updatedInput: { ...request.input, answers } }，
// answers 的键为 question 原文，多选以 ", " 拼接；跳过回传 deny + selectedActionId "skip"。
import { useState } from "react";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentQuestion,
} from "@agentdeck/protocol";
import type { PendingApproval } from "@/stores/chat";
import { HANDLED_ELSEWHERE_MESSAGE, useApprovalFailure } from "./use-approval-failure";
import a from "./approval-dialog.module.css";
import s from "./question-card.module.css";

export interface QuestionCardProps {
  approval: PendingApproval;
  request: AgentPermissionRequest;
  questions: AgentQuestion[];
  onRespond: (approval: PendingApproval, response: AgentPermissionResponse) => Promise<void>;
  /** 除当前这条外还有几条待处理 */
  remaining?: number;
}

export interface QuestionSelection {
  /** 选中的选项 label（单选至多一个） */
  selected: string[];
  /** 是否选了「其他」 */
  other: boolean;
  otherText: string;
}

export const QUESTION_SKIP_MESSAGE = "用户跳过了这些问题";

const EMPTY_SELECTION: QuestionSelection = { selected: [], other: false, otherText: "" };

/** 纯文本题：没有选项，只有一个输入框（Codex request_user_input 的 options:null） */
export function isFreeTextQuestion(question: AgentQuestion): boolean {
  return question.freeText === true || question.options.length === 0;
}

/** 是否提供「其他」自由输入：缺省 = 提供（Claude 的 AskUserQuestion 一律带「其他」），Codex 按 isOther 给出 */
function allowsOther(question: AgentQuestion): boolean {
  return question.isOther !== false;
}

function initialSelection(question: AgentQuestion): QuestionSelection {
  return { ...EMPTY_SELECTION, other: isFreeTextQuestion(question) };
}

/** 按当前选择构造 answers；有题目未作答时返回 null。 */
export function buildQuestionAnswers(
  questions: readonly AgentQuestion[],
  selections: readonly (QuestionSelection | undefined)[],
): Record<string, string> | null {
  const answers: Record<string, string> = {};
  for (const [index, question] of questions.entries()) {
    const selection = selections[index] ?? initialSelection(question);
    const otherText = selection.other ? selection.otherText.trim() : "";
    const values = isFreeTextQuestion(question)
      ? otherText ? [otherText] : []
      : question.multiSelect
      ? [
          ...question.options
            .filter((option) => selection.selected.includes(option.label))
            .map((option) => option.label),
          ...(otherText ? [otherText] : []),
        ]
      : selection.other
        ? otherText ? [otherText] : []
        : selection.selected.slice(0, 1);
    if (values.length === 0) return null;
    answers[question.question] = values.join(", ");
  }
  return answers;
}

function toggleOption(question: AgentQuestion, selection: QuestionSelection, label: string): QuestionSelection {
  if (!question.multiSelect) return { ...selection, selected: [label], other: false };
  const selected = selection.selected.includes(label)
    ? selection.selected.filter((item) => item !== label)
    : [...selection.selected, label];
  return { ...selection, selected };
}

function toggleOther(question: AgentQuestion, selection: QuestionSelection): QuestionSelection {
  if (!question.multiSelect) return { ...selection, selected: [], other: true };
  return { ...selection, other: !selection.other };
}

export function QuestionCard({ approval, request, questions, onRespond, remaining }: QuestionCardProps) {
  const [selections, setSelections] = useState<QuestionSelection[]>(() =>
    questions.map(initialSelection),
  );
  const [responding, setResponding] = useState<"submit" | "skip" | null>(null);
  const { error, handledElsewhere, fail, clearError } = useApprovalFailure(approval);
  const locked = responding !== null || handledElsewhere;
  const answers = buildQuestionAnswers(questions, selections);
  const description = request.description ?? approval.reason;

  const update = (index: number, next: QuestionSelection) => {
    setSelections((current) => current.map((item, i) => (i === index ? next : item)));
  };

  const respond = async (kind: "submit" | "skip") => {
    if (locked) return;
    if (kind === "submit" && !answers) return;
    setResponding(kind);
    clearError();
    const response: AgentPermissionResponse = kind === "submit"
      ? { behavior: "allow", selectedActionId: "submit", updatedInput: { ...request.input, answers: answers! } }
      : { behavior: "deny", selectedActionId: "skip", message: QUESTION_SKIP_MESSAGE };
    try {
      await onRespond(approval, response);
    } catch (err) {
      fail(err, "回答发送失败");
    } finally {
      setResponding(null);
    }
  };

  return (
    <div className={a.card} role="group" aria-label="Agent 提问">
      <div className={a.header}>{request.title || "Agent 需要你的回答"}</div>
      {remaining && remaining > 0 ? <div className={a.queue}>还有 {remaining} 条待处理</div> : null}
      {description ? <div className={a.description}>{description}</div> : null}
      <div className={s.questions}>
        {questions.map((question, index) => {
          const selection = selections[index] ?? initialSelection(question);
          const name = `question-${request.id}-${index}`;
          const inputType = question.multiSelect ? "checkbox" : "radio";
          const textType = question.isSecret ? "password" : "text";
          if (isFreeTextQuestion(question)) {
            return (
              <fieldset key={`${index}-${question.question}`} className={s.question}>
                <legend className={s.legend}>
                  {question.header ? <span className={s.chip}>{question.header}</span> : null}
                  <span className={s.questionText}>{question.question}</span>
                </legend>
                <input
                  className={s.otherInput}
                  type={textType}
                  autoComplete="off"
                  value={selection.otherText}
                  placeholder="输入你的回答"
                  aria-label={question.question}
                  disabled={locked}
                  onChange={(event) => update(index, { ...selection, otherText: event.target.value })}
                />
              </fieldset>
            );
          }
          return (
            <fieldset key={`${index}-${question.question}`} className={s.question}>
              <legend className={s.legend}>
                {question.header ? <span className={s.chip}>{question.header}</span> : null}
                <span className={s.questionText}>{question.question}</span>
                {question.multiSelect ? <span className={s.hint}>可多选</span> : null}
              </legend>
              <div
                className={s.options}
                role={question.multiSelect ? "group" : "radiogroup"}
                aria-label={question.question}
              >
                {question.options.map((option) => {
                  const checked = selection.selected.includes(option.label);
                  return (
                    <label key={option.label} className={s.option} data-checked={checked}>
                      <input
                        className={s.control}
                        type={inputType}
                        name={name}
                        checked={checked}
                        aria-checked={checked}
                        disabled={locked}
                        onChange={() => update(index, toggleOption(question, selection, option.label))}
                      />
                      <span className={s.optionBody}>
                        <span className={s.optionLabel}>{option.label}</span>
                        {option.description ? (
                          <span className={s.optionDescription}>{option.description}</span>
                        ) : null}
                        {checked && option.preview ? <pre className={s.preview}>{option.preview}</pre> : null}
                      </span>
                    </label>
                  );
                })}
                {allowsOther(question) ? (
                  <label className={s.option} data-checked={selection.other}>
                    <input
                      className={s.control}
                      type={inputType}
                      name={name}
                      checked={selection.other}
                      aria-checked={selection.other}
                      disabled={locked}
                      onChange={() => update(index, toggleOther(question, selection))}
                    />
                    <span className={s.optionBody}>
                      <span className={s.optionLabel}>其他</span>
                    </span>
                  </label>
                ) : null}
                {allowsOther(question) && selection.other ? (
                  <input
                    className={s.otherInput}
                    type={textType}
                    autoComplete={question.isSecret ? "off" : undefined}
                    value={selection.otherText}
                    placeholder="输入你的回答"
                    aria-label={`${question.question}：其他回答`}
                    disabled={locked}
                    onChange={(event) => update(index, { ...selection, otherText: event.target.value })}
                  />
                ) : null}
              </div>
            </fieldset>
          );
        })}
      </div>
      {error ? <div className={a.error} role="alert">发送失败：{error}</div> : null}
      {handledElsewhere ? <div className={a.handled} role="status">{HANDLED_ELSEWHERE_MESSAGE}</div> : null}
      <div className={a.actions}>
        <button
          type="button"
          className={a.allow}
          onClick={() => void respond("submit")}
          disabled={locked || !answers}
        >
          {responding === "submit" ? "发送中…" : "提交回答"}
        </button>
        <button
          type="button"
          className={a.deny}
          onClick={() => void respond("skip")}
          disabled={locked}
        >
          {responding === "skip" ? "发送中…" : "跳过"}
        </button>
      </div>
    </div>
  );
}
