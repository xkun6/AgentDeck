// 会话详情输入框上方的心跳 / 目标循环状态条（design.md 4.25）：如「目标循环 3/10 · 停止」「心跳：空闲 30 分钟后发送 · 停止」。
import { useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { Repeat, Timer } from "lucide-react";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import { automationActionDraft, automationBarItems } from "@/lib/schedule-display";
import { schedulesStateAtom } from "@/stores/schedules";
import s from "./automation-status-bar.module.css";

export function AutomationStatusBar({ agentId }: { agentId: string | null | undefined }) {
  const actions = useAgentSession();
  const { schedules } = useAtomValue(schedulesStateAtom);
  const items = useMemo(() => automationBarItems(schedules, agentId), [schedules, agentId]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (items.length === 0) return null;

  const run = async (scheduleId: string, kind: "stop" | "resume") => {
    const schedule = schedules.find((item) => item.id === scheduleId);
    if (!schedule) return;
    setPendingId(scheduleId);
    setError(null);
    try {
      await actions.upsertSchedule(automationActionDraft(schedule, kind));
    } catch (err) {
      setError(humanizeSidecarError(err));
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className={s.wrap} role="status" aria-label="自动化状态">
      {items.map((item) => (
        <div key={item.scheduleId} className={s.bar} data-tone={item.tone} data-kind={item.kind}>
          {item.kind === "goal" ? <Repeat size={12} aria-hidden="true" /> : <Timer size={12} aria-hidden="true" />}
          <span className={s.label}>{item.label}</span>
          <button
            type="button"
            className={s.action}
            disabled={pendingId === item.scheduleId}
            onClick={() => void run(item.scheduleId, item.action.kind)}
          >
            {item.action.label}
          </button>
        </div>
      ))}
      {error ? <div className={s.error} role="alert">{error}</div> : null}
    </div>
  );
}
