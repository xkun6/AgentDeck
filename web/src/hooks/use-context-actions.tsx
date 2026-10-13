// 会话 / 项目的共用动作与右键菜单项构造。
// 右键菜单与「⋯」菜单共用这里的动作，避免逻辑复制。
import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useSetAtom } from "jotai";
import {
  Copy,
  ExternalLink,
  FolderOpen,
  MessageSquarePlus,
  MessageSquare,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react";
import type { AgentSnapshot } from "@agentdeck/protocol";
import type { ContextMenuEntry } from "@/components/context-menu/entity-context-menu";
import { useDeleteAgentSession } from "@/hooks/use-delete-agent-session";
import { activeSessionIdAtom } from "@/stores/ui";
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
  return typeof window !== "undefined" && !!window.hermesDesktop;
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
    if (window.hermesDesktop?.openWorkspacePath) {
      const result = await window.hermesDesktop.openWorkspacePath({ path });
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

  const openSession = useCallback(
    (agent: Pick<AgentSnapshot, "id">) => {
      setActiveId(agent.id);
      navigate(`/tasks/${encodeURIComponent(agent.id)}`);
    },
    [navigate, setActiveId],
  );

  const buildMenu = useCallback(
    (agent: AgentSnapshot, title: string): ContextMenuEntry[] => {
      const cwd = normalizeWorkspacePath(agent.cwd || readSessionWorkspaceMap()[agent.id]);
      const hasProject = !!cwd && readWorkspaceProjects().some((project) => project.path === cwd);
      return [
        { key: "open", label: "打开会话", icon: <MessageSquare size={ICON} />, onSelect: () => openSession(agent) },
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
    [deleteSession, navigate, openSession],
  );

  return { openSession, buildMenu };
}
