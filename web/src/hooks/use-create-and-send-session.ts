import { useCallback } from "react";
import { useSetAtom } from "jotai";
import { useNavigate } from "react-router-dom";
import type { ComposerSubmitPayload } from "@/components/chat/composer-types";
import { useAgentSession } from "@/hooks/use-agent-session";
import { prepareAgentPrompt } from "@/lib/agent-prompt";
import type { AgentSelection } from "@/lib/agent-selection";
import { titleFromPrompt } from "@/lib/session-title";
import { rememberSessionWorkspace, rememberWorkspaceProject } from "@/lib/workspaces";
import { activeSessionIdAtom } from "@/stores/ui";

export const WORKSPACE_REQUIRED_MESSAGE = "请先选择工作区：Agent 需要在一个工作目录中运行";
export const PROVIDER_REQUIRED_MESSAGE = "请先选择一个可用的 Agent";

/**
 * 新建会话主链路：agent.create → 写入乐观消息并跳转对话页 → agent.send。
 * 返回新 agentId；发送失败由 sendPrompt 写入会话错误提示，不阻塞跳转。
 */
export function useCreateAndSendSession() {
  const navigate = useNavigate();
  const actions = useAgentSession();
  const setActiveSessionId = useSetAtom(activeSessionIdAtom);

  return useCallback(async (
    payload: ComposerSubmitPayload,
    selection: AgentSelection,
    translation?: boolean,
  ): Promise<string> => {
    const cwd = payload.workspacePath?.trim();
    if (!cwd) throw new Error(WORKSPACE_REQUIRED_MESSAGE);
    if (!selection.provider) throw new Error(PROVIDER_REQUIRED_MESSAGE);

    const prepared = await prepareAgentPrompt(payload);
    const title = titleFromPrompt(payload.text || payload.attachments[0]?.name || "");
    const agent = await actions.createSession({
      provider: selection.provider,
      cwd,
      ...(selection.model ? { model: selection.model } : {}),
      ...(selection.modeId ? { modeId: selection.modeId } : {}),
      ...(selection.thinkingOptionId ? { thinkingOptionId: selection.thinkingOptionId } : {}),
      ...(title ? { title } : {}),
      ...(translation !== undefined ? { translation } : {}),
    });

    rememberWorkspaceProject(cwd);
    rememberSessionWorkspace(agent.id, cwd);

    const sending = actions.sendPrompt(agent.id, prepared.prompt, {
      displayText: prepared.displayText,
      displayImages: prepared.displayImages,
    });
    setActiveSessionId(agent.id);
    navigate(`/tasks/${encodeURIComponent(agent.id)}`);
    sending.catch((error) => {
      console.error("发送首条消息失败：", error);
    });
    return agent.id;
  }, [actions, navigate, setActiveSessionId]);
}
