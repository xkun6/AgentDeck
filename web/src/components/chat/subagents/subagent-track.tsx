// 输入框上方的「子代理」药丸（design.md 4.11）：只显示当前层级，按状态计数；点开列出子代理行，
// 点一行打开只读子代理面板。交互参照 paseo packages/app/src/subagents/track.tsx，用 React + CSS Modules 重写。
import { useMemo, useState } from "react";
import { Bot, ChevronDown, ChevronUp } from "lucide-react";
import type { ProviderSubagentDescriptor } from "@agentdeck/protocol";
import {
  selectSubagentsAtLevel,
  subagentDotStatus,
  subagentPillLabel,
  subagentRowLabel,
  subagentStatusText,
} from "./subagent-presentation";
import s from "./subagent-track.module.css";

export interface SubagentTrackProps {
  /** 该会话全部层级的子代理 */
  subagents: readonly ProviderSubagentDescriptor[];
  /** 当前层级：父会话视图为 null，子代理面板内为该子代理 id */
  parentSubagentId: string | null;
  onOpen: (subagentId: string) => void;
  /** 当前在面板中打开的子代理（高亮） */
  activeSubagentId?: string | null;
}

export function SubagentTrack({ subagents, parentSubagentId, onOpen, activeSubagentId }: SubagentTrackProps) {
  const rows = useMemo(
    () => selectSubagentsAtLevel(subagents, parentSubagentId),
    [parentSubagentId, subagents],
  );
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  const label = subagentPillLabel(rows);
  const running = rows.some((row) => row.status === "running");
  const failed = rows.some((row) => row.status === "failed");
  const tone = failed ? "error" : running ? "running" : "done";

  return (
    <div className={s.track}>
      <button
        type="button"
        className={s.pill}
        data-tone={tone}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title="子代理"
      >
        <Bot size={12} aria-hidden="true" />
        <span className={s.pillTitle}>子代理</span>
        <span className={s.pillLabel}>{label}</span>
        {open ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
      </button>
      {open ? (
        <ul className={s.list} aria-label="子代理列表">
          {rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className={s.row}
                data-active={row.id === activeSubagentId ? "true" : undefined}
                onClick={() => onOpen(row.id)}
                title={subagentStatusText(row.status)}
              >
                <span className={s.dot} data-status={subagentDotStatus(row.status)} aria-hidden="true" />
                <span className={s.rowLabel}>{subagentRowLabel(row)}</span>
                {row.subtitle ? <span className={s.rowSubtitle}>{row.subtitle}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
