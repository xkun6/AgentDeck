import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

import type {
  AgentSnapshot,
  AgentStreamEnvelope,
  Board,
  BoardAssignee,
  BoardSettings,
  BoardSettingsPatch,
  BoardTask,
  BoardTaskDraft,
  BoardTaskStatus,
} from "@agentdeck/protocol";

import type { AgentManager } from "../agent/agent-manager.js";
import { AgentInvalidParamsError, AgentRpcError } from "../agent/errors.js";
import { addWorktree, removeWorktree } from "../git/worktree.js";
import { createSilentLogger, type Logger } from "../logger.js";
import { locateGit, runGit } from "../snapshots/git.js";
import { BoardStore, boardKey } from "./store.js";

export const TASK_DONE_MARKER = "TASK_DONE";
export const TASK_BLOCKED_MARKER = "TASK_BLOCKED:";
export const DEFAULT_MAX_CONCURRENT = 2;
export const DEFAULT_MAX_ATTEMPTS = 2;
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 20_000;
const SEND_RETRY_DELAY_MS = 100;
const SEND_RETRY_MAX = 5;

export type BoardManager = Pick<
  AgentManager,
  "subscribe" | "getAgent" | "createAgent" | "sendPrompt" | "cancel" | "timeline"
>;

export interface BoardServiceOptions {
  manager: BoardManager;
  store: BoardStore;
  /** AGENTDECK_DATA_DIR：任务 worktree 放在 `<dataDir>/worktrees/task-<id>`；不传则不建 worktree */
  dataDir?: string;
  logger?: Logger;
  now?: () => number;
}

export interface BoardListener {
  onChanged?(projectPath: string, board: Board): void;
}

export interface TurnOutcome {
  kind: "completed" | "failed" | "canceled";
  /** 本回合最后一条助手消息文本 */
  text: string;
  error?: string;
}

interface TurnTracker {
  background: boolean;
  messageId: string | null;
  text: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isBusy(agent: AgentSnapshot): boolean {
  return agent.status === "running" || agent.status === "starting" || Boolean(agent.activeTurnId);
}

/** 任务提示：标题 + 描述 + 末行标记约定 */
export function taskPrompt(task: Pick<BoardTask, "title" | "description">): string {
  const parts = [`任务：${task.title}`];
  if (task.description.trim()) {
    parts.push(task.description.trim());
  }
  parts.push(`完成后在最后单独一行输出 ${TASK_DONE_MARKER}；无法完成时输出 ${TASK_BLOCKED_MARKER} <原因>`);
  return parts.join("\n\n");
}

/** 末行标记判定：TASK_DONE → review；TASK_BLOCKED: 原因 → blocked；都没有 → review */
export function parseTaskMarker(text: string): { status: "review" | "blocked"; reason?: string } {
  const lines = text.split("\n").map((line) => line.trim());
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const last = lines[lines.length - 1] ?? "";
  if (last === TASK_DONE_MARKER) {
    return { status: "review" };
  }
  if (last.startsWith(TASK_BLOCKED_MARKER)) {
    return { status: "blocked", reason: last.slice(TASK_BLOCKED_MARKER.length).trim() || "未说明原因" };
  }
  return { status: "review" };
}

/**
 * 从时间线取最后一个已结束回合（重启补判用）。末尾有尚未结束的回合 → "unfinished"；
 * 没有任何已结束回合 → null。
 */
export function lastTurnFromTimeline(entries: AgentStreamEnvelope[]): TurnOutcome | "unfinished" | null {
  let lastStart = -1;
  let lastEnd = -1;
  entries.forEach((entry, index) => {
    const type = entry.event.type;
    if (type === "turn_started") {
      lastStart = index;
    } else if (type === "turn_completed" || type === "turn_failed" || type === "turn_canceled") {
      lastEnd = index;
    }
  });
  if (lastStart > lastEnd) {
    return "unfinished";
  }
  if (lastEnd < 0) {
    return null;
  }
  let start = lastEnd;
  while (start > 0 && entries[start]!.event.type !== "turn_started") {
    start -= 1;
  }
  let messageId: string | null = null;
  let text = "";
  for (let index = start; index <= lastEnd; index += 1) {
    const event = entries[index]!.event;
    if (event.type === "timeline" && event.item.type === "assistant_message" && event.item.source !== "command") {
      const item = event.item;
      if (item.messageId !== undefined && item.messageId !== messageId) {
        messageId = item.messageId;
        text = item.text;
      } else {
        text += item.text;
      }
    }
  }
  const end = entries[lastEnd]!.event;
  return {
    kind: end.type === "turn_completed" ? "completed" : end.type === "turn_failed" ? "failed" : "canceled",
    text,
    ...(end.type === "turn_failed" ? { error: end.error } : {}),
  };
}

function cloneBoard(board: Board): Board {
  return structuredClone(board);
}

function nextOrder(board: Board, status: BoardTaskStatus): number {
  const orders = board.tasks.filter((task) => task.status === status).map((task) => task.order);
  return orders.length > 0 ? Math.max(...orders) + 1 : 1;
}

/** 看板式任务分派（design.md 4.28）：任务 → Agent 会话派发、回合结束判定、失败重试、合并 */
export class BoardService {
  private readonly manager: BoardManager;
  private readonly store: BoardStore;
  private readonly dataDir: string | undefined;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly listeners = new Set<BoardListener>();
  private readonly boards = new Map<string, Board>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly trackers = new Map<string, TurnTracker>();
  private unsubscribe: (() => void) | null = null;
  private gitPathPromise: Promise<string | null> | null = null;

