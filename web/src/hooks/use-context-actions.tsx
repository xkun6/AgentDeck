// 会话 / 项目的共用动作与右键菜单项构造。
// 右键菜单与「⋯」菜单共用这里的动作，避免逻辑复制。
import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useSetAtom } from "jotai";
import {
  Archive,
  ArchiveRestore,
  Copy,
  ExternalLink,
  FileJson,
  FileText,
  FolderOpen,
  MessageSquarePlus,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react";
import type { AgentSnapshot } from "@agentdeck/protocol";
import type { ContextMenuEntry } from "@/components/context-menu/entity-context-menu";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import { useDeleteAgentSession } from "@/hooks/use-delete-agent-session";
import { useExportSession } from "@/hooks/use-export-session";
import { activeSessionIdAtom } from "@/stores/ui";
import { agentProviderLabel } from "@/lib/agent-session-display";
import { useConfirm } from "@/lib/use-confirm";
import {
  isWorkspaceProjectPinned,
  normalizeWorkspacePath,
  readSessionWorkspaceMap,
  readWorkspaceProjects,
  removeWorkspaceProject,
  togglePinnedWorkspaceProject,
  type WorkspaceProject,
} from "@/lib/workspaces";

const ICON = 12;

export function isDesktopAvailable(): boolean {
  return typeof window !== "undefined" && !!window.agentdeckDesktop;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    console.error("Failed to copy:", error);
  }
}

async function openPathInExplorer(path: string): Promise<void> {
  try {
    if (window.agentdeckDesktop?.openWorkspacePath) {
      const result = await window.agentdeckDesktop.openWorkspacePath({ path });
      if (!result.ok) console.error("Failed to open project:", result.body);
    }
  } catch (error) {
    console.error("Failed to open project:", error);
  }
}

export function useProjectActions() {
  const navigate = useNavigate();
  const { confirm } = useConfirm();

  const newChat = useCallback(
    (project: WorkspaceProject) => navigate(`/?workspace=${encodeURIComponent(project.path)}`),
    [navigate],
  );
  const openDetail = useCallback(
    (project: WorkspaceProject) => navigate(`/projects/${encodeURIComponent(project.path)}`),
    [navigate],
  );
  const togglePin = useCallback(
    (project: WorkspaceProject) => togglePinnedWorkspaceProject(project.path),
    [],
  );
  const openInExplorer = useCallback((project: WorkspaceProject) => openPathInExplorer(project.path), []);
  const copyPath = useCallback((project: WorkspaceProject) => copyText(project.path), []);
  /** 确认后删除项目；返回是否已删除。 */
  const deleteProject = useCallback(
    async (project: WorkspaceProject): Promise<boolean> => {
      const confirmed = await confirm({
        title: "删除项目",
        body: `确认删除项目「${project.name}」？该工作区下的会话会被解除关联，但会话本身不会删除。`,
        confirmLabel: "删除",
        danger: true,
      });
      if (!confirmed) return false;
      removeWorkspaceProject(project.path);
      return true;
    },
    [confirm],
  );

  /** 项目右键菜单项；onDeleted 在确认删除后回调（详情页用来跳回列表）。 */
  const buildMenu = useCallback(
    (project: WorkspaceProject, onDeleted?: () => void): ContextMenuEntry[] => {
      const pinned = isWorkspaceProjectPinned(project.path);
      return [
        { key: "new-chat", label: "新对话", icon: <MessageSquarePlus size={ICON} />, onSelect: () => newChat(project) },
        { key: "detail", label: "打开项目详情", icon: <FolderOpen size={ICON} />, onSelect: () => openDetail(project) },
        {
          key: "pin",
          label: pinned ? "取消置顶" : "置顶项目",
          icon: pinned ? <PinOff size={ICON} /> : <Pin size={ICON} />,
          onSelect: () => void togglePin(project),
        },
        ...(isDesktopAvailable()
          ? [{ key: "explorer", label: "在资源管理器中打开", icon: <ExternalLink size={ICON} />, onSelect: () => void openInExplorer(project) }]
          : []),
        { key: "copy-path", label: "复制路径", icon: <Copy size={ICON} />, onSelect: () => void copyPath(project) },
        { type: "separator", key: "sep" },
        {
          key: "delete",
          label: "删除项目",
          icon: <Trash2 size={ICON} />,
          danger: true,
          onSelect: () => void deleteProject(project).then((ok) => ok && onDeleted?.()),
        },
      ];
    },
    [copyPath, deleteProject, newChat, openDetail, openInExplorer, togglePin],
  );

  return { newChat, openDetail, togglePin, openInExplorer, copyPath, deleteProject, buildMenu };
}

