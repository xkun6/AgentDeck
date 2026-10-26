// 侧栏按仓库归属 worktree 会话：列出每个已记住项目的 git worktree，把 worktree 目录映射回项目路径。
// 只在有会话的 cwd 不属于任何项目时才查询；非仓库、无桌面桥或查询失败时不映射（会话留在「其他对话」）。
import { useEffect, useState } from "react";

/** worktree 路径比较用的键：统一分隔符、去掉末尾斜杠、忽略大小写（sidecar 给反斜杠，git 给正斜杠）。 */
export function worktreePathKey(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

const EMPTY: ReadonlyMap<string, string> = new Map();

type WorktreeList = NonNullable<NonNullable<Window["agentdeckDesktop"]>["git"]>["worktree"]["list"];

interface LookupCache {
  projectsKey: string;
  /** 上次查询时已经覆盖过的 cwd 键：都在其中时不必重查（每个项目一次 git，项目多时要好几秒）。 */
  cwds: ReadonlySet<string>;
  map: ReadonlyMap<string, string>;
}

// 按桥函数分开缓存：切换路由、侧栏重挂载或会话列表变化时复用上次结果，只有出现新的 cwd 才重查。
const caches = new WeakMap<WorktreeList, LookupCache>();

/** 返回 worktreePathKey(worktree 路径) → 项目路径；同一 worktree 被多个项目列出时取靠前的项目。 */
export function useWorktreeProjects(
  projectPaths: readonly string[],
  unmatchedCwds: readonly string[],
): ReadonlyMap<string, string> {
  const list = window.agentdeckDesktop?.git?.worktree.list;
  const projectsKey = projectPaths.join("\n");
  const cwdsKey = Array.from(new Set(unmatchedCwds.map(worktreePathKey))).sort().join("\n");
  const [map, setMap] = useState(() => {
    const cached = list ? caches.get(list) : undefined;
    return cached?.projectsKey === projectsKey ? cached.map : EMPTY;
  });

  useEffect(() => {
    if (!list || !projectsKey || !cwdsKey) {
      setMap(EMPTY);
      return;
    }
    const cwds = cwdsKey.split("\n");
    const cached = caches.get(list);
    if (cached?.projectsKey === projectsKey && cwds.every((cwd) => cached.cwds.has(cwd))) {
      setMap(cached.map);
      return;
    }
    let cancelled = false;
    const paths = projectsKey.split("\n");
    void Promise.all(
      paths.map((repoPath) =>
        list({ repoPath }).then(
          (worktrees) => worktrees.filter((worktree) => !worktree.isMain),
          () => [],
        ),
      ),
    ).then((results) => {
      const next = new Map<string, string>();
      results.forEach((worktrees, index) => {
        for (const worktree of worktrees) {
          const key = worktreePathKey(worktree.path);
          if (!next.has(key)) next.set(key, paths[index]);
        }
      });
      caches.set(list, { projectsKey, cwds: new Set(cwds), map: next });
      if (!cancelled) setMap(next);
    });
    return () => {
      cancelled = true;
    };
  }, [list, projectsKey, cwdsKey]);

  return map;
}
