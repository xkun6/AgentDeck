import { useEffect, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useNavigate, useLocation } from "react-router-dom";
import { StatusDot, type StatusDotTone } from "@agentdeck/shared-ui";
import type { AgentSnapshot } from "@agentdeck/protocol";
import { Folder, MessageSquare, Plus } from "lucide-react";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import { agentListAtom } from "@/stores/agents";
import { activeSessionIdAtom } from "@/stores/ui";
import { useAgentProviders } from "@/hooks/use-agent-catalog";
import {
  AGENT_STATUS_LABELS,
  agentDisplayTitle,
  agentProviderLabel,
  formatAgentTime,
  isAgentRunning,
} from "@/lib/agent-session-display";
import {
  readPinnedWorkspaceProjectPaths,
  readWorkspaceProjects,
  subscribeWorkspaceChanges,
  unpinWorkspaceProjects,
  workspaceNameFromPath,
  type WorkspaceProject,
} from "@/lib/workspaces";
import s from "./workbench-sidebar.module.css";

function sectionLabel(index: number, label: string): string {
  return `§${index.toString().padStart(2, "0")} · ${label}`;
}

function KanbanQuickIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.2" y="2.4" width="11.6" height="11.2" rx="0" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 4.8v6.4M10 4.8v6.4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      <rect x="3.8" y="4.5" width="2.2" height="3" rx="0" fill="currentColor" opacity="0.8" />
      <rect x="6.9" y="4.5" width="2.2" height="4.8" rx="0" fill="currentColor" opacity="0.58" />
      <rect x="10" y="4.5" width="2.2" height="2.6" rx="0" fill="currentColor" opacity="0.72" />
    </svg>
  );
}

function statusTone(agent: AgentSnapshot, running: boolean): StatusDotTone | null {
  if (running) return "success";
  if (agent.status === "error") return "danger";
  if (agent.status === "closed") return null;
  return "warning";
}

interface SessionRowProps {
  title: string;
  tone: StatusDotTone | null;
  active: boolean;
  meta: string;
  projectName?: string;
  tooltip: string;
  onClick: () => void;
}

