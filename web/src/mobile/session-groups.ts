// 会话列表按项目分组（design.md 4.26）：项目 = 工作目录，置顶的会话单列最前；项目顺序与组内顺序都沿用传入顺序（agent.list 按 updatedAt 倒序）。
import type { AgentSnapshot } from "@agentdeck/protocol";
import { isManagedWorktreePath } from "@/lib/workspaces";
import { cwdBaseName, cwdKey } from "./cwd-options";

/** 手机拿不到 git 信息，AgentDeck 自建的 worktree 查不出所在仓库，合成一组 */
const WORKTREE_KEY = "__worktrees__";
const NO_CWD_KEY = "__no_cwd__";

/** 项目折叠时每组默认显示的会话数；进行中与待处理的会话不受限制 */
export const PROJECT_ROW_LIMIT = 5;

export interface ProjectGroup<T> {
  key: string;
  name: string;
  /** 完整路径；合成的分组没有 */
  path?: string;
  agents: T[];
}

function parentAndBase(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/").slice(-2).join("/");
}

export function groupSessionsByProject<T extends Pick<AgentSnapshot, "cwd" | "pinned">>(
  agents: readonly T[],
): { pinned: T[]; projects: ProjectGroup<T>[] } {
  const pinned: T[] = [];
  const byKey = new Map<string, ProjectGroup<T>>();
  for (const agent of agents) {
    if (agent.pinned) {
      pinned.push(agent);
      continue;
    }
    const cwd = agent.cwd.trim();
    const key = !cwd ? NO_CWD_KEY : isManagedWorktreePath(cwd) ? WORKTREE_KEY : cwdKey(cwd);
    let group = byKey.get(key);
    if (!group) {
      group =
        key === NO_CWD_KEY
          ? { key, name: "未知目录", agents: [] }
          : key === WORKTREE_KEY
            ? { key, name: "工作树", agents: [] }
            : { key, name: cwdBaseName(cwd), path: cwd, agents: [] };
      byKey.set(key, group);
    }
    group.agents.push(agent);
  }
  const projects = [...byKey.values()];
  // 不同目录同名时带上父目录，否则分不清
  const nameCounts = new Map<string, number>();
  for (const { name } of projects) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  for (const project of projects) {
    if (project.path && (nameCounts.get(project.name) ?? 0) > 1) project.name = parentAndBase(project.path);
  }
  return { pinned, projects };
}

/** 只留最近的几个，进行中与待处理的会话始终显示 */
export function limitProjectRows<T>(
  agents: readonly T[],
  isActive: (agent: T) => boolean,
  limit = PROJECT_ROW_LIMIT,
): { shown: T[]; hidden: number } {
  const shown = agents.filter((agent, index) => index < limit || isActive(agent));
  return { shown, hidden: agents.length - shown.length };
}
