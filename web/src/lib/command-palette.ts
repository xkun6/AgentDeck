import type { FsEntry } from "@agentdeck/protocol";
import type { WorkspaceProject } from "@/lib/workspaces";

export type CommandPaletteGroupId =
  | "commands"
  | "sessions"
  | "projects"
  | "files";

export type CommandPaletteIconKey =
  | "agents"
  | "automation"
  | "console"
  | "env"
  | "file"
  | "folder"
  | "history"
  | "info"
  | "new"
  | "notifications"
  | "project"
  | "settings"
  | "theme"
  | "usage";

export type CommandPaletteAction =
  | { type: "navigate"; to: string }
  | { type: "open-path"; path: string; fallbackTo?: string };

export interface CommandPaletteItem {
  id: string;
  group: CommandPaletteGroupId;
  label: string;
  subtitle?: string;
  keywords?: string[];
  icon: CommandPaletteIconKey;
  action: CommandPaletteAction;
  /** Empty-query entries. Static commands and recent dynamic entities use this. */
  defaultVisible?: boolean;
  /** Lower values sort first inside a group for empty-query and equal-score matches. */
  priority?: number;
}

export interface CommandPaletteGroup {
  id: CommandPaletteGroupId;
  label: string;
  items: CommandPaletteItem[];
}

export interface CommandPaletteFileCandidate {
  entry: FsEntry;
  projectPath: string;
  projectName: string;
}

/** 会话候选（由宿主从 sidecar 的 agent 快照整理而来）。 */
export interface CommandPaletteSession {
  id: string;
  title: string;
  /** 例如「Claude Code · /path/to/repo」。 */
  subtitle?: string;
  preview?: string;
  updatedAt: number;
}

interface BuildCommandPaletteItemsInput {
  sessions?: readonly CommandPaletteSession[] | null;
  projects?: readonly WorkspaceProject[] | null;
  files?: readonly CommandPaletteFileCandidate[] | null;
}

interface FilterOptions {
  maxPerGroup?: number;
}

const GROUP_ORDER: CommandPaletteGroupId[] = ["commands", "sessions", "projects", "files"];

export const COMMAND_PALETTE_GROUP_LABELS: Record<CommandPaletteGroupId, string> = {
  commands: "命令",
  sessions: "会话",
  projects: "项目",
  files: "文件",
};

function command(
  id: string,
  label: string,
  subtitle: string,
  keywords: string[],
  icon: CommandPaletteIconKey,
  to: string,
  priority: number,
  defaultVisible = true,
): CommandPaletteItem {
  return { id, group: "commands", label, subtitle, keywords, icon, action: { type: "navigate", to }, defaultVisible, priority };
}

export const COMMAND_PALETTE_COMMANDS: readonly CommandPaletteItem[] = [
  command("command-new-session", "新建对话", "回到工作台并开始新任务", ["new", "chat", "session", "task", "compose", "新任务", "新会话"], "new", "/", 0),
  command("command-history", "对话历史", "/history · 搜索和管理会话", ["history", "sessions", "chat", "conversation", "历史", "会话"], "history", "/history", 1),
  command("command-projects", "项目 / 工作空间", "/projects · 查看已登记项目", ["project", "workspace", "folder", "cwd", "工作区", "目录"], "project", "/projects", 2),
  command("command-console", "终端", "/console · 在工作区打开终端", ["console", "terminal", "command", "shell", "终端", "命令行"], "console", "/console", 3),
  command("command-usage", "用量统计", "/usage · 跨会话 tokens、费用与性能", ["usage", "stats", "statistics", "token", "tokens", "cost", "用量", "统计", "费用", "花费"], "usage", "/usage", 3),
  command("command-automation", "自动化", "/automation · 定时任务、心跳与目标循环", ["automation", "schedule", "cron", "heartbeat", "goal", "loop", "自动化", "定时", "心跳", "目标", "循环"], "automation", "/automation", 3),
  command("command-agent-providers", "Agent 与中转", "/agent-providers · 管理三方中转与 Agent 可用状态", ["agents", "providers", "relay", "proxy", "claude", "codex", "acp", "中转", "接口", "密钥"], "agents", "/agent-providers", 4),
  command("command-coding-agents", "编程 Agent", "/coding-agents · 检测已安装的 Agent CLI", ["agents", "claude", "codex", "acp", "cli", "编程", "检测"], "agents", "/coding-agents", 4),
  command("command-env", "环境检测", "/env · 检查本机 CLI 与可选工具", ["env", "environment", "tools", "diagnostics", "环境", "检测"], "env", "/env", 5),
  command("command-debug", "打开调试面板", "/debug · 运行状态、日志与诊断包导出", ["debug", "diagnostics", "log", "logs", "bundle", "调试", "日志", "诊断", "诊断包"], "env", "/debug", 6, false),
  command("command-settings", "常规设置", "/common · 显示、发送快捷键与助手名称", ["settings", "preferences", "common", "设置", "常规"], "settings", "/common", 6, false),
  command("command-notifications", "通知设置", "/notifications · 任务完成与权限确认提醒", ["notifications", "notify", "sound", "通知", "提醒"], "notifications", "/notifications", 7, false),
  command("command-theme", "主题", "/theme · 外观、密度与字号", ["theme", "appearance", "dark", "light", "主题", "外观"], "theme", "/theme", 8, false),
  command("command-about", "关于 AgentDeck", "/about · 版本、许可与第三方声明", ["about", "version", "license", "notice", "关于", "版本", "许可"], "info", "/about", 9, false),
];

