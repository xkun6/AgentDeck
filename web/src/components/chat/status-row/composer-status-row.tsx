// 输入框上方状态行（design.md 4.29）：子代理、后台任务、步骤、额度、速度五个芯片同处一行，
// 没有内容的芯片隐藏，整行都没有内容时不渲染（不占高度）。
import type {
  AgentBackgroundTask,
  AgentRateLimits,
  AgentUsage,
  ProviderSubagentDescriptor,
} from "@agentdeck/protocol";
import { BackgroundTaskTrack } from "../background-tasks/background-task-track";
import { SubagentTrack } from "../subagents/subagent-track";
import { selectSubagentsAtLevel } from "../subagents/subagent-presentation";
import { OutputSpeedChip } from "./output-speed-chip";
import { RateLimitTrack } from "./rate-limit-track";
import { speedChipState, type TodoStep } from "./status-row-presentation";
import { TodoTrack } from "./todo-track";
import s from "./status-row.module.css";

export interface ComposerStatusRowProps {
  /** 没有会话 id 时不显示后台任务 */
  agentId: string | undefined;
  subagents: readonly ProviderSubagentDescriptor[];
  openSubagentId: string | null;
  onOpenSubagent: (subagentId: string) => void;
  backgroundTasks: readonly AgentBackgroundTask[];
  openTaskId: string | null;
  onOpenTask: (taskId: string) => void;
  todos: readonly TodoStep[] | undefined;
  busy: boolean;
  rateLimits: AgentRateLimits | undefined;
  usage: AgentUsage | undefined;
}

/** 至少有一个芯片有内容 */
export function hasStatusRowContent(
  props: Pick<
    ComposerStatusRowProps,
    "agentId" | "subagents" | "backgroundTasks" | "todos" | "rateLimits" | "usage" | "busy"
  >,
): boolean {
  return (
    selectSubagentsAtLevel(props.subagents, null).length > 0 ||
    (Boolean(props.agentId) && props.backgroundTasks.length > 0) ||
    (props.todos?.length ?? 0) > 0 ||
    (props.rateLimits?.windows.length ?? 0) > 0 ||
    speedChipState(props.usage, props.busy) !== null
  );
}

export function ComposerStatusRow(props: ComposerStatusRowProps) {
  if (!hasStatusRowContent(props)) return null;
  return (
    <div className={s.row} data-testid="composer-status-row">
      <SubagentTrack
        subagents={props.subagents}
        parentSubagentId={null}
        onOpen={props.onOpenSubagent}
        activeSubagentId={props.openSubagentId}
      />
      {props.agentId ? (
        <BackgroundTaskTrack
          key={props.agentId}
          agentId={props.agentId}
          tasks={props.backgroundTasks}
          onOpen={props.onOpenTask}
          activeTaskId={props.openTaskId}
        />
      ) : null}
      <TodoTrack items={props.todos} busy={props.busy} />
      <RateLimitTrack rateLimits={props.rateLimits} />
      <OutputSpeedChip usage={props.usage} busy={props.busy} />
    </div>
  );
}
