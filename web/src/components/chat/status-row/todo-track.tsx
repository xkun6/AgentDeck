// 输入框上方状态行的「步骤」药丸（design.md 4.29）：Agent 自己维护的待办清单（最近一条 todo）。
// 点开列出每一步：已完成 / 进行中 / 未开始；样式与子代理药丸的弹层一致。
import { useState } from "react";
import { Check, ChevronDown, ChevronUp, ListChecks } from "lucide-react";
import t from "../subagents/subagent-track.module.css";
import s from "./status-row.module.css";
import { todoChipLabel, todoProgress, todoStepStatus, type TodoStep } from "./status-row-presentation";

export interface TodoTrackProps {
  items: readonly TodoStep[] | undefined;
  /** 回合进行中：第一条未完成项视为「进行中」 */
  busy: boolean;
}

export function TodoTrack({ items, busy }: TodoTrackProps) {
  const [open, setOpen] = useState(false);
  if (!items || items.length === 0) return null;
  const progress = todoProgress(items, busy);

  return (
    <div>
      <button
        type="button"
        className={`${t.pill} ${s.pill}`}
        data-tone={progress.allDone ? "done" : "normal"}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title="步骤"
      >
        <ListChecks size={12} aria-hidden="true" />
        <span className={t.pillTitle}>步骤</span>
        <span className={`${t.pillLabel} ${s.pillValue}`}>{todoChipLabel(progress)}</span>
        {open ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
      </button>
      {open ? (
        <ul className={t.list} aria-label="步骤列表">
          {items.map((item, index) => {
            const status = todoStepStatus(item, index, progress);
            return (
              <li key={index} className={s.todoRow} data-status={status}>
                <span className={s.todoIcon} aria-hidden="true">
                  {status === "completed" ? (
                    <Check size={12} />
                  ) : status === "in_progress" ? (
                    <span className={s.todoDot} />
                  ) : (
                    <span className={s.todoHollowDot} />
                  )}
                </span>
                <span className={s.todoText}>{item.text}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