function SessionRow({ title, tone, active, meta, projectName, tooltip, onClick }: SessionRowProps) {
  return (
    <div
      className={s.sessionRow}
      data-active={active ? "true" : undefined}
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
      <div className={s.rowMain}>
        <div className={s.ttl}>
          {tone ? <StatusDot tone={tone} size="xs" /> : <span className={s.dotPlaceholder} />}
          <span className={s.ttlText}>{title}</span>
        </div>
        <div className={s.meta}>
          <span className={s.metaText}>{meta}</span>
          {projectName ? (
            <span className={s.metaProject} title={projectName}>
              {projectName}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function WorkbenchSidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const setActiveId = useSetAtom(activeSessionIdAtom);
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);
  const agents = useAtomValue(agentListAtom);
  const { data: providers } = useAgentProviders();
  const [projects, setProjects] = useState<WorkspaceProject[]>(readWorkspaceProjects);
  const [pinnedProjectPaths, setPinnedProjectPaths] = useState(readPinnedWorkspaceProjectPaths);

  useEffect(
    () =>
      subscribeWorkspaceChanges(() => {
        setProjects(readWorkspaceProjects());
        setPinnedProjectPaths(readPinnedWorkspaceProjectPaths());
      }),
    [],
  );

  const now = new Date();

  // agent.list 已按 updatedAt 倒序；进行中 = sidecar 报 running/starting 或本地仍在流式输出。
  const { active, recent } = useMemo(() => {
    const activeList: AgentSnapshot[] = [];
    const recentList: AgentSnapshot[] = [];
    for (const agent of agents) {
      if (isAgentRunning(agent, runtimeBySession[agent.id])) activeList.push(agent);
      else recentList.push(agent);
    }
    return { active: activeList, recent: recentList };
  }, [agents, runtimeBySession]);

  const pinnedProjects = useMemo(
    () => {
      const projectByPath = new Map(projects.map((project) => [project.path, project]));
      return Array.from(pinnedProjectPaths).flatMap((path) => {
        const project = projectByPath.get(path);
        return project ? [project] : [];
      });
    },
    [pinnedProjectPaths, projects],
  );

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

  const goSession = (agent: AgentSnapshot) => {
    setActiveId(agent.id);
    navigate(`/tasks/${encodeURIComponent(agent.id)}`);
  };

  const activeSessionId = location.pathname.startsWith("/tasks/")
    ? decodeURIComponent(location.pathname.slice("/tasks/".length))
    : null;

  const renderRow = (agent: AgentSnapshot, running: boolean) => {
    const title = agentDisplayTitle(agent, runtimeBySession[agent.id], providers);
    const provider = agentProviderLabel(agent.provider, providers);
    const status = running ? AGENT_STATUS_LABELS.running : AGENT_STATUS_LABELS[agent.status];
    return (
      <SessionRow
        key={agent.id}
        title={title}
        tone={statusTone(agent, running)}
        active={agent.id === activeSessionId}
        meta={`${provider} · ${status} · ${formatAgentTime(agent.updatedAt, now)}`}
        projectName={projectNameByPath.get(agent.cwd) ?? workspaceNameFromPath(agent.cwd)}
        tooltip={`${title}\n${provider} · ${status}\n${agent.cwd}`}
        onClick={() => goSession(agent)}
      />
    );
  };

  return (
    <aside className={s.sidebar}>
      <button type="button" className={s.newTask} onClick={() => navigate("/")}>
        <span className={s.newTaskLead}>
          <span className={s.entryIcon}>
            <Plus size={16} strokeWidth={2.2} />
          </span>
          <span className={s.entryLabel}>新建对话</span>
        </span>
      </button>

      <div className={s.quickNav}>
        <button
          type="button"
          className={s.quickNavButton}
          data-active={location.pathname.startsWith("/history") ? "true" : undefined}
          onClick={() => navigate("/history")}
        >
          <span className={s.entryIcon}>
            <MessageSquare size={16} />
          </span>
          <span className={s.entryLabel}>对话历史</span>
          <span className={s.entryCommand}>/history</span>
        </button>
        <button
          type="button"
          className={s.quickNavButton}
          data-active={location.pathname.startsWith("/projects") ? "true" : undefined}
          onClick={() => navigate("/projects")}
        >
          <span className={s.entryIcon}>
            <Folder size={16} />
          </span>
          <span className={s.entryLabel}>工作空间</span>
          <span className={s.entryCommand}>/workspace</span>
        </button>
        <button
          type="button"
          className={s.quickNavButton}
          data-active={location.pathname.startsWith("/kanban") ? "true" : undefined}
          onClick={() => navigate("/kanban")}
        >
          <span className={s.entryIcon}>
            <KanbanQuickIcon />
          </span>
          <span className={s.entryLabel}>看板</span>
          <span className={s.entryCommand}>/kanban</span>
        </button>
      </div>

      <div className={s.scrollY}>
        <section className={s.section}>
          <div className={s.label}>
            <span>{sectionLabel(1, "进行中")}</span>
            <span className={s.labelNum}>✕✕</span>
          </div>
          {active.length === 0 ? (
            <div className={s.empty}>暂无运行任务</div>
          ) : (
            active.map((agent) => renderRow(agent, true))
          )}
        </section>

        <section className={s.section}>
          <div className={s.label}>
            <span>{sectionLabel(2, "置顶项目")}</span>
            <span className={s.labelNum}>✕✕</span>
          </div>
          {pinnedProjects.length === 0 ? (
            <button
              type="button"
              className={s.sideItem}
              onClick={() => navigate("/projects")}
            >
              <span className={s.sideItemIcon}>
                <Folder size={16} />
              </span>
              <span className={s.sideItemLabel}>暂无置顶项目</span>
            </button>
          ) : (
            pinnedProjects.map((proj) => {
              const target = `/projects/${encodeURIComponent(proj.path)}`;
              return (
                <button
                  type="button"
                  key={proj.path}
                  className={s.sideItem}
                  data-active={location.pathname === target ? "true" : undefined}
                  onClick={() => navigate(target)}
                  title={proj.path}
                >
                  <span className={s.sideItemIcon}>
                    <Folder size={16} />
                  </span>
                  <span className={s.sideItemLabel}>{proj.name}</span>
                </button>
              );
            })
          )}
        </section>

        <section className={s.section}>
          <div className={s.label}>
            <span>{sectionLabel(3, "最近对话")}</span>
            <span className={s.labelNum}>✕✕</span>
          </div>
          {recent.length === 0 ? (
            <div className={s.empty}>暂无最近会话</div>
          ) : (
            recent.map((agent) => renderRow(agent, false))
          )}
        </section>
      </div>
    </aside>
  );
}