function cleanText(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function normalizeSearch(value: string): string {
  return value.trim().toLowerCase();
}

function searchHaystack(item: CommandPaletteItem): string[] {
  return [
    item.label,
    item.subtitle ?? "",
    item.id,
    ...(item.keywords ?? []),
  ].map((value) => value.toLowerCase());
}

function isSubsequence(query: string, value: string): boolean {
  if (!query) return true;
  let cursor = 0;
  for (const char of value) {
    if (char === query[cursor]) cursor += 1;
    if (cursor === query.length) return true;
  }
  return false;
}

export function commandPaletteItemScore(item: CommandPaletteItem, query: string): number | null {
  const q = normalizeSearch(query);
  if (!q) return item.defaultVisible ? item.priority ?? 0 : null;

  const haystack = searchHaystack(item);
  let best: number | null = null;
  for (const value of haystack) {
    let score: number | null = null;
    if (value === q) score = 0;
    else if (value.startsWith(q)) score = 10;
    else if (value.includes(q)) score = 20;
    else if (isSubsequence(q, value)) score = 80;
    if (score !== null) best = best === null ? score : Math.min(best, score);
  }
  return best;
}

function makeNavigateItem(
  item: Omit<CommandPaletteItem, "action"> & { to: string },
): CommandPaletteItem {
  const { to, ...rest } = item;
  return { ...rest, action: { type: "navigate", to } };
}

function buildSessionItems(sessions: readonly CommandPaletteSession[]): CommandPaletteItem[] {
  return [...sessions]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 200)
    .map((session, index) => {
      const title = cleanText(session.title) || "未命名会话";
      const subtitle = cleanText(session.subtitle);
      const preview = cleanText(session.preview);
      return makeNavigateItem({
        id: `session-${session.id}`,
        group: "sessions",
        label: title,
        subtitle: [subtitle || "会话", preview].filter(Boolean).join(" · "),
        keywords: [session.id, title, subtitle, preview, "session", "chat", "conversation", "会话", "对话"].filter(Boolean),
        icon: "history",
        to: `/tasks/${encodeURIComponent(session.id)}`,
        defaultVisible: index < 5,
        priority: index,
      });
    });
}

function buildProjectItems(projects: readonly WorkspaceProject[]): CommandPaletteItem[] {
  return [...projects]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 100)
    .map((project, index) => makeNavigateItem({
      id: `project-${project.path}`,
      group: "projects",
      label: project.name,
      subtitle: project.path,
      keywords: [project.name, project.path, "project", "workspace", "folder", "项目", "工作区"],
      icon: "project",
      to: `/projects/${encodeURIComponent(project.path)}`,
      defaultVisible: index < 5,
      priority: index,
    }));
}

export function buildFileItems(files: readonly CommandPaletteFileCandidate[]): CommandPaletteItem[] {
  return files.map(({ entry, projectPath, projectName }, index) => ({
    id: `file-${entry.path}`,
    group: "files",
    label: entry.name,
    subtitle: `${projectName} · ${entry.path}`,
    keywords: [entry.name, entry.path, projectName, projectPath, entry.is_dir ? "directory folder 目录 文件夹" : "file 文件"],
    icon: entry.is_dir ? "folder" : "file",
    action: {
      type: "open-path",
      path: entry.path,
      fallbackTo: `/projects/${encodeURIComponent(projectPath)}`,
    },
    priority: index,
  }));
}

export function buildCommandPaletteItems({
  sessions,
  projects,
  files,
}: BuildCommandPaletteItemsInput): CommandPaletteItem[] {
  return [
    ...COMMAND_PALETTE_COMMANDS,
    ...buildSessionItems(sessions ?? []),
    ...buildProjectItems(projects ?? []),
    ...buildFileItems(files ?? []),
  ];
}

export function filterCommandPaletteGroups(
  items: readonly CommandPaletteItem[],
  query: string,
  options: FilterOptions = {},
): CommandPaletteGroup[] {
  const maxPerGroup = options.maxPerGroup ?? 8;
  const scored = items.flatMap((item, index) => {
    const score = commandPaletteItemScore(item, query);
    return score === null ? [] : [{ item, index, score }];
  });

  const byGroup = new Map<CommandPaletteGroupId, typeof scored>();
  for (const entry of scored) {
    const group = byGroup.get(entry.item.group) ?? [];
    group.push(entry);
    byGroup.set(entry.item.group, group);
  }

  return GROUP_ORDER.flatMap((id) => {
    const group = byGroup.get(id);
    if (!group?.length) return [];
    const itemsForGroup = group
      .sort((a, b) => a.score - b.score || (a.item.priority ?? a.index) - (b.item.priority ?? b.index))
      .slice(0, maxPerGroup)
      .map((entry) => entry.item);
    return [{ id, label: COMMAND_PALETTE_GROUP_LABELS[id], items: itemsForGroup }];
  });
}

export function shouldLoadCommandPaletteFiles(query: string): boolean {
  return normalizeSearch(query).length >= 2;
}
