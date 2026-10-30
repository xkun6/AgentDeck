import { readUiValue, removeUiValue, subscribeUiStore, writeUiValue } from "@/lib/ui-store";
export interface WorkspaceProject {
  path: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export const WORKSPACE_STORAGE_KEY = "agentdeck-cn-ui.workspacePath";

const WORKSPACE_PROJECTS_STORAGE_KEY = "agentdeck-cn-ui.workspaceProjects";
const SESSION_WORKSPACE_STORAGE_KEY = "agentdeck-cn-ui.sessionWorkspaces";
const PINNED_WORKSPACE_PROJECTS_STORAGE_KEY = "agentdeck-cn-ui.pinnedWorkspaceProjects";
const WORKSPACE_CHANGED_EVENT = "agentdeck-cn-ui.workspaces.changed";

export function normalizeWorkspacePath(path: unknown): string {
  return typeof path === "string" ? path.trim().replace(/\/+$/, "") : "";
}

export function workspaceNameFromPath(path: string): string {
  const normalized = normalizeWorkspacePath(path).replace(/\\/g, "/");
  return normalized.split("/").pop() || normalized || "NewProject";
}

/** 会话是否属于该项目：优先看 cwd，没有再看会话与工作区的关联（与项目详情页的判定一致） */
export function agentInWorkspace(
  agent: { id: string; cwd: string },
  workspacePath: string,
  sessionWorkspaceMap: Record<string, string>,
): boolean {
  return normalizeWorkspacePath(agent.cwd || sessionWorkspaceMap[agent.id]) === workspacePath;
}

function emitWorkspaceChange(): void {
  try {
    window.dispatchEvent(new Event(WORKSPACE_CHANGED_EVENT));
  } catch {}
}

function readJSON<T>(key: string, fallback: T): T {
  return readUiValue<T>(key, fallback);
}

function writeJSON(key: string, value: unknown): void {
  writeUiValue(key, value);
  emitWorkspaceChange();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeWorkspacePathList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    const path = normalizeWorkspacePath(item);
    if (!path || seen.has(path)) return [];
    seen.add(path);
    return [path];
  });
}

/** AgentDeck 自建的 worktree 目录（委派、看板任务、协作组成员，design.md 4.26）：属于所在仓库的项目，自身不是项目 */
const MANAGED_WORKTREE_PATTERN = /[\\/]worktrees[\\/](?:delegate-[0-9a-f]{8}|task-[0-9a-f]{8}-[0-9a-f-]{27}|[0-9a-f]{8}[\\/]\d+)$/i;

export function isManagedWorktreePath(path: string): boolean {
  return MANAGED_WORKTREE_PATTERN.test(path);
}

export function readWorkspacePath(): string {
  const path = normalizeWorkspacePath(readUiValue(WORKSPACE_STORAGE_KEY, ""));
  return isManagedWorktreePath(path) ? "" : path;
}

export function writeWorkspacePath(path: string): void {
  if (isManagedWorktreePath(normalizeWorkspacePath(path))) return;
  const normalized = normalizeWorkspacePath(path);
  if (normalized) {
    writeUiValue(WORKSPACE_STORAGE_KEY, normalized);
  } else {
    removeUiValue(WORKSPACE_STORAGE_KEY);
  }
  emitWorkspaceChange();
}

export function readWorkspaceProjects(): WorkspaceProject[] {
  const rawValue = readJSON<unknown>(WORKSPACE_PROJECTS_STORAGE_KEY, []);
  const raw = Array.isArray(rawValue) ? rawValue : [];
  const seen = new Set<string>();
  return raw.flatMap((item) => {
    if (!isRecord(item)) return [];
    const path = normalizeWorkspacePath(item.path);
    if (!path || seen.has(path) || isManagedWorktreePath(path)) return [];
    seen.add(path);
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const createdAt = typeof item.createdAt === "number" && Number.isFinite(item.createdAt) ? item.createdAt : Date.now();
    const updatedAt = typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt) ? item.updatedAt : Date.now();
    return [{
      path,
      name: name || workspaceNameFromPath(path),
      createdAt,
      updatedAt,
    }];
  });
}

export function rememberWorkspaceProject(path: string, name?: string): WorkspaceProject | null {
  const normalized = normalizeWorkspacePath(path);
  if (!normalized || isManagedWorktreePath(normalized)) return null;

  const now = Date.now();
  const projects = readWorkspaceProjects();
  const existing = projects.find((item) => item.path === normalized);
  const displayName = typeof name === "string" ? name.trim() : "";
  const nextProject: WorkspaceProject = existing
    ? {
        ...existing,
        name: displayName || existing.name || workspaceNameFromPath(normalized),
        updatedAt: now,
      }
    : {
        path: normalized,
        name: displayName || workspaceNameFromPath(normalized),
        createdAt: now,
        updatedAt: now,
      };

  // 列表顺序即侧栏项目顺序（design.md 4.17）：新项目放最前，已有项目原位更新、不调整顺序
  const next = existing
    ? projects.map((item) => (item.path === normalized ? nextProject : item))
    : [nextProject, ...projects];
  writeJSON(WORKSPACE_PROJECTS_STORAGE_KEY, next);
  return nextProject;
}

