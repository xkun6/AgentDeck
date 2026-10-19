// 会话 / 项目的共用动作与右键菜单项构造。
// 右键菜单与「⋯」菜单共用这里的动作，避免逻辑复制。
import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useSetAtom, useStore } from "jotai";
import {
  Archive,
  ArchiveRestore,
  Camera,
  Check,
  Copy,
  ExternalLink,
  FileJson,
  FileText,
  FolderOpen,
  GitFork,
  HeartPulse,
  MessageSquarePlus,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Power,
  Repeat,
  Timer,
  Plug,
  Trash2,
} from "lucide-react";
import type { AgentSnapshot } from "@agentdeck/protocol";
import type { ContextMenuEntry } from "@/components/context-menu/entity-context-menu";
import { useAgentProviders } from "@/hooks/use-agent-catalog";
import { humanizeSidecarError, isInactiveAgent, useAgentSession } from "@/hooks/use-agent-session";
import { useDeleteAgentSession } from "@/hooks/use-delete-agent-session";
import { useExportSession } from "@/hooks/use-export-session";
import { activeSessionIdAtom, rightRailVisibleAtom } from "@/stores/ui";
import { PREVIEW_PANEL_QUERY_KEY } from "@/lib/preview-rail";
import { scheduleDialogAtom, schedulesStateAtom } from "@/stores/schedules";
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

/**
 * 分叉会话（design.md 4.23）：成功后跳到新会话，失败用应用内提示框反馈。
 * throughSeq 缺省 = 整个会话；给出时只保留到该 seq 所在回合结束。
 */
export function useForkSession() {
  const navigate = useNavigate();
  const setActiveId = useSetAtom(activeSessionIdAtom);
  const actions = useAgentSession();
  const { confirm } = useConfirm();

  return useCallback(
    async (agentId: string, throughSeq?: number): Promise<void> => {
      try {
        const agent = await actions.forkSession(agentId, throughSeq !== undefined ? { throughSeq } : {});
        setActiveId(agent.id);
        navigate(`/tasks/${encodeURIComponent(agent.id)}`);
      } catch (error) {
        await confirm({
          title: "分叉会话失败",
          body: humanizeSidecarError(error),
          confirmLabel: "知道了",
          cancelLabel: "关闭",
        });
      }
    },
    [actions, confirm, navigate, setActiveId],
  );
}

