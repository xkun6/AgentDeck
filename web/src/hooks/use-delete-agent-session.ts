// 删除会话（侧栏 / 历史页共用）：应用内确认 → agent.delete。
// 删除成功后 store 移除该会话；正在查看它的对话页由 lastRemovedAgentAtom 跳回首页。
import { useCallback } from "react";
import type { AgentSnapshot } from "@agentdeck/protocol";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import { useConfirm } from "@/lib/use-confirm";

export function useDeleteAgentSession() {
  const actions = useAgentSession();
  const { confirm } = useConfirm();

  return useCallback(
    async (agent: Pick<AgentSnapshot, "id" | "status">, title: string): Promise<boolean> => {
      const running = agent.status === "running" || agent.status === "starting";
      const confirmed = await confirm({
        title: "删除会话",
        body: `确定删除「${title}」？会话记录会从本机删除，无法恢复。${running ? "正在运行的任务会先被停止。" : ""}`,
        confirmLabel: "删除",
        danger: true,
      });
      if (!confirmed) return false;
      try {
        await actions.deleteSession(agent.id);
        return true;
      } catch (error) {
        await confirm({
          title: "删除失败",
          body: humanizeSidecarError(error),
          confirmLabel: "知道了",
          cancelLabel: "关闭",
        });
        return false;
      }
    },
    [actions, confirm],
  );
}