  constructor(options: BoardServiceOptions) {
    this.manager = options.manager;
    this.store = options.store;
    this.dataDir = options.dataDir;
    this.logger = options.logger ?? createSilentLogger();
    this.now = options.now ?? Date.now;
  }

  subscribe(listener: BoardListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  /** 加载全部看板，补判重启前仍在 running 的任务，检查自动派发 */
  async start(): Promise<void> {
    for (const board of await this.store.loadAll()) {
      this.boards.set(boardKey(board.projectPath), board);
    }
    this.unsubscribe = this.manager.subscribe({
      onStream: (envelope) => this.handleStream(envelope),
      onRemoved: (agentId) => this.handleAgentRemoved(agentId),
    });
    for (const board of [...this.boards.values()]) {
      await this.withLock(board.projectPath, async () => {
        const live = this.boards.get(boardKey(board.projectPath));
        if (!live) {
          return;
        }
        await this.reconcile(live);
        await this.fill(live);
      });
    }
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.store.flush();
  }

  // -------------------------------------------------------------------------
  // RPC 入口
  // -------------------------------------------------------------------------

  async get(projectPath: string): Promise<Board> {
    return this.withLock(projectPath, async () => {
      const existing = await this.load(projectPath);
      return cloneBoard(existing ?? (await this.defaultBoard(projectPath)));
    });
  }

  async updateSettings(projectPath: string, patch: BoardSettingsPatch): Promise<Board> {
    return this.mutate(projectPath, async (board) => {
      const next: BoardSettings = { ...board.settings };
      if (patch.worktreePerTask !== undefined) {
        next.worktreePerTask = patch.worktreePerTask;
      }
      if (patch.autoDispatch !== undefined) {
        next.autoDispatch = patch.autoDispatch;
      }
      if (patch.maxConcurrent !== undefined) {
        next.maxConcurrent = patch.maxConcurrent;
      }
      if (patch.defaultAssignee !== undefined) {
        next.defaultAssignee = patch.defaultAssignee;
      }
      board.settings = next;
    });
  }

  async upsertTask(projectPath: string, draft: BoardTaskDraft): Promise<{ board: Board; task: BoardTask }> {
    let taskId = draft.id ?? "";
    const board = await this.mutate(projectPath, async (current) => {
      const title = draft.title.trim();
      if (title.length < 1 || title.length > TITLE_MAX) {
        throw new AgentInvalidParamsError(`任务标题长度需在 1–${TITLE_MAX} 之间`);
      }
      const description = draft.description ?? undefined;
      if (description !== undefined && description.length > DESCRIPTION_MAX) {
        throw new AgentInvalidParamsError(`任务描述不能超过 ${DESCRIPTION_MAX} 字`);
      }
      const existing = draft.id ? current.tasks.find((task) => task.id === draft.id) : undefined;
      if (draft.id && !existing) {
        throw new AgentRpcError("TASK_NOT_FOUND", `任务不存在：${draft.id}`);
      }
      const id = existing?.id ?? randomUUID();
      const dependsOn = draft.dependsOn ?? existing?.dependsOn ?? [];
      this.validateDependsOn(current, id, dependsOn);
      const now = this.now();
      if (existing) {
        existing.title = title;
        if (description !== undefined) {
          existing.description = description;
        }
        if (draft.assignee === null) {
          delete existing.assignee;
        } else if (draft.assignee) {
          existing.assignee = draft.assignee;
        }
        if (dependsOn.length > 0) {
          existing.dependsOn = dependsOn;
        } else {
          delete existing.dependsOn;
        }
        if (draft.maxAttempts !== undefined) {
          existing.maxAttempts = draft.maxAttempts;
        }
        existing.updatedAt = now;
      } else {
        current.tasks.push({
          id,
          title,
          description: description ?? "",
          status: "todo",
          ...(draft.assignee ? { assignee: draft.assignee } : {}),
          ...(dependsOn.length > 0 ? { dependsOn } : {}),
          attempts: 0,
          maxAttempts: draft.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
          order: nextOrder(current, "todo"),
          createdAt: now,
          updatedAt: now,
        });
      }
      taskId = id;
    });
    return { board, task: board.tasks.find((task) => task.id === taskId)! };
  }

  async deleteTask(
    projectPath: string,
    taskId: string,
    removeWorktreeToo = false,
  ): Promise<{ board: Board; warning?: string }> {
    let warning: string | undefined;
    const board = await this.mutate(projectPath, async (current) => {
      const task = this.requireTask(current, taskId);
      if (task.status === "running") {
        await this.interrupt(task);
      }
      if (removeWorktreeToo && task.worktree) {
        try {
          await removeWorktree({
            repoCwd: current.projectPath,
            path: task.worktree.path,
            branch: task.worktree.branch,
            deleteBranch: true,
          });
        } catch (error) {
          warning = errorMessage(error);
          this.logger.warn("删除任务 %s 的 worktree 失败：%s", taskId, warning);
        }
      }
      current.tasks = current.tasks.filter((item) => item.id !== taskId);
      for (const item of current.tasks) {
        if (item.dependsOn?.includes(taskId)) {
          const rest = item.dependsOn.filter((dep) => dep !== taskId);
          if (rest.length > 0) {
            item.dependsOn = rest;
          } else {
            delete item.dependsOn;
          }
        }
      }
    });
    return { board, ...(warning ? { warning } : {}) };
  }

  async moveTask(projectPath: string, taskId: string, status: BoardTaskStatus, order?: number): Promise<Board> {
    return this.mutate(projectPath, async (board) => {
      const task = this.requireTask(board, taskId);
      const previous = task.status;
      if (order !== undefined) {
        task.order = order;
      } else if (previous !== status) {
        task.order = nextOrder(board, status);
      }
      task.updatedAt = this.now();
      if (previous === status) {
        return;
      }
      if (status === "running") {
        await this.dispatch(board, task);
        return;
      }
      if (previous === "running") {
        await this.interrupt(task);
      }
      task.status = status;
      delete task.blockedReason;
    });
  }

  async merge(
    projectPath: string,
    taskId: string,
    removeWorktreeToo: boolean,
  ): Promise<{ ok: boolean; conflicts?: string[]; board: Board; warning?: string }> {
    let result: { ok: boolean; conflicts?: string[]; warning?: string } = { ok: false };
    const board = await this.mutate(projectPath, async (current) => {
      const task = this.requireTask(current, taskId);
      if (task.status !== "review") {
        throw new Error("只有待评审的任务可以合并");
      }
      const worktree = task.worktree;
      if (!worktree) {
        throw new Error("该任务没有独立分支（未使用 worktree），无需合并");
      }
      const gitPath = await this.locateGit();
      if (!gitPath) {
        throw new Error("未找到 git，无法合并");
      }
      const repo = current.projectPath;
      if (!existsSync(worktree.path)) {
        throw new Error(`任务 worktree 目录不存在：${worktree.path}`);
      }
      const dirty = await runGit(gitPath, ["status", "--porcelain", "--untracked-files=no"], { cwd: repo });
      if (dirty.code !== 0) {
        throw new Error(`读取项目工作区状态失败：${dirty.stderr.trim() || "未知错误"}`);
      }
      if (dirty.stdout.toString("utf8").trim()) {
        throw new Error("项目工作区有未提交改动，请先提交或暂存后再合并");
      }
      // Agent 常常不提交：合并前把 worktree 里的改动提交到任务分支
      await this.commitWorktree(gitPath, worktree.path, task.title);
      const merged = await runGit(gitPath, ["merge", "--no-ff", "--no-edit", worktree.branch], { cwd: repo });
      if (merged.code !== 0) {
        const unmerged = await runGit(gitPath, ["diff", "--name-only", "--diff-filter=U"], { cwd: repo });
        const conflicts = unmerged.stdout
          .toString("utf8")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        await runGit(gitPath, ["merge", "--abort"], { cwd: repo }).catch(() => undefined);
        if (conflicts.length > 0) {
          result = { ok: false, conflicts };
          return;
        }
        throw new Error(`合并失败：${merged.stderr.trim() || merged.stdout.toString("utf8").trim() || "未知错误"}`);
      }
      task.status = "done";
      delete task.blockedReason;
      task.order = nextOrder(current, "done");
      task.updatedAt = this.now();
      result = { ok: true };
      if (removeWorktreeToo) {
        try {
          await removeWorktree({
            repoCwd: repo,
            path: worktree.path,
            branch: worktree.branch,
            deleteBranch: true,
          });
          delete task.worktree;
        } catch (error) {
          result.warning = errorMessage(error);
        }
      }
    });
    return { ...result, board };
  }

  // -------------------------------------------------------------------------
  // 内部：加载 / 锁 / 提交
  // -------------------------------------------------------------------------

  private withLock<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
    const key = boardKey(projectPath);
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.then(fn);
    this.locks.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /** 加锁修改看板：fn 后提交（落盘 + 通知），再检查自动派发；返回看板副本 */
  private mutate(projectPath: string, fn: (board: Board) => Promise<void>): Promise<Board> {
    return this.withLock(projectPath, async () => {
      const board = (await this.load(projectPath)) ?? (await this.createBoard(projectPath));
      const backup = cloneBoard(board);
      try {
        await fn(board);
      } catch (error) {
        // 校验失败不留半截修改
        board.settings = backup.settings;
        board.tasks = backup.tasks;
        throw error;
      }
      this.commit(board);
      await this.fill(board);
      return cloneBoard(board);
    });
  }

  private async load(projectPath: string): Promise<Board | null> {
    const key = boardKey(projectPath);
    const cached = this.boards.get(key);
    if (cached) {
      return cached;
    }
    const loaded = await this.store.load(projectPath);
    if (loaded) {
      this.boards.set(key, loaded);
    }
    return loaded;
  }

  private async createBoard(projectPath: string): Promise<Board> {
    const board = await this.defaultBoard(projectPath);
    this.boards.set(boardKey(projectPath), board);
    return board;
  }

  private async defaultBoard(projectPath: string): Promise<Board> {
    const normalized = projectPath.trim().replace(/[\\/]+$/, "") || projectPath.trim();
    return {
      projectPath: normalized,
      settings: {
        worktreePerTask: await this.isGitRepo(normalized),
        autoDispatch: false,
        maxConcurrent: DEFAULT_MAX_CONCURRENT,
        defaultAssignee: { provider: "claude" },
      },
      tasks: [],
    };
  }

  private commit(board: Board): void {
    void this.store.save(cloneBoard(board));
    const snapshot = cloneBoard(board);
    for (const listener of this.listeners) {
      try {
        listener.onChanged?.(board.projectPath, snapshot);
      } catch (error) {
        this.logger.error("board.changed 监听器出错：%s", String(error));
      }
    }
  }

  private requireTask(board: Board, taskId: string): BoardTask {
    const task = board.tasks.find((item) => item.id === taskId);
    if (!task) {
      throw new AgentRpcError("TASK_NOT_FOUND", `任务不存在：${taskId}`);
    }
    return task;
  }

  private validateDependsOn(board: Board, taskId: string, dependsOn: string[]): void {
    const byId = new Map(board.tasks.map((task) => [task.id, task]));
    for (const dep of dependsOn) {
      if (dep === taskId) {
        throw new AgentInvalidParamsError("任务不能依赖自己");
      }
      if (!byId.has(dep)) {
        throw new AgentInvalidParamsError(`依赖的任务不存在或不在同一看板：${dep}`);
      }
    }
    // 成环检测：从各依赖出发沿 dependsOn 走，能回到本任务即成环
    const seen = new Set<string>();
    const stack = [...dependsOn];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === taskId) {
        throw new AgentInvalidParamsError("依赖关系不能成环");
      }
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);
      stack.push(...(byId.get(current)?.dependsOn ?? []));
    }
  }

  // -------------------------------------------------------------------------
  // 派发
  // -------------------------------------------------------------------------

  private async dispatch(board: Board, task: BoardTask): Promise<void> {
    const assignee: BoardAssignee = task.assignee ?? board.settings.defaultAssignee;
    let createdWorktree: { path: string; branch: string } | undefined;
    try {
      let worktree = task.worktree && existsSync(task.worktree.path) ? task.worktree : undefined;
      if (!worktree && this.dataDir && board.settings.worktreePerTask && (await this.isGitRepo(board.projectPath))) {
        createdWorktree = await addWorktree({
          repoCwd: board.projectPath,
          path: path.join(this.dataDir, "worktrees", `task-${task.id}`),
          branch: `agentdeck/task-${task.id}`,
        });
        worktree = createdWorktree;
      }
      let agentId = task.agentId && this.reusableAgent(task.agentId) ? task.agentId : undefined;
      if (!agentId) {
        const created = await this.manager.createAgent({
          provider: assignee.provider,
          cwd: worktree?.path ?? board.projectPath,
          origin: "kanban",
          title: task.title,
          ...(assignee.model ? { model: assignee.model } : {}),
          ...(assignee.modeId ? { modeId: assignee.modeId } : {}),
        });
        agentId = created.id;
      }
      task.status = "running";
      task.agentId = agentId;
      task.attempts = 0;
      delete task.blockedReason;
      if (worktree) {
        task.worktree = worktree;
      } else {
        delete task.worktree;
      }
      task.updatedAt = this.now();
      // 先落状态再发送：回合结束事件要能找到这个 running 任务（事件处理排在本锁之后）
      this.commit(board);
      await this.sendInternal(agentId, taskPrompt(task));
    } catch (error) {
      this.logger.warn("派发任务 %s 失败：%s", task.id, errorMessage(error));
      if (createdWorktree && task.worktree?.path !== createdWorktree.path) {
        await removeWorktree({
          repoCwd: board.projectPath,
          path: createdWorktree.path,
          branch: createdWorktree.branch,
          deleteBranch: true,
        }).catch(() => undefined);
      }
      task.status = "blocked";
      task.blockedReason = `派发失败：${errorMessage(error)}`;
      task.updatedAt = this.now();
    }
  }

  /** 会话还在且空闲才复用（重新拖回 running 时沿用原会话） */
  private reusableAgent(agentId: string): boolean {
    try {
      return !isBusy(this.manager.getAgent(agentId));
    } catch {
      return false;
    }
  }

  /** 自动派发：依赖全 done 的 todo 按 order，受 maxConcurrent 限制 */
  private async fill(board: Board): Promise<void> {
    if (!board.settings.autoDispatch) {
      return;
    }
    for (;;) {
      const running = board.tasks.filter((task) => task.status === "running").length;
      if (running >= board.settings.maxConcurrent) {
        return;
      }
      const done = new Set(board.tasks.filter((task) => task.status === "done").map((task) => task.id));
      const known = new Set(board.tasks.map((task) => task.id));
      const next = board.tasks
        .filter((task) => task.status === "todo" && (task.dependsOn ?? []).every((dep) => done.has(dep) || !known.has(dep)))
        .sort((a, b) => a.order - b.order)[0];
      if (!next) {
        return;
      }
      await this.dispatch(board, next);
      this.commit(board);
    }
  }

  private async interrupt(task: BoardTask): Promise<void> {
    if (!task.agentId) {
      return;
    }
    try {
      await this.manager.cancel(task.agentId);
    } catch (error) {
      this.logger.warn("中断任务 %s 的会话失败：%s", task.id, errorMessage(error));
    }
  }

  private async sendInternal(agentId: string, text: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.manager.sendPrompt(agentId, text, undefined, { internal: true });
        return;
      } catch (error) {
        const busy = error instanceof AgentRpcError && error.code === "TURN_IN_PROGRESS";
        if (!busy || attempt >= SEND_RETRY_MAX) {
          throw error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, SEND_RETRY_DELAY_MS));
      }
    }
  }

  // -------------------------------------------------------------------------
  // 回合结束 / 会话删除 / 重启补判
  // -------------------------------------------------------------------------

  private handleStream(envelope: AgentStreamEnvelope): void {
    const { agentId, event } = envelope;
    switch (event.type) {
      case "turn_started":
        this.trackers.set(agentId, { background: event.origin === "background", messageId: null, text: "" });
        return;
      case "timeline": {
        const item = event.item;
        if (item.type !== "assistant_message" || item.source === "command") {
          return;
        }
        let tracker = this.trackers.get(agentId);
        if (!tracker) {
          tracker = { background: false, messageId: null, text: "" };
          this.trackers.set(agentId, tracker);
        }
        if (item.messageId !== undefined && item.messageId !== tracker.messageId) {
          tracker.messageId = item.messageId;
          tracker.text = item.text;
        } else {
          tracker.text += item.text;
        }
        return;
      }
      case "turn_completed":
      case "turn_failed":
      case "turn_canceled": {
        const tracker = this.trackers.get(agentId);
        this.trackers.delete(agentId);
        if (tracker?.background) {
          return;
        }
        const board = this.findBoardByAgent(agentId);
        if (!board) {
          return;
        }
        const outcome: TurnOutcome = {
          kind: event.type === "turn_completed" ? "completed" : event.type === "turn_failed" ? "failed" : "canceled",
          text: tracker?.text ?? "",
          ...(event.type === "turn_failed" ? { error: event.error } : {}),
        };
        // 延后一拍：让 AgentManager 处理完本次回合结束事件（状态回到 idle）后再处理
        void Promise.resolve().then(() => this.onTurnEnd(board.projectPath, agentId, outcome));
        return;
      }
      default:
        return;
    }
  }

  private findBoardByAgent(agentId: string): Board | undefined {
    return [...this.boards.values()].find((board) =>
      board.tasks.some((task) => task.agentId === agentId && task.status === "running"),
    );
  }

  private async onTurnEnd(projectPath: string, agentId: string, outcome: TurnOutcome): Promise<void> {
    await this.mutate(projectPath, async (board) => {
      const task = board.tasks.find((item) => item.agentId === agentId && item.status === "running");
      if (task) {
        await this.applyOutcome(task, outcome);
      }
    }).catch((error: unknown) => {
      this.logger.error("处理任务回合结束失败：%s", errorMessage(error));
    });
  }

  /** 回合结束判定（design.md 4.28）；调用方持锁 */
  private async applyOutcome(task: BoardTask, outcome: TurnOutcome): Promise<void> {
    task.updatedAt = this.now();
    if (outcome.kind === "failed") {
      task.attempts += 1;
      const reason = outcome.error ?? "未知错误";
      if (task.attempts >= task.maxAttempts) {
        task.status = "blocked";
        task.blockedReason = `执行失败（已尝试 ${task.attempts} 次）：${reason}`;
        return;
      }
      try {
        await this.sendInternal(task.agentId!, `上次执行失败：${reason}，请重试`);
      } catch (error) {
        task.status = "blocked";
        task.blockedReason = `重试发送失败：${errorMessage(error)}`;
      }
      return;
    }
    if (outcome.kind === "canceled") {
      task.status = "review";
      return;
    }
    const marker = parseTaskMarker(outcome.text);
    task.status = marker.status;
    if (marker.status === "blocked") {
      task.blockedReason = marker.reason ?? "未说明原因";
    } else {
      delete task.blockedReason;
    }
  }

  private handleAgentRemoved(agentId: string): void {
    this.trackers.delete(agentId);
    for (const board of [...this.boards.values()]) {
      if (!board.tasks.some((task) => task.agentId === agentId)) {
        continue;
      }
      void this.mutate(board.projectPath, async (current) => {
        for (const task of current.tasks) {
          if (task.agentId === agentId) {
            delete task.agentId;
            if (task.status === "running") {
              task.status = "todo";
            }
            task.updatedAt = this.now();
          }
        }
      }).catch((error: unknown) => {
        this.logger.error("处理会话删除失败：%s", errorMessage(error));
      });
    }
  }

  /** 重启后 running 任务：会话不存在 → todo；会话无进行中回合 → 按最后一个已结束回合补判 */
  private async reconcile(board: Board): Promise<void> {
    let changed = false;
    for (const task of board.tasks) {
      if (task.status !== "running") {
        continue;
      }
      changed = true;
      let agent: AgentSnapshot | undefined;
      try {
        agent = task.agentId ? this.manager.getAgent(task.agentId) : undefined;
      } catch {
        agent = undefined;
      }
      if (!agent) {
        delete task.agentId;
        task.status = "todo";
        task.updatedAt = this.now();
        continue;
      }
      if (isBusy(agent)) {
        continue;
      }
      let last: ReturnType<typeof lastTurnFromTimeline> = null;
      try {
        last = lastTurnFromTimeline((await this.manager.timeline(agent.id)).entries);
      } catch (error) {
        this.logger.warn("读取任务 %s 的会话时间线失败：%s", task.id, errorMessage(error));
      }
      if (last === null || last === "unfinished") {
        task.status = "blocked";
        task.blockedReason = "sidecar 重启时任务回合尚未结束，请检查会话后重新派发";
        task.updatedAt = this.now();
        continue;
      }
      await this.applyOutcome(task, last);
    }
    if (changed) {
      this.commit(board);
    }
  }

  // -------------------------------------------------------------------------
  // git
  // -------------------------------------------------------------------------

  private locateGit(): Promise<string | null> {
    this.gitPathPromise ??= locateGit();
    return this.gitPathPromise;
  }

  private async isGitRepo(cwd: string): Promise<boolean> {
    const gitPath = await this.locateGit();
    if (!gitPath) {
      return false;
    }
    const probe = await runGit(gitPath, ["rev-parse", "--is-inside-work-tree"], { cwd }).catch(() => null);
    return probe?.code === 0 && probe.stdout.toString("utf8").trim() === "true";
  }

  /** 把 worktree 内未提交的改动提交到任务分支；无改动则跳过 */
  private async commitWorktree(gitPath: string, cwd: string, title: string): Promise<void> {
    const status = await runGit(gitPath, ["status", "--porcelain"], { cwd });
    if (status.code !== 0 || !status.stdout.toString("utf8").trim()) {
      return;
    }
    const added = await runGit(gitPath, ["add", "-A"], { cwd });
    if (added.code !== 0) {
      throw new Error(`提交任务改动失败：${added.stderr.trim() || "git add 失败"}`);
    }
    const message = `AgentDeck 任务：${title}`;
    let committed = await runGit(gitPath, ["commit", "-m", message], { cwd });
    if (committed.code !== 0) {
      // 本机没配 git 身份时用兜底身份重试
      committed = await runGit(
        gitPath,
        ["-c", "user.name=AgentDeck", "-c", "user.email=agentdeck@localhost", "commit", "-m", message],
        { cwd },
      );
    }
    if (committed.code !== 0) {
      throw new Error(`提交任务改动失败：${committed.stderr.trim() || committed.stdout.toString("utf8").trim()}`);
    }
  }
}