/** 侧栏拖拽调整项目顺序：把 path 移到 targetPath 之前 / 之后 */
export function moveWorkspaceProject(path: string, targetPath: string, placement: "before" | "after"): void {
  const from = normalizeWorkspacePath(path);
  const to = normalizeWorkspacePath(targetPath);
  if (!from || !to || from === to) return;
  const projects = readWorkspaceProjects();
  const moving = projects.find((item) => item.path === from);
  const rest = projects.filter((item) => item.path !== from);
  const targetIndex = rest.findIndex((item) => item.path === to);
  if (!moving || targetIndex < 0) return;
  rest.splice(placement === "before" ? targetIndex : targetIndex + 1, 0, moving);
  writeJSON(WORKSPACE_PROJECTS_STORAGE_KEY, rest);
}

/**
 * 打开已有会话时登记其工作区：尚未记住才新增；已记住的项目原样保留（不刷新 updatedAt、不调整顺序），
 * 避免仅查看会话就把项目排到侧栏最前（design.md 4.17）
 */
export function ensureWorkspaceProject(path: string): void {
  const normalized = normalizeWorkspacePath(path);
  if (!normalized || readWorkspaceProjects().some((item) => item.path === normalized)) return;
  rememberWorkspaceProject(normalized);
}

export function readPinnedWorkspaceProjectPaths(): Set<string> {
  return new Set(
    normalizeWorkspacePathList(readJSON<unknown>(PINNED_WORKSPACE_PROJECTS_STORAGE_KEY, [])),
  );
}

export function writePinnedWorkspaceProjectPaths(paths: Iterable<string>): Set<string> {
  const cleanPaths = normalizeWorkspacePathList(Array.from(paths));
  writeJSON(PINNED_WORKSPACE_PROJECTS_STORAGE_KEY, cleanPaths);
  return new Set(cleanPaths);
}

export function isWorkspaceProjectPinned(path: string): boolean {
  const normalized = normalizeWorkspacePath(path);
  return normalized ? readPinnedWorkspaceProjectPaths().has(normalized) : false;
}

export function togglePinnedWorkspaceProject(path: string): Set<string> {
  const normalized = normalizeWorkspacePath(path);
  const paths = readPinnedWorkspaceProjectPaths();
  if (!normalized) return paths;
  if (paths.has(normalized)) paths.delete(normalized);
  else paths.add(normalized);
  return writePinnedWorkspaceProjectPaths(paths);
}

export function unpinWorkspaceProjects(pathsToUnpin: Iterable<string>): Set<string> {
  const paths = readPinnedWorkspaceProjectPaths();
  let changed = false;
  for (const path of pathsToUnpin) {
    const normalized = normalizeWorkspacePath(path);
    if (normalized && paths.delete(normalized)) changed = true;
  }
  return changed ? writePinnedWorkspaceProjectPaths(paths) : paths;
}

function readRawSessionWorkspaceMap(): Record<string, string> {
  const raw = readJSON<unknown>(SESSION_WORKSPACE_STORAGE_KEY, {});
  if (!isRecord(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).flatMap(([sessionId, path]) => {
      const normalizedSessionId = sessionId.trim();
      const normalized = normalizeWorkspacePath(path);
      return normalizedSessionId && normalized ? [[normalizedSessionId, normalized]] : [];
    }),
  );
}

export function removeWorkspaceProject(path: string): void {
  const normalized = normalizeWorkspacePath(path);
  if (!normalized) return;

  const projects = readWorkspaceProjects().filter((item) => item.path !== normalized);
  const sessionMap = readRawSessionWorkspaceMap();
  const nextSessionMap = Object.fromEntries(
    Object.entries(sessionMap).filter(([, workspacePath]) => workspacePath !== normalized),
  );

  writeJSON(WORKSPACE_PROJECTS_STORAGE_KEY, projects);
  writeJSON(SESSION_WORKSPACE_STORAGE_KEY, nextSessionMap);

  if (readWorkspacePath() === normalized) {
    writeWorkspacePath("");
  }

  unpinWorkspaceProjects([normalized]);
}

export function readSessionWorkspaceMap(): Record<string, string> {
  return readRawSessionWorkspaceMap();
}

export function rememberSessionWorkspace(sessionId: string | null | undefined, path: string): void {
  const normalizedSessionId = sessionId?.trim();
  const normalizedPath = normalizeWorkspacePath(path);
  if (!normalizedSessionId || !normalizedPath) return;

  const map = readRawSessionWorkspaceMap();
  map[normalizedSessionId] = normalizedPath;
  writeJSON(SESSION_WORKSPACE_STORAGE_KEY, map);
  rememberWorkspaceProject(normalizedPath);
}

export function subscribeWorkspaceChanges(listener: () => void): () => void {
  window.addEventListener(WORKSPACE_CHANGED_EVENT, listener);
  const unsubscribe = subscribeUiStore(listener);
  return () => {
    window.removeEventListener(WORKSPACE_CHANGED_EVENT, listener);
    unsubscribe();
  };
}
