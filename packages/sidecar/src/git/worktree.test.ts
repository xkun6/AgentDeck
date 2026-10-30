import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { locateGit, runGit } from "../snapshots/git.js";
import { addWorktree, diffStat, removeWorktree } from "./worktree.js";

const gitPath = await locateGit();

async function run(cwd: string, ...args: string[]): Promise<string> {
  const result = await runGit(gitPath!, args, { cwd });
  if (result.code !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout.toString("utf8");
}

describe.skipIf(!gitPath)("git worktree 工具", () => {
  let root: string;
  let repo: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "agentdeck-worktree-"));
    repo = path.join(root, "repo");
    await runGit(gitPath!, ["init", repo]);
    await run(repo, "config", "user.email", "t@example.com");
    await run(repo, "config", "user.name", "t");
    await writeFile(path.join(repo, "a.txt"), "hello\n");
    await run(repo, "add", ".");
    await run(repo, "commit", "-m", "init");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("addWorktree 失败时不留下这次新建的空上层目录，已存在的上层目录不动", async () => {
    await run(repo, "branch", "agentdeck/taken");
    const fresh = path.join(root, "fresh-group");
    await expect(
      addWorktree({ repoCwd: repo, path: path.join(fresh, "1"), branch: "agentdeck/taken" }),
    ).rejects.toThrow("创建 worktree 失败");
    await expect(stat(fresh)).rejects.toThrow();

    const existing = path.join(root, "existing-group");
    await mkdir(existing);
    await expect(
      addWorktree({ repoCwd: repo, path: path.join(existing, "1"), branch: "agentdeck/taken" }),
    ).rejects.toThrow("创建 worktree 失败");
    expect((await stat(existing)).isDirectory()).toBe(true);
  });

  it("addWorktree 基于 HEAD 建分支与目录，diffStat 反映改动，removeWorktree 清理目录与分支", async () => {
    const target = path.join(root, "wt", "one");
    const created = await addWorktree({ repoCwd: repo, path: target, branch: "agentdeck/test-one" });
    expect(created.branch).toBe("agentdeck/test-one");
    expect((await stat(path.join(target, "a.txt"))).isFile()).toBe(true);
    expect(await run(repo, "branch", "--list", "agentdeck/test-one")).toContain("agentdeck/test-one");

    expect(await diffStat({ cwd: target })).toBe("");
    await writeFile(path.join(target, "a.txt"), "hello\nworld\n");
    await writeFile(path.join(target, "new.txt"), "x\n");
    const summary = await diffStat({ cwd: target });
    expect(summary).toContain("a.txt");
    expect(summary).toContain("new.txt");

    await removeWorktree({ repoCwd: repo, path: target, branch: "agentdeck/test-one", deleteBranch: true });
    await expect(stat(target)).rejects.toThrow();
    expect(await run(repo, "branch", "--list", "agentdeck/test-one")).toBe("");
  });

  it("removeWorktree 不删分支时保留分支", async () => {
    const target = path.join(root, "wt", "two");
    await addWorktree({ repoCwd: repo, path: target, branch: "agentdeck/test-two" });
    await removeWorktree({ repoCwd: repo, path: target, branch: "agentdeck/test-two", deleteBranch: false });
    expect(await run(repo, "branch", "--list", "agentdeck/test-two")).toContain("agentdeck/test-two");
  });

  it("repoCwd 不在 git 仓库内时抛出中文错误", async () => {
    const plain = await mkdtemp(path.join(os.tmpdir(), "agentdeck-nogit-"));
    try {
      await expect(
        addWorktree({ repoCwd: plain, path: path.join(plain, "wt"), branch: "agentdeck/x" }),
      ).rejects.toThrow("不在 git 仓库内");
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it("分支重名时抛出错误", async () => {
    const target = path.join(root, "wt", "three");
    await addWorktree({ repoCwd: repo, path: target, branch: "agentdeck/test-three" });
    await expect(
      addWorktree({ repoCwd: repo, path: path.join(root, "wt", "four"), branch: "agentdeck/test-three" }),
    ).rejects.toThrow("创建 worktree 失败");
  });
});
