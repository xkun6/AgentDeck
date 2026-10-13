// 停止后台任务的状态（药丸列表与右侧面板共用）：停止中 / 失败文案；成功后由 agent.tasks.update 带回终态。
import { useCallback, useState } from "react";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";

export function useStopBackgroundTask(agentId: string) {
  const actions = useAgentSession();
  const [stopping, setStopping] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const stop = useCallback(
    async (taskId: string) => {
      setStopping((current) => ({ ...current, [taskId]: true }));
      setErrors(({ [taskId]: _removed, ...rest }) => rest);
      try {
        await actions.stopBackgroundTask(agentId, taskId);
      } catch (error) {
        setStopping(({ [taskId]: _removed, ...rest }) => rest);
        setErrors((current) => ({ ...current, [taskId]: humanizeSidecarError(error) }));
      }
    },
    [actions, agentId],
  );

  return { stopping, errors, stop };
}
