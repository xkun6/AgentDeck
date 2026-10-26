import { Fragment, useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useNavigate, useLocation } from "react-router-dom";
import { StatusDot, type StatusDotTone } from "@agentdeck/shared-ui";
import type { AgentGroup, AgentSnapshot } from "@agentdeck/protocol";
import {
  BarChart3,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  History,
  MessagesSquare,
  PanelLeftClose,
  Plus,
  Search,
  Settings,
  SquarePen,
  TerminalSquare,
  Trash2,
  Users,
  type LucideIcon,
} from "lucide-react";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import { agentListAtom, sidecarConnectionAtom } from "@/stores/agents";
import { groupListAtom } from "@/stores/groups";
import { appSidebarVisibleAtom } from "@/stores/ui";
import { GROUP_STATUS_LABELS } from "@/lib/group-display";
import {
  buildSessionTree,
  flattenSessionTree,
  groupSessionRoots,
  sidebarSessions,
  treeSome,
  type SessionTreeRow,
} from "@/lib/session-list";
import { useAgentProviders } from "@/hooks/use-agent-catalog";
import { useDeleteAgentSession } from "@/hooks/use-delete-agent-session";
import {
  AGENT_STATUS_LABELS,
  agentDisplayTitle,
  agentProviderLabel,
  formatAgentTime,
  isAgentRunning,
} from "@/lib/agent-session-display";
import {
  normalizeWorkspacePath,
  readPinnedWorkspaceProjectPaths,
  readSessionWorkspaceMap,
  readWorkspaceProjects,
  rememberWorkspaceProject,
  subscribeWorkspaceChanges,
  unpinWorkspaceProjects,
  workspaceNameFromPath,
  type WorkspaceProject,
} from "@/lib/workspaces";
import { readUiValue, writeUiValue } from "@/lib/ui-store";
import type { SidecarConnectionState } from "@/lib/sidecar-client";
import { useProjectActions, useSessionActions } from "@/hooks/use-context-actions";
import { useWorktreeProjects, worktreePathKey } from "@/hooks/use-worktree-projects";
import { useCommandPalette } from "@/components/command-palette";
import { commandPaletteShortcutLabel } from "@/lib/command-palette-shortcut";
import { EntityContextMenu, type ContextMenuEntry } from "@/components/context-menu/entity-context-menu";
import s from "./sidebar.module.css";

function statusTone(agent: AgentSnapshot, running: boolean): StatusDotTone | null {
  if (running) return "success";
  if (agent.status === "error") return "danger";
  return null;
}

/** Agent 服务未连通时才在侧栏底部提示，连通时不占位。 */
const CONNECTION_HINTS: Partial<Record<SidecarConnectionState, { label: string; tone: StatusDotTone }>> = {
  idle: { label: "Agent 服务未连接", tone: "warning" },
  connecting: { label: "正在连接 Agent 服务", tone: "warning" },
  closed: { label: "Agent 服务已断开", tone: "danger" },
  error: { label: "Agent 服务连接失败", tone: "danger" },
};

interface NavEntry {
  label: string;
  path: string;
  icon: LucideIcon;
}

const NAV_ENTRIES: readonly NavEntry[] = [
  { label: "对话历史", path: "/history", icon: History },
  { label: "工作空间", path: "/projects", icon: Folder },
  { label: "终端", path: "/console", icon: TerminalSquare },
  { label: "用量统计", path: "/usage", icon: BarChart3 },
  { label: "自动化", path: "/automation", icon: CalendarClock },
];

interface SessionRowProps {
  title: string;
  tone: StatusDotTone | null;
  active: boolean;
  time: string;
  tooltip: string;
  /** 子会话缩进层级（design.md 4.26），0 = 顶层 */
  depth?: number;
  /** 有子会话时显示折叠按钮 */
  childCount?: number;
  collapsed?: boolean;
  onToggle?: () => void;
  onClick: () => void;
  onDelete: () => void;
  menuItems: () => ContextMenuEntry[];
}