export function useSessionActions() {
  const navigate = useNavigate();
  const setActiveId = useSetAtom(activeSessionIdAtom);
  const setRightRailVisible = useSetAtom(rightRailVisibleAtom);
  const deleteSession = useDeleteAgentSession();
  const exportSession = useExportSession();
  const forkSession = useForkSession();
  const actions = useAgentSession();
  const providers = useAgentProviders().data;
  const store = useStore();
  const setScheduleDialog = useSetAtom(scheduleDialogAtom);
  const { confirm, prompt } = useConfirm();

  /** agent.update 失败时用应用内提示框反馈。 */
  const updateSession = useCallback(
    async (
      agentId: string,
      patch: {
        title?: string | null;
        pinned?: boolean;
        archived?: boolean;
        interopTarget?: boolean;
        cacheKeepAlive?: boolean;
      },
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

  /** 回收后台进程（design.md 4.34）：有子代理 / 后台任务时先确认；失败用应用内提示框反馈。 */
  const reclaimSession = useCallback(
    async (agent: AgentSnapshot): Promise<void> => {
      if (agent.backgroundActive) {
        const confirmed = await confirm({
          title: "回收后台进程",
          body: "该会话有运行中的子代理或后台任务，回收会将其结束。确认回收？",
          confirmLabel: "回收",
          danger: true,
        });
        if (!confirmed) return;
      }
      try {
        await actions.reclaimSession(agent.id);
      } catch (error) {
        await confirm({
          title: "回收失败",
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

  /** 「快照历史」（design.md 4.24）：打开会话并在右侧预览栏显示快照面板 */
  const openSnapshotHistory = useCallback(
    (agent: Pick<AgentSnapshot, "id">) => {
      setActiveId(agent.id);
      setRightRailVisible(true);
      navigate(`/tasks/${encodeURIComponent(agent.id)}?${PREVIEW_PANEL_QUERY_KEY}=snapshots`);
    },
    [navigate, setActiveId, setRightRailVisible],
  );

  /** 打开目标循环 / 心跳弹窗（design.md 4.25）：该会话已有同类任务时直接编辑它。 */
  const openScheduleDialog = useCallback(
    (agentId: string, kind: "goal" | "heartbeat") => {
      const existing = store
        .get(schedulesStateAtom)
        .schedules.find((schedule) => schedule.kind === kind && schedule.agentId === agentId);
      setScheduleDialog(
        existing ? { kind, schedule: existing, lockKind: true } : { kind, agentId, lockKind: true },
      );
    },
    [setScheduleDialog, store],
  );

  const buildMenu = useCallback(
    (agent: AgentSnapshot, title: string): ContextMenuEntry[] => {
      const cwd = normalizeWorkspacePath(agent.cwd || readSessionWorkspaceMap()[agent.id]);
      const running = agent.status === "running" || agent.status === "starting";
      const hasProject = !!cwd && readWorkspaceProjects().some((project) => project.path === cwd);
      // provider 种类（自定义中转取 extends 的值）：缓存保活只对 Claude 类会话提供（design.md 4.36）
      const providerKind = providers?.find((provider) => provider.id === agent.provider)?.kind
        ?? (agent.provider === "claude" ? "claude" : undefined);
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
        {
          key: "fork",
          label: "分叉会话",
          icon: <GitFork size={ICON} />,
          // 整会话分叉要求原会话没有进行中的回合（design.md 4.23）
          disabled: running,
          onSelect: () => void forkSession(agent.id),
        },
        // 仅已加载的会话可回收；回合进行中或不可恢复时禁用（design.md 4.34）
        ...(isInactiveAgent(agent)
          ? []
          : [{
              key: "reclaim",
              label: "回收后台进程",
              icon: <Power size={ICON} />,
              disabled: running || agent.resumable === false,
              onSelect: () => void reclaimSession(agent),
            }]),
        {
          // 会话互通（design.md 4.26）：开启后其它会话可经 send_to_agent 向它发消息；勾选表示已开启
          key: "interop-target",
          label: "允许被其它会话调用",
          icon: agent.interopTarget ? <Check size={ICON} /> : <Plug size={ICON} />,
          onSelect: () =>
            void updateSession(
              agent.id,
              { interopTarget: !agent.interopTarget },
              agent.interopTarget ? "取消允许被其它会话调用失败" : "设置允许被其它会话调用失败",
            ),
        },
        ...(providerKind === "claude"
          ? [{
              // 缓存保活（design.md 4.36）：等待子代理 / 后台任务时每 50 分钟保活；勾选表示已开启
              key: "cache-keepalive",
              label: "缓存保活",
              icon: agent.cacheKeepAlive ? <Check size={ICON} /> : <HeartPulse size={ICON} />,
              onSelect: () =>
                void updateSession(
                  agent.id,
                  { cacheKeepAlive: !agent.cacheKeepAlive },
                  agent.cacheKeepAlive ? "关闭缓存保活失败" : "开启缓存保活失败",
                ),
            }]
          : []),
        { key: "snapshots", label: "快照历史", icon: <Camera size={ICON} />, onSelect: () => openSnapshotHistory(agent) },
        {
          key: "goal-loop",
          label: "设置目标循环…",
          icon: <Repeat size={ICON} />,
          onSelect: () => openScheduleDialog(agent.id, "goal"),
        },
        {
          key: "heartbeat",
          label: "设置心跳…",
          icon: <Timer size={ICON} />,
          onSelect: () => openScheduleDialog(agent.id, "heartbeat"),
        },
        { key: "copy-title", label: "复制会话标题", icon: <Copy size={ICON} />, onSelect: () => void copyText(title) },
        { key: "copy-id", label: "复制会话 ID", icon: <Copy size={ICON} />, onSelect: () => void copyText(agent.id) },
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
    [deleteSession, exportSession, forkSession, navigate, openScheduleDialog, openSession, openSnapshotHistory, providers, reclaimSession, renameSession, updateSession],
  );

  return { openSession, buildMenu };
}
