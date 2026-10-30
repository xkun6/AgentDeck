// 共用 git worktree 工具（design.md 4.27 开头）：会话互通（4.26）、并行协作（4.27）、看板（4.28）复用。
// git 定位与 spawn 规则复用 snapshots/git.ts（shell:false、windowsHide:true）。
import { appendFile, mkdir, readFile, rmdir } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../logger.js";
import { locateGit, runGit } from "../snapshots/git.js";

export interface AddWorktreeOptions {
  /** 必须位于 git 仓库内；worktree 基于该仓库当前 HEAD */
  repoCwd: string;
  path: string;
  branch: string;
}

export interface AddProjectWorktreeOptions {
  repoCwd: string;
  /** `tmp/worktrees/` 下的相对路径 */
  name: string;
  branch: string;
  /** 调用方指定的完整路径，相对路径按 repoCwd 解析；优先于 name */
  customPath?: string | undefined;
  logger: Logger;
}

export interface RemoveWorktreeOptions {
  repoCwd: string;
  path: string;
  branch: string;
  deleteBranch: boolean;
}

async function requireGit(): Promise<string> {
  const gitPath = await locateGit();
  if (!gitPath) {
    throw new Error("未找到 git，无法使用 worktree");
  }
  return gitPath;
}

function stderrOf(result: { stderr: string }): string {
  return result.stderr.trim() || "未知错误";
}

/** `worktree add <path> -b <branch>`；repoCwd 不在仓库内或命令失败时抛出中文错误 */
export async function addWorktree(options: AddWorktreeOptions): Promise<{ path: string; branch: string }> {
  const gitPath = await requireGit();
  const probe = await runGit(gitPath, ["rev-parse", "--is-inside-work-tree"], {
    cwd: options.repoCwd,
  }).catch(() => null);
  if (!probe || probe.code !== 0 || probe.stdout.toString("utf8").trim() !== "true") {
    throw new Error(`工作目录不在 git 仓库内，无法创建 worktree：${options.repoCwd}`);
  }
  const target = path.resolve(options.path);
  const createdParent = await mkdir(path.dirname(target), { recursive: true });
  const result = await runGit(gitPath, ["worktree", "add", target, "-b", options.branch], {
    cwd: options.repoCwd,
  });
  if (result.code !== 0) {
    // 上层目录是这次新建的就不留空目录（如协作组第一个成员就失败时的 `<组 id>`）
    if (createdParent) {
      await rmdir(path.dirname(target)).catch(() => undefined);
    }
    throw new Error(`创建 worktree 失败：${stderrOf(result)}`);
  }
  return { path: target, branch: options.branch };
}

/** `worktree remove --force <path>`，deleteBranch 时再 `branch -D <branch>`；任一步失败抛出 */
export async function removeWorktree(options: RemoveWorktreeOptions): Promise<void> {
  const gitPath = await requireGit();
  const removed = await runGit(gitPath, ["worktree", "remove", "--force", path.resolve(options.path)], {
    cwd: options.repoCwd,
  });
  if (removed.code !== 0) {
    throw new Error(`删除 worktree 失败：${stderrOf(removed)}`);
  }
  if (options.deleteBranch) {
    const deleted = await runGit(gitPath, ["branch", "-D", options.branch], { cwd: options.repoCwd });
    if (deleted.code !== 0) {
      throw new Error(`删除分支 ${options.branch} 失败：${stderrOf(deleted)}`);
    }
  }
}