export function useSessionActions() {
  const navigate = useNavigate();
  const setActiveId = useSetAtom(activeSessionIdAtom);
  const deleteSession = useDeleteAgentSession();
  const exportSession = useExportSession();
  const actions = useAgentSession();
  const { confirm, prompt } = useConfirm();

  /** agent.update 失败时用应用内提示框反馈。 */
  const updateSession = useCallback(
    async (
      agentId: string,
      patch: { title?: string | null; pinned?: boolean; archived?: boolean },
      failureTitle: string,
    ): Promise<void> => {
      try {
        await actions.updateSession(agentId, patch);
      } catch (error) {
        await confirm({
          title: failureTitle,
          body: humanizeSidecarError(error),
          confirmLabel: "知道了",
          cancelLabel: "关闭",
        });
      }
    },
    [actions, confirm],
  );

  /** 重命名：弹窗输入新标题；「恢复自动标题」或保存空串 = 清除自定义标题（design.md 4.17）。 */
  const renameSession = useCallback(
    async (agent: AgentSnapshot, title: string): Promise<void> => {
      const customTitle = agent.title?.trim();
      const value = await prompt({
        title: "重命名会话",
        confirmLabel: "保存",
        input: {
          label: "会话标题",
          initialValue: customTitle || title,
          ...(customTitle ? { clearLabel: "恢复自动标题" } : {}),
        },
      });
      if (value === null) return;
      await updateSession(agent.id, { title: value.trim() === "" ? null : value }, "重命名失败");
    },
    [prompt, updateSession],
  );

  const openSession = useCallback(
    (agent: Pick<AgentSnapshot, "id">, options?: { seq?: number }) => {
      setActiveId(agent.id);
      // seq：全文搜索命中定位（design.md 4.19），详情页据此滚动到对应消息
      const query = options?.seq !== undefined ? `?seq=${options.seq}` : "";
      navigate(`/tasks/${encodeURIComponent(agent.id)}${query}`);
    },
    [navigate, setActiveId],
  );

  const buildMenu = useCallback(
    (agent: AgentSnapshot, title: string): ContextMenuEntry[] => {
      const cwd = normalizeWorkspacePath(agent.cwd || readSessionWorkspaceMap()[agent.id]);
      const running = agent.status === "running" || agent.status === "starting";
      const hasProject = !!cwd && readWorkspaceProjects().some((project) => project.path === cwd);
      return [
        { key: "open", label: "打开会话", icon: <MessageSquare size={ICON} />, onSelect: () => openSession(agent) },
        { key: "rename", label: "重命名", icon: <Pencil size={ICON} />, onSelect: () => void renameSession(agent, title) },
        {
          key: "pin",
          label: agent.pinned ? "取消置顶会话" : "置顶会话",
          icon: agent.pinned ? <PinOff size={ICON} /> : <Pin size={ICON} />,
          onSelect: () => void updateSession(agent.id, { pinned: !agent.pinned }, agent.pinned ? "取消置顶失败" : "置顶失败"),
        },
        ...(running
          ? []
          : [{
              key: "archive",
              label: agent.archived ? "取消归档" : "归档会话",
              icon: agent.archived ? <ArchiveRestore size={ICON} /> : <Archive size={ICON} />,
              onSelect: () => void updateSession(agent.id, { archived: !agent.archived }, agent.archived ? "取消归档失败" : "归档失败"),
            }]),
        { key: "copy-title", label: "复制会话标题", icon: <Copy size={ICON} />, onSelect: () => void copyText(title) },
        ...(cwd
          ? [{ key: "copy-cwd", label: "复制工作目录", icon: <Copy size={ICON} />, onSelect: () => void copyText(cwd) }]
          : []),
        ...(cwd && isDesktopAvailable()
          ? [{ key: "explorer", label: "在资源管理器中打开工作目录", icon: <ExternalLink size={ICON} />, onSelect: () => void openPathInExplorer(cwd) }]
          : []),
        {
          key: "project",
          label: "查看所属项目",
          icon: <FolderOpen size={ICON} />,
          disabled: !hasProject,
          onSelect: () => navigate(`/projects/${encodeURIComponent(cwd)}`),
        },
        { type: "separator", key: "sep-export" },
        { key: "export-json", label: "导出为 JSON", icon: <FileJson size={ICON} />, onSelect: () => void exportSession(agent, title, "json", agentProviderLabel(agent.provider)) },
        { key: "export-markdown", label: "导出为 Markdown", icon: <FileText size={ICON} />, onSelect: () => void exportSession(agent, title, "markdown", agentProviderLabel(agent.provider)) },
        { type: "separator", key: "sep" },
        {
          key: "delete",
          label: "删除会话",
          icon: <Trash2 size={ICON} />,
          danger: true,
          onSelect: () => void deleteSession(agent, title),
        },
      ];
    },
    [deleteSession, exportSession, navigate, openSession, renameSession, updateSession],
  );

  return { openSession, buildMenu };
}
