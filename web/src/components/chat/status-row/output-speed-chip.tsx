// 输入框上方状态行的「速度」芯片（design.md 4.29）：回合中显示实时输出速度，空闲时弱化显示上一回合的最终值。
import { Zap } from "lucide-react";
import type { AgentUsage } from "@agentdeck/protocol";
import s from "./status-row.module.css";
import { speedChipState } from "./status-row-presentation";

export interface OutputSpeedChipProps {
  usage: AgentUsage | undefined;
  busy: boolean;
}

export function OutputSpeedChip({ usage, busy }: OutputSpeedChipProps) {
  const state = speedChipState(usage, busy);
  if (!state) return null;
  return (
    <div>
      <span className={s.speed} data-idle={state.idle ? "true" : undefined} title={state.title}>
        <Zap size={12} aria-hidden="true" />
        <span className={s.speedText}>{state.text}</span>
      </span>
    </div>
  );
}
