// 共用 git worktree 工具（design.md 4.27 开头）：会话互通（4.26）、并行协作（4.27）、看板（4.28）复用。
// git 定位与 spawn 规则复用 snapshots/git.ts（shell:false、windowsHide:true）。
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { locateGit, runGit } from "../snapshots/git.js";

export interface AddWorktreeOptions {
  /** 必须位于 git 仓库内；worktree 基于该仓库当前 HEAD */
  repoCwd: string;
  /** worktree 目录（统一放在 `<AGENTDECK_DATA_DIR>/worktrees/` 下） */
  path: string;
  branch: string;
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
  await mkdir(path.dirname(target), { recursive: true });
  const result = await runGit(gitPath, ["worktree", "add", target, "-b", options.branch], {
    cwd: options.repoCwd,
  });
  if (result.code !== 0) {
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

/** 目录当前分支名；不是仓库或处于 detached HEAD 时返回 null */
export async function currentBranch(options: { cwd: string }): Promise<string | null> {
  const gitPath = await requireGit();
  const result = await runGit(gitPath, ["symbolic-ref", "--short", "-q", "HEAD"], { cwd: options.cwd });
  const branch = result.stdout.toString("utf8").trim();
  return result.code === 0 && branch ? branch : null;
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