function SessionRow({
  title,
  tone,
  active,
  time,
  tooltip,
  depth = 0,
  childCount = 0,
  collapsed = false,
  onToggle,
  onClick,
  onDelete,
  menuItems,
}: SessionRowProps) {
  return (
    <EntityContextMenu items={menuItems}>
      <div
        className={s.row}
        data-active={active ? "true" : undefined}
        data-depth={depth > 0 ? depth : undefined}
        style={depth > 0 ? ({ "--session-depth": depth } as CSSProperties) : undefined}
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onClick();
          }
        }}
        title={tooltip}
      >
        {childCount > 0 ? (
          <button
            type="button"
            className={s.rowToggle}
            aria-label={collapsed ? `展开子会话：${title}` : `折叠子会话：${title}`}
            aria-expanded={!collapsed}
            onClick={(event) => {
              event.stopPropagation();
              onToggle?.();
            }}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {collapsed ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
          </button>
        ) : (
          <span className={s.rowLead}>{tone ? <StatusDot tone={tone} size="xs" /> : null}</span>
        )}
        <span className={s.rowTitle}>{title}</span>
        {childCount > 0 && collapsed ? <span className={s.rowCount}>+{childCount}</span> : null}
        <span className={s.rowTrail}>
          <span className={s.rowTime}>{time}</span>
          <button
            type="button"
            className={s.rowAction}
            aria-label={`删除会话：${title}`}
            title="删除会话"
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <Trash2 size={14} aria-hidden="true" />
          </button>
        </span>
      </div>
    </EntityContextMenu>
  );
}

type SidebarItem =
  | { kind: "rows"; rows: SessionTreeRow<AgentSnapshot>[] }
  | {
      kind: "group";
      group: AgentGroup;
      memberCount: number;
      collapsed: boolean;
      /** 组内会话行（depth 已整体加 1） */
      rows: SessionTreeRow<AgentSnapshot>[];
    };

function groupCollapseKey(groupId: string): string {
  return `group:${groupId}`;
}

/** 不属于任何已记住项目的会话（项目已删除，或 cwd 不在任何项目及其 worktree 里）归到这一桶，排在最后。 */
const OTHER_BUCKET_KEY = "";
/** 每个项目默认最多显示的会话块数，其余收进「显示更多」。 */
const PROJECT_ITEM_LIMIT = 8;
const COLLAPSED_PROJECTS_STORAGE_KEY = "agentdeck-cn-ui.sidebarCollapsedProjects";

function readCollapsedProjects(): ReadonlySet<string> {
  const raw = readUiValue<unknown>(COLLAPSED_PROJECTS_STORAGE_KEY, []);
  return new Set(Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : []);
}

interface ProjectBucket {
  key: string;
  /** null = 「其他对话」桶 */
  project: WorkspaceProject | null;
  /** 运行中的块在前，其余保持会话列表顺序 */
  items: SidebarItem[];
  running: boolean;
}

function itemContains(item: SidebarItem, agentId: string | null): boolean {
  return agentId !== null && item.rows.some((row) => row.agent.id === agentId);
}

interface ProjectRowProps {
  name: string;
  tooltip: string;
  icon: LucideIcon;
  collapsed: boolean;
  running: boolean;
  onToggle: () => void;
  onNewChat?: () => void;
  menuItems?: () => ContextMenuEntry[];
}

