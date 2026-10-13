import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  SidecarSettings,
  SnapshotChangedFile,
  SnapshotSkipReason,
  SnapshotTurn,
} from "@agentdeck/protocol";

import { AgentInvalidParamsError, AgentRpcError } from "../agent/errors.js";
import { writeFileAtomic } from "../agent/agent-store.js";
import { createSilentLogger, type Logger } from "../logger.js";
import { locateGit, runGit } from "./git.js";

export const SNAPSHOT_DIFF_MAX_BYTES = 512 * 1024;
const SNAPSHOT_INDEX_FILE = "snapshots.json";
const RESTORE_REF = "refs/agentdeck/restore";
const STAT_CONCURRENCY = 32;

/** 影子仓库 info/exclude 默认规则（工作目录自身的 .gitignore 照常生效） */
export const DEFAULT_EXCLUDE_RULES = [
  ".git",
  "node_modules/",
  "target/",
  "dist/",
  "build/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".next/",
  ".gradle/",
  ".idea/",
  ".DS_Store",
  "Thumbs.db",
  "*.log",
  "*.pyc",
  "*.tmp",
];

export interface SnapshotServiceOptions {
  /** 未设置时无处存放影子仓库，快照功能关闭 */
  dataDir?: string;
  logger?: Logger;
  settings: () => SidecarSettings["snapshots"];
  /** 会话的工作目录；会话不存在返回 undefined */
  agentCwd: (agentId: string) => string | undefined;
  /** 全部会话（prune 时按 cwd 标记索引） */
  listAgents: () => Array<{ id: string; cwd: string }>;
  /** 该 cwd 上是否有任一会话正在跑回合 */
  isCwdBusy: (cwd: string) => boolean;
  /** 测试注入：字符串 = git 路径，null = 视为不可用；缺省自动定位 */
  gitPath?: string | null;
  now?: () => number;
}

interface TurnInfo {
  agentId: string;
  cwd: string;
  turnId: string;
}

type CaptureResult =
  | { ok: true; tree: string; commit?: string }
  | { ok: false; skipped: SnapshotSkipReason };

