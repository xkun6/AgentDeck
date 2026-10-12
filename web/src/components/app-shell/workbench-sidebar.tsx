import { useEffect, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useNavigate, useLocation } from "react-router-dom";
import { StatusDot, type StatusDotTone } from "@agentdeck/shared-ui";
import type { AgentSnapshot } from "@agentdeck/protocol";
import { Folder, MessageSquare, Plus, TerminalSquare, Trash2 } from "lucide-react";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import { agentListAtom } from "@/stores/agents";
import { activeSessionIdAtom } from "@/stores/ui";
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

function statusTone(agent: AgentSnapshot, running: boolean): StatusDotTone | null {
  if (running) return "success";
  if (agent.status === "error") return "danger";
  if (agent.status === "closed" || agent.status === "dormant") return null;
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
  onDelete: () => void;
}

function SessionRow({ title, tone, active, meta, projectName, tooltip, onClick, onDelete }: SessionRowProps) {
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
      <button
        type="button"
        className={s.rowMore}
        aria-label={`删除会话：${title}`}
        title="删除会话"
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <Trash2 size={12} aria-hidden="true" />
      </button>
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
  const deleteSession = useDeleteAgentSession();
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
        onDelete={() => void deleteSession(agent, title)}
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
          data-active={location.pathname.startsWith("/console") ? "true" : undefined}
          onClick={() => navigate("/console")}
        >
          <span className={s.entryIcon}>
            <TerminalSquare size={16} />
          </span>
          <span className={s.entryLabel}>终端</span>
          <span className={s.entryCommand}>/console</span>
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
