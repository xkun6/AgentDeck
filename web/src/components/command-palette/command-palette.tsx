import { useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { useQueries } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Command } from "cmdk";
import { Dialog } from "@agentdeck/shared-ui";
import {
  BarChart3,
  Bell,
  CalendarClock,
  Network,
  Bot,
  FileText,
  Folder,
  History,
  Info,
  Palette,
  Plus,
  Search,
  Settings,
  TerminalSquare,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { listDirectory } from "@/hooks/use-fs-list";
import { useAgentProviders } from "@/hooks/use-agent-catalog";
import { agentDisplayTitle, agentProviderLabel } from "@/lib/agent-session-display";
import { agentListAtom } from "@/stores/agents";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import {
  buildCommandPaletteItems,
  filterCommandPaletteGroups,
  shouldLoadCommandPaletteFiles,
  type CommandPaletteFileCandidate,
  type CommandPaletteIconKey,
  type CommandPaletteItem,
  type CommandPaletteSession,
} from "@/lib/command-palette";
import { dispatchMasterOf } from "@/lib/dispatch";
import { isHiddenAgent } from "@/lib/session-list";
import { isCommandPaletteShortcut } from "@/lib/command-palette-shortcut";
import {
  readWorkspaceProjects,
  subscribeWorkspaceChanges,
  type WorkspaceProject,
} from "@/lib/workspaces";
import { commandPaletteOpenAtom } from "@/stores/ui";
import s from "./command-palette.module.css";

const FILE_PROJECT_LIMIT = 5;
const FILE_ENTRY_LIMIT = 60;
const GROUP_ITEM_LIMIT = 8;

const ICONS: Record<CommandPaletteIconKey, LucideIcon> = {
  agents: Bot,
  automation: CalendarClock,
  dispatch: Network,
  console: TerminalSquare,
  env: Wrench,
  file: FileText,
  folder: Folder,
  history: History,
  info: Info,
  new: Plus,
  notifications: Bell,
  project: Folder,
  settings: Settings,
  theme: Palette,
  usage: BarChart3,
};

function sortProjectsForFileSearch(projects: readonly WorkspaceProject[]): WorkspaceProject[] {
  return [...projects]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, FILE_PROJECT_LIMIT);
}

function useWorkspaceProjects(): WorkspaceProject[] {
  const [projects, setProjects] = useState<WorkspaceProject[]>(readWorkspaceProjects);

  useEffect(
    () => subscribeWorkspaceChanges(() => setProjects(readWorkspaceProjects())),
    [],
  );

  return projects;
}

function useCommandPaletteFileCandidates(
  open: boolean,
  query: string,
  projects: readonly WorkspaceProject[],
): { files: CommandPaletteFileCandidate[]; fetching: boolean } {
  const shouldLoadFiles = open && shouldLoadCommandPaletteFiles(query);
  const roots = useMemo(() => sortProjectsForFileSearch(projects), [projects]);
  const fileQueries = useQueries({
    queries: roots.map((project) => ({
      queryKey: ["command-palette", "files", project.path],
      // 目录列表接入点与工作区选择弹窗共用 hooks/use-fs-list.ts。
      queryFn: () => listDirectory(project.path),
      enabled: shouldLoadFiles,
      retry: false,
      staleTime: 30_000,
      gcTime: 90_000,
    })),
  });

  const files = useMemo<CommandPaletteFileCandidate[]>(() => {
    if (!shouldLoadFiles) return [];
    const q = query.trim().toLowerCase();
    const candidates: CommandPaletteFileCandidate[] = [];
    fileQueries.forEach((result, index) => {
      const project = roots[index];
      if (!project || !result.data?.entries) return;
      for (const entry of result.data.entries) {
        const haystack = `${entry.name} ${entry.path}`.toLowerCase();
        if (q && !haystack.includes(q)) continue;
        candidates.push({ entry, projectPath: project.path, projectName: project.name });
        if (candidates.length >= FILE_ENTRY_LIMIT) return;
      }
    });
    return candidates;
  }, [fileQueries, query, roots, shouldLoadFiles]);

  return {
    files,
    fetching: shouldLoadFiles && fileQueries.some((result) => result.isFetching),
  };
}