/** 项目主工作区根目录：cwd 在子目录或其它 worktree 里也回到主工作区；裸仓库没有主工作区，取 cwd 所在 worktree 的根目录 */
export async function mainWorktreeRoot(options: { cwd: string }): Promise<string> {
  const gitPath = await requireGit();
  const notRepo = () => new Error(`工作目录不在 git 仓库内，无法创建 worktree：${options.cwd}`);
  const list = await runGit(gitPath, ["worktree", "list", "--porcelain"], { cwd: options.cwd }).catch(() => null);
  if (list?.code !== 0) {
    throw notRepo();
  }
  // 主工作区总在第一条：`worktree <路径>`，裸仓库下一行是 `bare`
  const [first, second] = list.stdout.toString("utf8").split(/\r?\n/);
  if (first?.startsWith("worktree ") && second !== "bare") {
    return path.resolve(first.slice("worktree ".length));
  }
  const top = await runGit(gitPath, ["rev-parse", "--show-toplevel"], { cwd: options.cwd }).catch(() => null);
  const root = top?.code === 0 ? top.stdout.toString("utf8").trim() : "";
  if (!root) {
    throw notRepo();
  }
  return path.resolve(root);
}

/**
 * 把主工作区内的目录写入 `<git-common-dir>/info/exclude`，避免主仓库 `git add -A` 把嵌套的 worktree 记成 gitlink。
 * 不改用户的 `.gitignore`；目录在主工作区外或已被忽略时什么都不做。
 */
export async function excludeFromRepo(options: { root: string; dir: string }): Promise<void> {
  const relative = path.relative(options.root, options.dir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return;
  }
  const gitPath = await requireGit();
  const posix = relative.split(path.sep).join("/");
  const ignored = await runGit(gitPath, ["check-ignore", "-q", `${posix}/`], { cwd: options.root });
  if (ignored.code === 0) {
    return;
  }
  const located = await runGit(gitPath, ["rev-parse", "--git-path", "info/exclude"], { cwd: options.root });
  if (located.code !== 0) {
    throw new Error(stderrOf(located));
  }
  const exclude = path.resolve(options.root, located.stdout.toString("utf8").trim());
  const existing = await readFile(exclude, "utf8").catch(() => "");
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  await mkdir(path.dirname(exclude), { recursive: true });
  // appendFile 而不是整体重写：并行派单同时写时最多多一行重复，不丢内容
  await appendFile(exclude, `${prefix}/${posix.replace(/[\\*?[\]!# ]/g, "\\$&")}/\n`);
}

/** 委派、协作组、看板建 worktree 的统一入口（design.md 4.27「项目内目录约定」）：默认放 `<主工作区>/tmp/worktrees/<name>`，并从主仓库状态里排除 */
export async function addProjectWorktree(options: AddProjectWorktreeOptions): Promise<{ path: string; branch: string }> {
  const root = await mainWorktreeRoot({ cwd: options.repoCwd });
  const defaultDir = path.join(root, "tmp", "worktrees");
  const worktree = await addWorktree({
    repoCwd: options.repoCwd,
    path: options.customPath ? path.resolve(options.repoCwd, options.customPath) : path.join(defaultDir, options.name),
    branch: options.branch,
  });
  await excludeFromRepo({ root, dir: options.customPath ? worktree.path : defaultDir }).catch((error: unknown) =>
    options.logger.warn("写入 info/exclude 失败：%s", error instanceof Error ? error.message : String(error)),
  );
  return worktree;
}

/** 目录当前分支名；不是仓库或处于 detached HEAD 时返回 null */
export async function currentBranch(options: { cwd: string }): Promise<string | null> {
  const gitPath = await requireGit();
  const result = await runGit(gitPath, ["symbolic-ref", "--short", "-q", "HEAD"], { cwd: options.cwd });
  const branch = result.stdout.toString("utf8").trim();
  return result.code === 0 && branch ? branch : null;
}

/** reviewDiff 读取 diff 的上限：调用方还会再按字数截断，这里只防止巨大 diff 全量进内存 */
const REVIEW_DIFF_MAX_BYTES = 1024 * 1024;

/**
 * 审查用的改动（design.md 4.26 read_agent）：相对 baseCwd 当前 HEAD 的 merge-base 的提交列表、
 * diff（含未提交的已跟踪改动）与未跟踪文件清单。不是仓库时抛出。
 */