/** 项目节点：点击折叠 / 展开其下会话；折叠时有运行中的会话显示状态点，悬停出现「新建对话」。 */
function ProjectRow({ name, tooltip, icon: Icon, collapsed, running, onToggle, onNewChat, menuItems }: ProjectRowProps) {
  const row = (
    <div
      className={s.projectRow}
      role="button"
      tabIndex={0}
      aria-expanded={!collapsed}
      aria-label={collapsed ? `展开项目：${name}` : `折叠项目：${name}`}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onToggle();
        }
      }}
      title={tooltip}
    >
      <span className={s.itemIcon}>
        <Icon size={16} aria-hidden="true" />
      </span>
      <span className={s.rowTitle}>{name}</span>
      {collapsed && running ? (
        <span className={s.projectDot}>
          <StatusDot tone="success" size="xs" />
        </span>
      ) : null}
      {onNewChat ? (
        <button
          type="button"
          className={s.rowAction}
          aria-label={`在「${name}」中新建对话`}
          title="新建对话"
          onClick={(event) => {
            event.stopPropagation();
            onNewChat();
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <SquarePen size={14} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
  return menuItems ? <EntityContextMenu items={menuItems}>{row}</EntityContextMenu> : row;
}

interface GroupRowProps {
  title: string;
  tooltip: string;
  memberCount: number;
  active: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onClick: () => void;
}

/** 协作组节点（design.md 4.27）：点击进入协作视图，左侧箭头折叠 / 展开组内会话。 */
function GroupRow({ title, tooltip, memberCount, active, collapsed, onToggle, onClick }: GroupRowProps) {
  return (
    <div
      className={s.row}
      data-active={active ? "true" : undefined}
      data-group="true"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
      title={tooltip}
    >
      <button
        type="button"
        className={s.rowToggle}
        aria-label={collapsed ? `展开协作组：${title}` : `折叠协作组：${title}`}
        aria-expanded={!collapsed}
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {collapsed ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
      </button>
      <span className={s.rowLead}>
        <Users size={14} aria-hidden="true" />
      </span>
      <span className={s.rowTitle}>{title}</span>
      <span className={s.rowCount}>{memberCount}</span>
    </div>
  );
}

export function WorkbenchSidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);
  const agents = useAtomValue(agentListAtom);
  const connection = useAtomValue(sidecarConnectionAtom);
  const setSidebarVisible = useSetAtom(appSidebarVisibleAtom);
  const { openCommandPalette } = useCommandPalette();
  const { data: providers } = useAgentProviders();
  const deleteSession = useDeleteAgentSession();
  const sessionActions = useSessionActions();
  const projectActions = useProjectActions();
  const [projects, setProjects] = useState<WorkspaceProject[]>(readWorkspaceProjects);
  const [pinnedProjectPaths, setPinnedProjectPaths] = useState(readPinnedWorkspaceProjectPaths);
  const [sessionWorkspaceMap, setSessionWorkspaceMap] = useState(readSessionWorkspaceMap);

  useEffect(
    () =>
      subscribeWorkspaceChanges(() => {
        setProjects(readWorkspaceProjects());
        setPinnedProjectPaths(readPinnedWorkspaceProjectPaths());
        setSessionWorkspaceMap(readSessionWorkspaceMap());
      }),
    [],
  );

  const now = new Date();

  // 会话按项目分组（design.md 4.17）：agent.list 已按 updatedAt 倒序；不显示已归档的，置顶的排在最前。
  // 运行中 = sidecar 报 running/starting 或本地仍在流式输出，项目内运行中的块排在前面。
  // 子会话（design.md 4.26）缩进显示在父会话下，随父会话归入项目，整块按「自身或任一子孙在运行」算运行中。
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() => new Set());
  const toggleCollapsed = useCallback((id: string) => {
    setCollapsedIds((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  // 协作组（design.md 4.27）：同组会话聚在一个可折叠节点下（组节点的折叠状态以 `group:<id>` 记在同一个集合里），
  // 与子会话树兼容——根会话带着它的子会话一起进组；整组按协作组的 cwd 归入项目（成员可能在各自的 worktree 里）。
  const groups = useAtomValue(groupListAtom);
  // cwd 在某个项目的 git worktree 里的会话（看板任务、委派等）按仓库归回该项目。
  const projectPaths = useMemo(() => projects.map((project) => project.path), [projects]);
  const unmatchedCwds = useMemo(() => {
    const known = new Set(projectPaths);
    return sidebarSessions(agents)
      .map((agent) => normalizeWorkspacePath(agent.cwd || sessionWorkspaceMap[agent.id]))
      .filter((path) => path && !known.has(path));
  }, [agents, projectPaths, sessionWorkspaceMap]);
  const worktreeProjects = useWorktreeProjects(projectPaths, unmatchedCwds);
  const buckets = useMemo<ProjectBucket[]>(() => {
    const groupById = new Map(groups.map((group) => [group.id, group]));
    const projectByPath = new Map(projects.map((project) => [project.path, project]));
    const byKey = new Map<string, { running: SidebarItem[]; idle: SidebarItem[]; activity: number }>();
    const bucketOf = (key: string) => {
      let bucket = byKey.get(key);
      if (!bucket) {
        bucket = { running: [], idle: [], activity: 0 };
        byKey.set(key, bucket);
      }
      return bucket;
    };
    const blocks = groupSessionRoots(buildSessionTree(sidebarSessions(agents)), new Set(groupById.keys()));
    for (const block of blocks) {
      const running = block.roots.some((root) =>
        treeSome(root, (agent) => isAgentRunning(agent, runtimeBySession[agent.id])),
      );
      const rows = block.roots.flatMap((root) => flattenSessionTree(root, (agent) => agent.id, collapsedIds));
      const group = block.groupId !== null ? groupById.get(block.groupId) : undefined;
      const item: SidebarItem = group
        ? {
            kind: "group",
            group,
            memberCount: block.roots.length,
            collapsed: collapsedIds.has(groupCollapseKey(group.id)),
            rows: rows.map((row) => ({ ...row, depth: row.depth + 1 })),
          }
        : { kind: "rows", rows };
      const lead = block.roots[0].agent;
      const path = normalizeWorkspacePath(group?.cwd || lead.cwd || sessionWorkspaceMap[lead.id]);
      const projectPath = projectByPath.has(path) ? path : worktreeProjects.get(worktreePathKey(path));
      const bucket = bucketOf(projectPath ?? OTHER_BUCKET_KEY);
      (running ? bucket.running : bucket.idle).push(item);
      bucket.activity = Math.max(bucket.activity, ...block.roots.map((root) => root.agent.updatedAt));
    }

    // 置顶项目在前，其余按最近活动（会话更新或选用该工作区）倒序；没有会话的项目也显示。
    const projectBuckets = projects.map((project) => {
      const bucket = bucketOf(project.path);
      return {
        key: project.path,
        project,
        items: [...bucket.running, ...bucket.idle],
        running: bucket.running.length > 0,
        pinned: pinnedProjectPaths.has(project.path),
        activity: Math.max(bucket.activity, project.updatedAt),
      };
    });
    projectBuckets.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.activity - a.activity);
    const result: ProjectBucket[] = projectBuckets;
    const other = byKey.get(OTHER_BUCKET_KEY);
    if (other) {
      result.push({
        key: OTHER_BUCKET_KEY,
        project: null,
        items: [...other.running, ...other.idle],
        running: other.running.length > 0,
      });
    }
    return result;
  }, [
    agents,
    collapsedIds,
    groups,
    pinnedProjectPaths,
    projects,
    runtimeBySession,
    sessionWorkspaceMap,
    worktreeProjects,
  ]);

  const [collapsedProjects, setCollapsedProjects] = useState(readCollapsedProjects);
  const toggleProject = useCallback((key: string) => {
    setCollapsedProjects((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      writeUiValue(COLLAPSED_PROJECTS_STORAGE_KEY, Array.from(next));
      return next;
    });
  }, []);
  const [expandedProjects, setExpandedProjects] = useState<ReadonlySet<string>>(() => new Set());
  const toggleProjectExpanded = useCallback((key: string) => {
    setExpandedProjects((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  const addProject = async () => {
    const result = await window.agentdeckDesktop?.pickDirectory?.();
    const path = result && !result.canceled ? result.paths[0] : undefined;
    const project = path ? rememberWorkspaceProject(path) : null;
    if (project) projectActions.newChat(project);
  };

  const projectNameByPath = useMemo(
    () => new Map(projects.map((project) => [project.path, project.name])),
    [projects],
  );

  useEffect(() => {
    if (pinnedProjectPaths.size === 0) return;
    const livePaths = new Set(projects.map((project) => project.path));
    const stalePaths = Array.from(pinnedProjectPaths).filter((path) => !livePaths.has(path));
    if (stalePaths.length > 0) setPinnedProjectPaths(unpinWorkspaceProjects(stalePaths));
  }, [pinnedProjectPaths, projects]);

  const goSession = sessionActions.openSession;

  const activeSessionId = location.pathname.startsWith("/tasks/")
    ? decodeURIComponent(location.pathname.slice("/tasks/".length))
    : null;

  const renderRow = ({ agent, depth, childCount, collapsed }: SessionTreeRow<AgentSnapshot>) => {
    const running = isAgentRunning(agent, runtimeBySession[agent.id]);
    const title = agentDisplayTitle(agent, runtimeBySession[agent.id], providers);
    const provider = agentProviderLabel(agent.provider, providers);
    const status = running ? AGENT_STATUS_LABELS.running : AGENT_STATUS_LABELS[agent.status];
    const projectName = projectNameByPath.get(agent.cwd) ?? workspaceNameFromPath(agent.cwd);
    return (
      <SessionRow
        key={agent.id}
        title={title}
        tone={statusTone(agent, running)}
        active={agent.id === activeSessionId}
        time={formatAgentTime(agent.updatedAt, now)}
        tooltip={`${title}\n${provider}，${status}\n${projectName}：${agent.cwd}`}
        depth={depth}
        childCount={childCount}
        collapsed={collapsed}
        onToggle={() => toggleCollapsed(agent.id)}
        onClick={() => goSession(agent)}
        onDelete={() => void deleteSession(agent, title)}
        menuItems={() => sessionActions.buildMenu(agent, title)}
      />
    );
  };

  const renderItem = (item: SidebarItem) => {
    if (item.kind === "rows") return item.rows.map(renderRow);
    const { group } = item;
    const target = `/groups/${encodeURIComponent(group.id)}`;
    return (
      <Fragment key={`group:${group.id}`}>
        <GroupRow
          title={group.title}
          tooltip={`${group.title}\n协作组，${GROUP_STATUS_LABELS[group.status]}，${item.memberCount} 个会话`}
          memberCount={item.memberCount}
          active={location.pathname === target}
          collapsed={item.collapsed}
          onToggle={() => toggleCollapsed(groupCollapseKey(group.id))}
          onClick={() => navigate(target)}
        />
        {item.collapsed ? null : item.rows.map(renderRow)}
      </Fragment>
    );
  };

  const renderBucket = (bucket: ProjectBucket) => {
    const { key, project, items } = bucket;
    const name = project ? project.name : "其他对话";
    const collapsed = collapsedProjects.has(key);
    const expanded = expandedProjects.has(key);
    // 超出上限的收进「显示更多」，但当前打开的会话始终可见
    const visible = expanded
      ? items
      : items.filter((item, index) => index < PROJECT_ITEM_LIMIT || itemContains(item, activeSessionId));
    const hiddenCount = items.length - visible.length;
    return (
      <div key={key || "other"} className={s.project}>
        <ProjectRow
          name={name}
          tooltip={project ? `${project.name}\n${project.path}` : "不属于任何项目的对话"}
          icon={project ? (collapsed ? Folder : FolderOpen) : MessagesSquare}
          collapsed={collapsed}
          running={bucket.running}
          onToggle={() => toggleProject(key)}
          onNewChat={project ? () => projectActions.newChat(project) : undefined}
          menuItems={project ? () => projectActions.buildMenu(project) : undefined}
        />
        {collapsed ? null : (
          <>
            {items.length === 0 ? <div className={s.projectEmpty}>暂无对话</div> : visible.map(renderItem)}
            {hiddenCount > 0 || (expanded && items.length > PROJECT_ITEM_LIMIT) ? (
              <button type="button" className={s.more} onClick={() => toggleProjectExpanded(key)}>
                {expanded ? "收起" : `显示更多（${hiddenCount}）`}
              </button>
            ) : null}
          </>
        )}
      </div>
    );
  };

  const canAddProject = Boolean(window.agentdeckDesktop?.pickDirectory);
  const connectionHint = CONNECTION_HINTS[connection];

  return (
    <aside className={s.sidebar} aria-label="工作台侧栏">
      <div className={s.dragRow} data-tauri-drag-region="deep">
        <button
          type="button"
          className={s.iconBtn}
          aria-label="隐藏侧边栏"
          aria-controls="app-sidebar"
          aria-expanded="true"
          title="隐藏侧边栏"
          onClick={() => setSidebarVisible(false)}
        >
          <PanelLeftClose size={16} />
        </button>
      </div>

      <div className={s.brandRow}>
        <span className={s.brand}>AgentDeck</span>
        <button
          type="button"
          className={s.iconBtn}
          aria-label="搜索"
          title={`搜索命令、会话与文件（${commandPaletteShortcutLabel()}）`}
          onClick={openCommandPalette}
        >
          <Search size={16} />
        </button>
      </div>

      <nav className={s.nav} aria-label="主导航">
        <button
          type="button"
          className={s.item}
          data-active={location.pathname === "/" ? "true" : undefined}
          onClick={() => navigate("/")}
        >
          <span className={s.itemIcon}>
            <SquarePen size={16} />
          </span>
          <span className={s.itemLabel}>新建对话</span>
        </button>
        {NAV_ENTRIES.map((entry) => {
          const Icon = entry.icon;
          return (
            <button
              key={entry.path}
              type="button"
              className={s.item}
              data-active={location.pathname.startsWith(entry.path) ? "true" : undefined}
              onClick={() => navigate(entry.path)}
            >
              <span className={s.itemIcon}>
                <Icon size={16} />
              </span>
              <span className={s.itemLabel}>{entry.label}</span>
            </button>
          );
        })}
      </nav>

      <div className={s.scrollY}>
        <section className={s.section}>
          <div className={s.sectionLabel}>
            <span className={s.sectionLabelText}>项目</span>
            {canAddProject ? (
              <button
                type="button"
                className={s.sectionAction}
                aria-label="添加项目"
                title="添加项目"
                onClick={() => void addProject()}
              >
                <Plus size={14} aria-hidden="true" />
              </button>
            ) : null}
          </div>
          {buckets.length === 0 ? <div className={s.empty}>暂无会话</div> : buckets.map(renderBucket)}
        </section>
      </div>

      <div className={s.footer}>
        {connectionHint ? (
          <div className={s.connection} role="status">
            <StatusDot tone={connectionHint.tone} size="xs" />
            <span>{connectionHint.label}</span>
          </div>
        ) : null}
        <button type="button" className={s.item} onClick={() => navigate("/common")}>
          <span className={s.itemIcon}>
            <Settings size={16} />
          </span>
          <span className={s.itemLabel}>设置</span>
        </button>
      </div>
    </aside>
  );
}