export function CommandPalette() {
  const [open, setOpen] = useAtom(commandPaletteOpenAtom);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const agents = useAtomValue(agentListAtom);
  const runtimes = useAtomValue(chatRuntimeBySessionAtom);
  const providersQuery = useAgentProviders();
  const sessions = useMemo<CommandPaletteSession[]>(
    () => {
      const byId = new Map(agents.map((agent) => [agent.id, agent]));
      return agents.filter((agent) => !isHiddenAgent(agent)).map((agent) => {
        const master = dispatchMasterOf(agent, byId);
        return {
          id: agent.id,
          title: agentDisplayTitle(agent, runtimes[agent.id], providersQuery.data),
          ...(master ? { note: `主会话 ${agentDisplayTitle(master, runtimes[master.id], providersQuery.data)}` } : {}),
          subtitle: [agentProviderLabel(agent.provider, providersQuery.data), agent.cwd].filter(Boolean).join("，"),
          preview: agent.preview,
          updatedAt: agent.updatedAt,
        };
      });
    },
    [agents, providersQuery.data, runtimes],
  );
  const projects = useWorkspaceProjects();
  const { files, fetching: filesFetching } = useCommandPaletteFileCandidates(open, search, projects);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (isCommandPaletteShortcut(event)) {
        event.preventDefault();
        setOpen((current) => !current);
        return;
      }
      if (open && event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, setOpen]);

  useEffect(() => {
    if (!open) {
      setSearch("");
      return;
    }
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const items = useMemo(
    () => buildCommandPaletteItems({ sessions, projects, files }),
    [files, projects, sessions],
  );

  const groups = useMemo(
    () => filterCommandPaletteGroups(items, search, { maxPerGroup: GROUP_ITEM_LIMIT }),
    [items, search],
  );

  const close = () => setOpen(false);

  const runItem = async (item: CommandPaletteItem) => {
    close();
    const action = item.action;
    if (action.type === "navigate") {
      navigate(action.to);
      return;
    }

    let opened = false;
    if (window.agentdeckDesktop?.openWorkspacePath) {
      try {
        const result = await window.agentdeckDesktop.openWorkspacePath({ path: action.path });
        opened = result.ok;
      } catch (error) {
        console.error("Failed to open command palette path:", error);
      }
    }
    if (!opened && action.fallbackTo) {
      navigate(action.fallbackTo);
    }
  };

  const loadingLabel = filesFetching ? "文件" : "";

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content
          className={s.content}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <Dialog.Title asChild>
            <h2 className={s.srOnly}>全局命令面板</h2>
          </Dialog.Title>
          <Command
            className={s.command}
            shouldFilter={false}
            loop
            onKeyDown={(event) => {
              if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              close();
            }}
          >
            <div className={s.searchRow}>
              <Search size={16} />
              <Command.Input
                ref={inputRef}
                className={s.input}
                value={search}
                onValueChange={setSearch}
                onKeyDown={(event) => {
                  if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  close();
                }}
                placeholder="搜索命令、会话、项目或文件…"
                autoComplete="off"
                spellCheck={false}
              />
              <span className={s.kbd}>Esc</span>
            </div>
            <Command.List className={s.list}>
              {groups.length === 0 ? (
                <Command.Empty className={s.empty}>
                  {shouldLoadCommandPaletteFiles(search) && filesFetching
                    ? "正在搜索项目根目录…"
                    : "没有匹配的命令或内容"}
                </Command.Empty>
              ) : (
                groups.map((group) => (
                  <Command.Group key={group.id} heading={group.label} className={s.group}>
                    {group.items.map((item) => {
                      const Icon = ICONS[item.icon];
                      return (
                        <Command.Item
                          key={item.id}
                          value={item.id}
                          className={s.item}
                          onSelect={() => void runItem(item)}
                        >
                          <span className={s.iconBox} data-kind={item.group}>
                            <Icon size={16} />
                          </span>
                          <span className={s.itemMain}>
                            <span className={s.itemLabel}>{item.label}</span>
                            {item.subtitle || item.note ? (
                              <span className={s.itemSub}>{[item.note, item.subtitle].filter(Boolean).join("，")}</span>
                            ) : null}
                          </span>
                        </Command.Item>
                      );
                    })}
                  </Command.Group>
                ))
              )}
            </Command.List>
            <div className={s.footer}>
              <span>↑↓ 选择，Enter 打开，Ctrl+K 切换</span>
              {loadingLabel ? <span>正在同步 {loadingLabel}</span> : <span>{items.length} 个候选</span>}
            </div>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