export async function reviewDiff(options: {
  cwd: string;
  baseCwd: string;
}): Promise<{ text: string; limitation: "same-worktree" | "no-base" | null }> {
  const gitPath = await requireGit();
  const text = (result: { stdout: Buffer }) => result.stdout.toString("utf8").trimEnd();
  const topLevel = async (cwd: string) => {
    const result = await runGit(gitPath, ["rev-parse", "--show-toplevel"], { cwd }).catch(() => null);
    if (result?.code !== 0) return null;
    return process.platform === "win32" ? text(result).toLowerCase() : text(result);
  };
  const targetTop = await topLevel(options.cwd);
  if (targetTop === null) {
    throw new Error("目录不存在或不是 git 仓库");
  }
  const baseHead = await runGit(gitPath, ["rev-parse", "HEAD"], { cwd: options.baseCwd }).catch(() => null);
  const mergeBase =
    baseHead?.code === 0
      ? await runGit(gitPath, ["merge-base", "HEAD", text(baseHead)], { cwd: options.cwd }).catch(() => null)
      : null;
  const base = mergeBase?.code === 0 ? text(mergeBase) : "HEAD";
  // 同一工作区（含子目录）HEAD 相同；不同仓库或基线不是仓库时没有 merge-base。两种都比不出提交
  const limitation =
    targetTop === (await topLevel(options.baseCwd))
      ? "same-worktree"
      : mergeBase?.code === 0
        ? null
        : "no-base";
  // 还没有提交的仓库没有 HEAD 可比，只有未跟踪文件
  const head = await runGit(gitPath, ["rev-parse", "--verify", "-q", "HEAD"], { cwd: options.cwd });
  const hasCommits = head.code === 0;
  // 用户配置不能影响输出；中文文件名不转义。diff 放最后，超限时提交与未跟踪清单不受影响
  const diff = hasCommits
    ? await runGit(gitPath, ["-c", "core.quotepath=false", "diff", "--no-color", "--no-ext-diff", base], {
        cwd: options.cwd,
        maxBytes: REVIEW_DIFF_MAX_BYTES,
      })
    : { code: 0, stdout: Buffer.alloc(0), stderr: "", truncated: false };
  if (diff.code !== 0 && !diff.truncated) {
    throw new Error(stderrOf(diff));
  }
  const log = await runGit(gitPath, ["log", "--oneline", "--no-color", `${base}..HEAD`], { cwd: options.cwd });
  // diff 看整个仓库，未跟踪清单也要从根目录列，cwd 是子目录时才不漏
  const untracked = await runGit(
    gitPath,
    ["-c", "core.quotepath=false", "ls-files", "-o", "--exclude-standard", "--", ":/"],
    { cwd: options.cwd },
  );
  const parts: string[] = [];
  if (log.code === 0 && text(log)) {
    parts.push(`提交：\n${text(log)}`);
  }
  if (untracked.code === 0 && text(untracked)) {
    parts.push(`未跟踪文件：\n${text(untracked)}`);
  }
  if (text(diff)) {
    parts.push(`diff：\n${text(diff)}`);
  }
  return { text: parts.join("\n\n"), limitation };
}

/**
 * 目录相对 HEAD 的改动摘要：`diff --stat HEAD` 加未跟踪文件清单。
 * 没有改动返回空字符串；不是仓库时抛出。
 */
export async function diffStat(options: { cwd: string }): Promise<string> {
  const gitPath = await requireGit();
  const stat = await runGit(gitPath, ["diff", "--stat", "HEAD"], { cwd: options.cwd });
  if (stat.code !== 0) {
    throw new Error(`读取改动统计失败：${stderrOf(stat)}`);
  }
  const untracked = await runGit(gitPath, ["ls-files", "-o", "--exclude-standard"], { cwd: options.cwd });
  const files = untracked.code === 0 ? untracked.stdout.toString("utf8").split("\n").filter(Boolean) : [];
  const parts = [stat.stdout.toString("utf8").trimEnd()];
  if (files.length > 0) {
    parts.push(`未跟踪文件（${files.length}）：${files.join("、")}`);
  }
  return parts.filter(Boolean).join("\n");
}
