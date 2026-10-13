// 后台任务（design.md 4.15）的前端状态：按会话存放整表。
// 数据来源：进入会话时 agent.tasks.list 拉一次（重连后重拉），之后由 agent.tasks.update 整表替换。
import { atom } from "jotai";
import type { AgentBackgroundTask } from "@agentdeck/protocol";

export type BackgroundTasksByAgent = Record<string, AgentBackgroundTask[]>;

export const backgroundTasksByAgentAtom = atom<BackgroundTasksByAgent>({});

/** 用一份完整的任务表替换该会话的任务（agent.tasks.list 的结果或 agent.tasks.update 通知）。 */
export const replaceBackgroundTasksAtom = atom(
  null,
  (_get, set, params: { agentId: string; tasks: AgentBackgroundTask[] }) => {
    set(backgroundTasksByAgentAtom, (state) => ({ ...state, [params.agentId]: params.tasks }));
  },
);

/** 会话被删除：清掉它的任务。 */
export const removeAgentBackgroundTasksAtom = atom(null, (_get, set, agentId: string) => {
  set(backgroundTasksByAgentAtom, (state) => {
    if (!(agentId in state)) return state;
    const { [agentId]: _removed, ...rest } = state;
    return rest;
  });
});