export function normalizeCwd(cwd: string): string {
  let normalized = path.resolve(cwd).replaceAll("\\", "/").replace(/\/+$/, "");
  if (process.platform === "win32") {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

function repoKeyOf(cwd: string): string {
  return createHash("sha1").update(normalizeCwd(cwd)).digest("hex").slice(0, 16);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function splitNul(buffer: Buffer): string[] {
  return buffer
    .toString("utf8")
    .split("\0")
    .filter((item) => item.length > 0);
}

/** 校验相对路径：不能是绝对路径、不能含 .. 段 */
function assertRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    normalized.length === 0 ||
    path.isAbsolute(value) ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new AgentInvalidParamsError(`非法路径：${value}`);
  }
  return normalized.replace(/\/+$/, "");
}

function pathSelected(file: string, selected: string[] | null): boolean {
  return (
    selected === null || selected.some((entry) => file === entry || file.startsWith(`${entry}/`))
  );
}

/**
 * 按回合 git 快照（design.md 4.24）：影子仓库（bare GIT_DIR + 工作目录作 work-tree），
 * 回合前 / 后各拍一次，提交挂在 `refs/agentdeck/<agentId>`。同一 repo 的 git 操作串行。
 */
export class SnapshotService {
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly root: string | undefined;
  private gitPromise: Promise<string | null> | null = null;
  private gitWarned = false;
  private readonly repoLocks = new Map<string, Promise<unknown>>();
  private readonly agentChains = new Map<string, Promise<void>>();
  private readonly indexes = new Map<string, SnapshotTurn[]>();
  private readonly openTurns = new Set<string>();
  private readonly removedAgents = new Set<string>();

  constructor(private readonly options: SnapshotServiceOptions) {
    this.logger = options.logger ?? createSilentLogger();
    this.now = options.now ?? Date.now;
    this.root = options.dataDir ? path.join(options.dataDir, "snapshots") : undefined;
  }

  // -------------------------------------------------------------------------
  // 回合钩子（AgentManager 调用，不阻塞事件链）
  // -------------------------------------------------------------------------

  /** turn_started：拍「回合前」快照并登记索引项 */
  onTurnStarted(info: TurnInfo & { seq: number; startedAt: number }): Promise<void> {
    this.openTurns.add(`${info.agentId}:${info.turnId}`);
    return this.enqueue(info.agentId, async () => {
      const turns = await this.loadIndex(info.agentId);
      if (turns.some((turn) => turn.turnId === info.turnId)) {
        return;
      }
      const entry: SnapshotTurn = {
        turnId: info.turnId,
        seq: info.seq,
        startedAt: info.startedAt,
        before: null,
        after: null,
        changedFiles: [],
      };
      turns.push(entry);
      const skipped = await this.unavailableReason();
      if (skipped) {
        entry.skipped = skipped;
      } else {
        try {
          const result = await this.capture(info.agentId, info.cwd, {
            commit: { ref: this.agentRef(info.agentId), message: this.message(info, "before") },
          });
          if (result.ok) {
            entry.before = result.commit ?? null;
          } else {
            entry.skipped = result.skipped;
          }
        } catch (error) {
          this.logger.warn("回合前快照失败（agent %s）：%s", info.agentId, errorMessage(error));
        }
      }
      await this.saveIndex(info.agentId);
    });
  }

  /** 回合结束（completed / failed / canceled）：拍「回合后」快照并计算 changedFiles */
  onTurnEnded(info: TurnInfo): Promise<void> {
    if (!this.openTurns.delete(`${info.agentId}:${info.turnId}`)) {
      return Promise.resolve();
    }
    return this.enqueue(info.agentId, async () => {
      const turns = await this.loadIndex(info.agentId);
      const entry = turns.find((turn) => turn.turnId === info.turnId);
      if (!entry || entry.skipped || entry.before === null) {
        return;
      }
      const skipped = await this.unavailableReason();
      if (skipped) {
        entry.skipped = skipped;
        await this.saveIndex(info.agentId);
        return;
      }
      try {
        const result = await this.capture(info.agentId, info.cwd, {
          commit: { ref: this.agentRef(info.agentId), message: this.message(info, "after") },
        });
        if (!result.ok) {
          entry.skipped = result.skipped;
        } else {
          entry.after = result.commit ?? null;
          if (entry.after && entry.after !== entry.before) {
            entry.changedFiles = await this.changedFiles(info.cwd, entry.before, entry.after);
          }
        }
      } catch (error) {
        this.logger.warn("回合后快照失败（agent %s）：%s", info.agentId, errorMessage(error));
      }
      await this.saveIndex(info.agentId);
    });
  }

  /** agent.delete：删除该会话的 refs/agentdeck/<agentId>，不删共享仓库 */
  async removeAgent(agentId: string, cwd: string): Promise<void> {
    this.removedAgents.add(agentId);
    await this.agentChains.get(agentId);
    this.indexes.delete(agentId);
    const git = await this.resolveGit();
    if (!git || !this.root || !this.validAgentId(agentId)) {
      return;
    }
    const repo = this.repoDir(cwd);
    if (!existsSync(path.join(repo, "HEAD"))) {
      return;
    }
    try {
      await this.withRepoLock(repo, () =>
        runGit(git, ["--git-dir", repo, "update-ref", "-d", this.agentRef(agentId)]),
      );
    } catch (error) {
      this.logger.warn("删除 agent %s 的快照引用失败：%s", agentId, errorMessage(error));
    }
  }

  // -------------------------------------------------------------------------
  // RPC
  // -------------------------------------------------------------------------

  async list(agentId: string): Promise<SnapshotTurn[]> {
    await this.agentChains.get(agentId);
    return (await this.loadIndex(agentId)).map((turn) => ({
      ...turn,
      changedFiles: [...turn.changedFiles],
    }));
  }

  async diff(
    agentId: string,
    turnId: string,
    options: { path?: string; against?: "after" | "current" } = {},
  ): Promise<{ diff: string; truncated: boolean }> {
    const cwd = this.requireCwd(agentId);
    const entry = await this.requireEntry(agentId, turnId);
    const filePath = options.path !== undefined ? assertRelativePath(options.path) : undefined;
    const git = await this.requireGit();
    const against = options.against ?? "after";
    if (entry.before === null || (against === "after" && entry.after === null)) {
      return { diff: "", truncated: false };
    }
    const repo = this.repoDir(cwd);
    const before = entry.before;
    const after = entry.after;
    return this.withRepoLock(repo, async () => {
      let target: string;
      if (against === "after") {
        target = after as string;
      } else {
        const current = await this.captureLocked(git, agentId, cwd, {});
        if (!current.ok) {
          throw new AgentRpcError("INTERNAL_ERROR", "工作区文件过多，无法生成当前差异");
        }
        target = current.tree;
      }
      const args = [
        ...this.gitPrefix(repo, cwd),
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        before,
        target,
        ...(filePath !== undefined ? ["--", filePath] : []),
      ];
      const result = await runGit(git, args, { maxBytes: SNAPSHOT_DIFF_MAX_BYTES });
      if (result.code !== 0 && !result.truncated) {
        throw new AgentRpcError("INTERNAL_ERROR", `生成差异失败：${result.stderr.trim()}`);
      }
      return { diff: result.stdout.toString("utf8"), truncated: result.truncated };
    });
  }

  async restore(
    agentId: string,
    turnId: string,
    paths?: string[],
  ): Promise<{ restored: string[]; deleted: string[]; backupCommit: string }> {
    const cwd = this.requireCwd(agentId);
    const entry = await this.requireEntry(agentId, turnId);
    const selected = paths ? paths.map(assertRelativePath) : null;
    if (this.options.isCwdBusy(cwd)) {
      throw new AgentRpcError("TURN_IN_PROGRESS", "该工作目录上有会话正在执行回合，无法回滚文件");
    }
    if (entry.pruned || entry.before === null) {
      throw new AgentRpcError("NOT_SUPPORTED", "该回合没有可用的快照，无法回滚");
    }
    const git = await this.requireGit();
    const repo = this.repoDir(cwd);
    const before = entry.before;
    return this.withRepoLock(repo, async () => {
      if (!existsSync(path.join(repo, "HEAD"))) {
        throw new AgentRpcError("NOT_SUPPORTED", "该工作目录的快照已被清理，无法回滚");
      }
      const backup = await this.captureLocked(git, agentId, cwd, {
        commit: { ref: RESTORE_REF, message: `AgentDeck 恢复前快照\n\nagent: ${agentId}\nturn: ${turnId}\n` },
      });
      if (!backup.ok || !backup.commit) {
        throw new AgentRpcError("INTERNAL_ERROR", "无法创建恢复前快照，已放弃回滚");
      }
      const changes = await this.diffNameStatus(git, repo, cwd, before, backup.commit);
      const toDelete = changes.filter((c) => c.status === "A" && pathSelected(c.path, selected));
      const toCheckout = changes.filter((c) => c.status !== "A" && pathSelected(c.path, selected));

      const deleted: string[] = [];
      for (const change of toDelete) {
        const target = path.resolve(cwd, change.path);
        if (!target.startsWith(path.resolve(cwd) + path.sep)) {
          continue;
        }
        await rm(target, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
        await this.pruneEmptyDirs(path.dirname(target), path.resolve(cwd));
        deleted.push(change.path);
      }
      const restored: string[] = [];
      if (toCheckout.length > 0) {
        const input = `${toCheckout.map((c) => c.path).join("\0")}\0`;
        const result = await runGit(
          git,
          [...this.gitPrefix(repo, cwd), "checkout", before, "--pathspec-from-file=-", "--pathspec-file-nul"],
          { input },
        );
        if (result.code !== 0) {
          throw new AgentRpcError("INTERNAL_ERROR", `检出文件失败：${result.stderr.trim()}`);
        }
        restored.push(...toCheckout.map((c) => c.path));
      }
      return { restored, deleted, backupCommit: backup.commit };
    });
  }

  async storage(): Promise<Array<{ cwd: string; bytes: number }>> {
    if (!this.root || !existsSync(this.root)) {
      return [];
    }
    const repos: Array<{ cwd: string; bytes: number }> = [];
    for (const name of await readdir(this.root)) {
      const dir = path.join(this.root, name);
      try {
        const meta = JSON.parse(await readFile(path.join(dir, "meta.json"), "utf8")) as { cwd?: string };
        if (typeof meta.cwd === "string") {
          repos.push({ cwd: meta.cwd, bytes: await directorySize(dir) });
        }
      } catch {
        // 损坏或不是影子仓库目录：忽略
      }
    }
    return repos.sort((a, b) => b.bytes - a.bytes);
  }

  async prune(cwd: string): Promise<void> {
    if (this.options.isCwdBusy(cwd)) {
      throw new AgentRpcError("TURN_IN_PROGRESS", "该工作目录上有会话正在执行回合，无法清理快照");
    }
    if (!this.root) {
      return;
    }
    const repo = this.repoDir(cwd);
    await this.withRepoLock(repo, () =>
      rm(path.dirname(repo), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
    );
    const key = normalizeCwd(cwd);
    for (const agent of this.options.listAgents()) {
      if (normalizeCwd(agent.cwd) !== key) {
        continue;
      }
      await this.enqueue(agent.id, async () => {
        const turns = await this.loadIndex(agent.id);
        let changed = false;
        for (const turn of turns) {
          if (!turn.pruned && (turn.before !== null || turn.after !== null)) {
            turn.pruned = true;
            changed = true;
          }
        }
        if (changed) {
          await this.saveIndex(agent.id);
        }
      });
    }
  }

  /** 等待全部排队中的快照任务完成（测试 / 关闭时使用） */
  async idle(): Promise<void> {
    await Promise.all(Array.from(this.agentChains.values()));
  }

  // -------------------------------------------------------------------------
  // 内部：git 与影子仓库
  // -------------------------------------------------------------------------

  private validAgentId(agentId: string): boolean {
    return /^[A-Za-z0-9._-]+$/.test(agentId) && !agentId.includes("..");
  }

  private agentRef(agentId: string): string {
    return `refs/agentdeck/${agentId}`;
  }

  private message(info: TurnInfo, phase: "before" | "after"): string {
    return `AgentDeck 回合快照（${phase === "before" ? "回合前" : "回合后"}）\n\nagent: ${info.agentId}\nturn: ${info.turnId}\n`;
  }

  private repoDir(cwd: string): string {
    return path.join(this.root as string, repoKeyOf(cwd), "repo");
  }

  private gitPrefix(repo: string, cwd: string): string[] {
    return [
      `--git-dir=${repo}`,
      `--work-tree=${cwd}`,
      "--literal-pathspecs",
      "-c", "core.autocrlf=false",
      "-c", "core.safecrlf=false",
      "-c", "core.quotepath=false",
      "-c", "core.fsmonitor=false",
      "-c", "core.longpaths=true",
      "-c", "gc.auto=0",
      "-c", "user.name=AgentDeck",
      "-c", "user.email=agentdeck@localhost",
    ];
  }

  private resolveGit(): Promise<string | null> {
    if (!this.gitPromise) {
      this.gitPromise =
        this.options.gitPath !== undefined ? Promise.resolve(this.options.gitPath) : locateGit();
    }
    return this.gitPromise.then((git) => {
      if (!git && !this.gitWarned) {
        this.gitWarned = true;
        this.logger.warn("未找到 git，按回合文件快照功能已关闭");
      }
      return git;
    });
  }

  private async requireGit(): Promise<string> {
    const git = await this.resolveGit();
    if (!git || !this.root) {
      throw new AgentRpcError("NOT_SUPPORTED", "文件快照不可用（未找到 git 或未启用持久化）");
    }
    return git;
  }

  /** 快照整体不可用的原因；可用返回 undefined */
  private async unavailableReason(): Promise<SnapshotSkipReason | undefined> {
    if (!this.options.settings().enabled) {
      return "disabled";
    }
    if (!this.root) {
      return "disabled";
    }
    return (await this.resolveGit()) ? undefined : "git_unavailable";
  }

  private withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.repoLocks.get(repo) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.repoLocks.set(repo, settled);
    void settled.then(() => {
      if (this.repoLocks.get(repo) === settled) {
        this.repoLocks.delete(repo);
      }
    });
    return next;
  }

  private async capture(
    agentId: string,
    cwd: string,
    options: { commit?: { ref: string; message: string } },
  ): Promise<CaptureResult> {
    if (!this.validAgentId(agentId)) {
      throw new Error(`非法的 agentId：${agentId}`);
    }
    const git = await this.requireGit();
    return this.withRepoLock(this.repoDir(cwd), () => this.captureLocked(git, agentId, cwd, options));
  }

  /** 已持有 repo 锁：确保影子仓库 → 暂存变化 → 写树 →（可选）提交（树相同复用） */
  private async captureLocked(
    git: string,
    _agentId: string,
    cwd: string,
    options: { commit?: { ref: string; message: string } },
  ): Promise<CaptureResult> {
    const repo = this.repoDir(cwd);
    await this.ensureRepo(git, repo, cwd);
    const prefix = this.gitPrefix(repo, cwd);
    const settings = this.options.settings();

    const list = async (flag: string): Promise<string[]> => {
      const args = flag === "-o" ? ["ls-files", "-z", "-o", "--exclude-standard"] : ["ls-files", "-z", flag];
      const result = await runGit(git, [...prefix, ...args]);
      if (result.code !== 0) {
        throw new Error(`git ls-files 失败：${result.stderr.trim()}`);
      }
      return splitNul(result.stdout);
    };
    // 嵌套仓库在 -o 里以 "dir/" 出现，直接忽略
    const untracked = (await list("-o")).filter((file) => !file.endsWith("/"));
    const deleted = new Set(await list("-d"));
    const modified = (await list("-m")).filter((file) => !deleted.has(file));

    if (untracked.length + modified.length + deleted.size > settings.maxFiles) {
      return { ok: false, skipped: "too_many_files" };
    }

    const toAdd: string[] = [...deleted];
    const toUntrack: string[] = [];
    const trackedModified = new Set(modified);
    const sizeChecked = await mapWithConcurrency(
      [...untracked, ...modified],
      STAT_CONCURRENCY,
      async (file) => {
        try {
          const stat = await lstat(path.join(cwd, file));
          return { file, oversize: stat.size > settings.maxFileBytes, gone: false };
        } catch {
          return { file, oversize: false, gone: true };
        }
      },
    );
    for (const item of sizeChecked) {
      if (item.oversize) {
        if (trackedModified.has(item.file)) {
          toUntrack.push(item.file);
        }
      } else {
        toAdd.push(item.file);
      }
    }

    if (toUntrack.length > 0) {
      await this.runChecked(git, [...prefix, "rm", "--cached", "-q", "--pathspec-from-file=-", "--pathspec-file-nul"], `${toUntrack.join("\0")}\0`);
    }
    if (toAdd.length > 0) {
      await this.runChecked(git, [...prefix, "add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], `${toAdd.join("\0")}\0`);
    }
    const tree = (await this.runChecked(git, [...prefix, "write-tree"])).trim();

    if (!options.commit) {
      return { ok: true, tree };
    }
    const { ref, message } = options.commit;
    const parent = await this.revParse(git, repo, `${ref}^{commit}`);
    if (parent) {
      const parentTree = await this.revParse(git, repo, `${parent}^{tree}`);
      if (parentTree === tree) {
        return { ok: true, tree, commit: parent };
      }
    }
    const commit = (
      await this.runChecked(
        git,
        [...prefix, "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-F", "-"],
        message,
      )
    ).trim();
    await this.runChecked(git, [...prefix, "update-ref", ref, commit]);
    return { ok: true, tree, commit };
  }

  private async ensureRepo(git: string, repo: string, cwd: string): Promise<void> {
    if (!existsSync(cwd)) {
      throw new Error(`工作目录不存在：${cwd}`);
    }
    if (existsSync(path.join(repo, "HEAD"))) {
      return;
    }
    const base = path.dirname(repo);
    await mkdir(base, { recursive: true });
    const init = await runGit(git, ["init", "--bare", "--quiet", repo], { cwd: base });
    if (init.code !== 0) {
      throw new Error(`初始化影子仓库失败：${init.stderr.trim()}`);
    }
    await mkdir(path.join(repo, "info"), { recursive: true });
    await writeFile(path.join(repo, "info", "exclude"), `${DEFAULT_EXCLUDE_RULES.join("\n")}\n`, "utf8");
    await writeFile(path.join(base, "meta.json"), `${JSON.stringify({ cwd })}\n`, "utf8");
  }

  private async revParse(git: string, repo: string, rev: string): Promise<string | null> {
    const result = await runGit(git, [`--git-dir=${repo}`, "rev-parse", "-q", "--verify", rev]);
    const out = result.stdout.toString("utf8").trim();
    return result.code === 0 && out ? out : null;
  }

  private async runChecked(git: string, args: string[], input?: string): Promise<string> {
    const result = await runGit(git, args, input !== undefined ? { input } : {});
    if (result.code !== 0) {
      const name = args.find((arg) => !arg.startsWith("-") && !arg.includes("=") && !arg.includes(path.sep)) ?? "git";
      throw new Error(`git ${name} 失败：${result.stderr.trim()}`);
    }
    return result.stdout.toString("utf8");
  }

  private async diffNameStatus(
    git: string,
    repo: string,
    cwd: string,
    from: string,
    to: string,
  ): Promise<SnapshotChangedFile[]> {
    const out = await this.runChecked(git, [
      ...this.gitPrefix(repo, cwd),
      "diff-tree",
      "-r",
      "-z",
      "--name-status",
      "--no-renames",
      from,
      to,
    ]);
    const parts = out.split("\0").filter((part) => part.length > 0);
    const files: SnapshotChangedFile[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const code = (parts[i] as string).charAt(0);
      const status = code === "A" || code === "D" || code === "R" ? code : "M";
      files.push({ status, path: parts[i + 1] as string });
    }
    return files;
  }

  private async changedFiles(cwd: string, before: string, after: string): Promise<SnapshotChangedFile[]> {
    const git = await this.requireGit();
    const repo = this.repoDir(cwd);
    return this.withRepoLock(repo, () => this.diffNameStatus(git, repo, cwd, before, after));
  }

  private async pruneEmptyDirs(dir: string, stop: string): Promise<void> {
    let current = dir;
    while (current.startsWith(stop + path.sep)) {
      try {
        await rmdir(current);
      } catch {
        return;
      }
      current = path.dirname(current);
    }
  }

  // -------------------------------------------------------------------------
  // 内部：索引与队列
  // -------------------------------------------------------------------------

  private requireCwd(agentId: string): string {
    const cwd = this.options.agentCwd(agentId);
    if (cwd === undefined) {
      throw new AgentRpcError("AGENT_NOT_FOUND", `未知的 agent：${agentId}`);
    }
    return cwd;
  }

  private async requireEntry(agentId: string, turnId: string): Promise<SnapshotTurn> {
    await this.agentChains.get(agentId);
    const entry = (await this.loadIndex(agentId)).find((turn) => turn.turnId === turnId);
    if (!entry) {
      throw new AgentInvalidParamsError(`该会话没有回合 ${turnId} 的快照`);
    }
    return entry;
  }

  private enqueue(agentId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.agentChains.get(agentId) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (this.removedAgents.has(agentId)) {
        return;
      }
      try {
        await task();
      } catch (error) {
        this.logger.warn("快照任务失败（agent %s）：%s", agentId, errorMessage(error));
      }
    });
    this.agentChains.set(agentId, next);
    return next;
  }

  private indexFile(agentId: string): string | undefined {
    return this.options.dataDir
      ? path.join(this.options.dataDir, "agents", agentId, SNAPSHOT_INDEX_FILE)
      : undefined;
  }

  private async loadIndex(agentId: string): Promise<SnapshotTurn[]> {
    const cached = this.indexes.get(agentId);
    if (cached) {
      return cached;
    }
    let turns: SnapshotTurn[] = [];
    const file = this.indexFile(agentId);
    if (file) {
      try {
        const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
        if (Array.isArray(parsed)) {
          turns = parsed as SnapshotTurn[];
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          this.logger.warn("读取 agent %s 的快照索引失败：%s", agentId, errorMessage(error));
        }
      }
    }
    this.indexes.set(agentId, turns);
    return turns;
  }

  private async saveIndex(agentId: string): Promise<void> {
    const file = this.indexFile(agentId);
    const turns = this.indexes.get(agentId);
    if (!file || !turns || this.removedAgents.has(agentId)) {
      return;
    }
    await mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, `${JSON.stringify(turns)}\n`);
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(full);
    } else {
      try {
        total += (await lstat(full)).size;
      } catch {
        // 文件在遍历中被删除：忽略
      }
    }
  }
  return total;
}
