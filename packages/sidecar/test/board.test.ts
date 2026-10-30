import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AgentPermissionRequest,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentStreamEvent,
  Board,
} from "@agentdeck/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";

import { AgentManager } from "../src/agent/agent-manager.js";
import { AgentStore } from "../src/agent/agent-store.js";
import type { AgentClient, AgentSession, AgentSessionConfig } from "../src/agent/types.js";
import { BoardService, lastTurnFromTimeline, parseTaskMarker, taskPrompt } from "../src/kanban/board-service.js";
import { BoardStore, boardKey, normalizeProjectPath } from "../src/kanban/store.js";
import { locateGit, runGit } from "../src/snapshots/git.js";

const gitPath = await locateGit();

const tempDirs: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agentdeck-board-"));
  tempDirs.push(dir);
  return dir;
}

function promptText(prompt: AgentPromptInput): string {
  return typeof prompt === "string"
    ? prompt
    : prompt.map((part) => (part.type === "text" ? part.text : "")).join("");
}

class FakeSession implements AgentSession {
  readonly provider = "fake";
  private listeners = new Set<(event: AgentStreamEvent) => void>();
  private turnCounter = 0;
  prompts: string[] = [];
  currentTurnId: string | null = null;
  interrupted = 0;

  constructor(
    readonly cfg: AgentSessionConfig,
    public id: string,
  ) {}

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    this.turnCounter += 1;
    const turnId = `${this.id}-turn-${this.turnCounter}`;
    this.currentTurnId = turnId;
    this.prompts.push(promptText(prompt));
    this.emit({ type: "thread_started", sessionId: this.id });
    this.emit({ type: "turn_started", turnId });
    return { turnId };
  }

  finish(text: string, kind: "completed" | "failed" | "canceled" = "completed"): void {
    const turnId = this.currentTurnId!;
    this.currentTurnId = null;
    if (text) {
      this.emit({ type: "timeline", turnId, item: { type: "assistant_message", text, messageId: `m-${turnId}` } });
    }
    if (kind === "completed") {
      this.emit({ type: "turn_completed", turnId });
    } else if (kind === "failed") {
      this.emit({ type: "turn_failed", turnId, error: "boom" });
    } else {
      this.emit({ type: "turn_canceled", turnId, reason: "x" });
    }
  }

  subscribe(cb: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(event: AgentStreamEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  getPendingPermissions(): AgentPermissionRequest[] {
    return [];
  }
  async respondToPermission(): Promise<void> {}
  async interrupt(): Promise<void> {
    this.interrupted += 1;
    if (this.currentTurnId) {
      this.finish("", "canceled");
    }
  }
  async close(): Promise<void> {}
  describePersistence(): AgentPersistenceHandle | null {
    return { provider: "fake", sessionId: this.id };
  }
}

interface Harness {
  manager: AgentManager;
  service: BoardService;
  sessions: FakeSession[];
  changed: Array<{ projectPath: string; board: Board }>;
  dataDir: string;
}

const cleanups: Array<() => Promise<void>> = [];

function makeClient(sessions: FakeSession[]): AgentClient {
  const create = (cfg: AgentSessionConfig, id?: string) => {
    const session = new FakeSession(cfg, id ?? `native-${sessions.length}`);
    sessions.push(session);
    return session;
  };
  return {
    provider: "fake",
    kind: "mock",
    label: "Fake",
    isAvailable: async () => ({ available: true }),
    fetchCatalog: async () => ({ models: [], modes: [{ id: "default", label: "默认" }] }),
    createSession: async (cfg) => create(cfg),
    resumeSession: async (handle: AgentPersistenceHandle, cfg: { cwd: string }) => create(cfg, handle.sessionId),
  };
}

async function setup(opts: { dataDir?: string; persist?: boolean; start?: boolean } = {}): Promise<Harness> {
  const dataDir = opts.dataDir ?? makeDir();
  const sessions: FakeSession[] = [];
  const client = makeClient(sessions);
  const store = opts.persist ? new AgentStore({ dataDir }) : undefined;
  const manager = new AgentManager({
    registry: { get: (id) => (id === "fake" ? client : undefined) },
    ...(store ? { store } : {}),
  });
  if (store) {
    await manager.restore();
  }
  const service = new BoardService({
    manager,
    store: new BoardStore({ dataDir }),
  });
  const changed: Harness["changed"] = [];
  service.subscribe({ onChanged: (projectPath, board) => changed.push({ projectPath, board }) });
  if (opts.start !== false) {
    await service.start();
  }
  cleanups.push(async () => {
    await service.stop();
    await manager.shutdown().catch(() => undefined);
  });
  return { manager, service, sessions, changed, dataDir };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runGit(gitPath!, args, { cwd });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return result.stdout.toString("utf8");
}

async function makeRepo(): Promise<string> {
  const repo = path.join(makeDir(), "repo");
  mkdirSync(repo, { recursive: true });
  await git(repo, "init");
  await git(repo, "config", "user.email", "t@example.com");
  await git(repo, "config", "user.name", "t");
  writeFileSync(path.join(repo, "a.txt"), "hello\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "init");
  return repo;
}

function plainDir(): string {
  const dir = path.join(makeDir(), "plain");
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function addTask(h: Harness, project: string, title: string, extra: Record<string, unknown> = {}) {
  const { task } = await h.service.upsertTask(project, { title, ...extra });
  return task;
}

function taskOf(board: Board, id: string) {
  return board.tasks.find((task) => task.id === id)!;
}

async function boardOf(h: Harness, project: string): Promise<Board> {
  return h.service.get(project);
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("路径规范化与存储", () => {
  test("Windows 路径大小写不敏感、分隔符统一、去尾部分隔符；POSIX 路径保留大小写", () => {
    expect(normalizeProjectPath("C:\\Work\\Proj\\")).toBe("c:/work/proj");
    expect(normalizeProjectPath("c:/work/proj")).toBe("c:/work/proj");
    expect(boardKey("C:\\Work\\Proj")).toBe(boardKey("c:/work/proj/"));
    expect(normalizeProjectPath("/Home/Me/Proj/")).toBe("/Home/Me/Proj");
    expect(boardKey("/a/b")).not.toBe(boardKey("/a/B"));
    expect(boardKey("/a/b")).toMatch(/^[0-9a-f]{16}$/);
  });

  test("看板写入 boards/<key>.json，重启后读回；坏文件备份为 .bad 后视为空", async () => {
    const project = plainDir();
    const h = await setup();
    const task = await addTask(h, project, "任务一");
    await h.service.stop();
    const file = path.join(h.dataDir, "boards", `${boardKey(project)}.json`);
    expect(existsSync(file)).toBe(true);

    const h2 = await setup({ dataDir: h.dataDir });
    expect(taskOf(await boardOf(h2, project), task.id).title).toBe("任务一");

    await h2.service.stop();
    writeFileSync(file, "{ not json");
    const h3 = await setup({ dataDir: h.dataDir });
    expect((await boardOf(h3, project)).tasks).toEqual([]);
    expect(existsSync(`${file}.bad`)).toBe(true);
  });
});

describe("board.get 默认值与校验", () => {
  test.skipIf(!gitPath)("不存在的看板返回空看板；worktreePerTask 取决于是否在 git 仓库内", async () => {
    const h = await setup();
    const repo = await makeRepo();
    const inGit = await h.service.get(repo);
    expect(inGit).toMatchObject({ tasks: [], settings: { worktreePerTask: true, autoDispatch: false, maxConcurrent: 2 } });
    const plain = await h.service.get(plainDir());
    expect(plain.settings.worktreePerTask).toBe(false);
  });

  test("upsertTask 校验：标题 / 描述长度、依赖必须存在、不能依赖自己、不能成环", async () => {
    const h = await setup();
    const project = plainDir();
    await expect(h.service.upsertTask(project, { title: "  " })).rejects.toThrow(/标题/);
    await expect(h.service.upsertTask(project, { title: "x".repeat(201) })).rejects.toThrow(/标题/);
    await expect(h.service.upsertTask(project, { title: "t", description: "x".repeat(20_001) })).rejects.toThrow(/描述/);
    await expect(h.service.upsertTask(project, { title: "t", dependsOn: ["nope"] })).rejects.toThrow(/不存在/);
    const a = await addTask(h, project, "A");
    const b = await addTask(h, project, "B", { dependsOn: [a.id] });
    const c = await addTask(h, project, "C", { dependsOn: [b.id] });
    await expect(h.service.upsertTask(project, { id: a.id, title: "A", dependsOn: [a.id] })).rejects.toThrow(/自己/);
    await expect(h.service.upsertTask(project, { id: a.id, title: "A", dependsOn: [c.id] })).rejects.toThrow(/成环/);
    await expect(h.service.upsertTask(project, { id: "ghost", title: "x" })).rejects.toThrow(/不存在/);
    // 编辑：保留状态，清除指派
    const edited = await h.service.upsertTask(project, {
      id: b.id,
      title: "B2",
      assignee: { provider: "fake" },
    });
    expect(edited.task).toMatchObject({ title: "B2", status: "todo", assignee: { provider: "fake" } });
    const cleared = await h.service.upsertTask(project, { id: b.id, title: "B2", assignee: null });
    expect(cleared.task.assignee).toBeUndefined();
  });

  test("提示与标记解析", () => {
    expect(taskPrompt({ title: "修 bug", description: "细节" })).toContain("TASK_DONE");
    expect(taskPrompt({ title: "修 bug", description: "" })).not.toContain("\n\n\n");
    expect(parseTaskMarker("好了\nTASK_DONE\n\n")).toEqual({ status: "review" });
    expect(parseTaskMarker("TASK_BLOCKED: 缺权限")).toEqual({ status: "blocked", reason: "缺权限" });
    expect(parseTaskMarker("TASK_BLOCKED:")).toEqual({ status: "blocked", reason: "未说明原因" });
    expect(parseTaskMarker("TASK_BLOCKED: x\n后面还有")).toEqual({ status: "review" });
    expect(parseTaskMarker("没有标记")).toEqual({ status: "review" });
  });

  test("时间线补判：取最后一个已结束回合；末尾未结束 / 无回合分别返回 unfinished / null", () => {
    const env = (event: AgentStreamEvent, seq: number) => ({ agentId: "a", seq, epoch: "e", timestamp: 0, event });
    const msg = (text: string): AgentStreamEvent => ({
      type: "timeline",
      turnId: "t",
      item: { type: "assistant_message", text, messageId: text },
    });
    expect(lastTurnFromTimeline([])).toBeNull();
    expect(
      lastTurnFromTimeline([
        env({ type: "turn_started", turnId: "1" }, 1),
        env(msg("旧"), 2),
        env({ type: "turn_completed", turnId: "1" }, 3),
        env({ type: "turn_started", turnId: "2" }, 4),
        env(msg("新\nTASK_DONE"), 5),
        env({ type: "turn_completed", turnId: "2" }, 6),
      ]),
    ).toEqual({ kind: "completed", text: "新\nTASK_DONE" });
    expect(
      lastTurnFromTimeline([env({ type: "turn_started", turnId: "1" }, 1), env({ type: "turn_failed", turnId: "1", error: "x" }, 2)]),
    ).toEqual({ kind: "failed", text: "", error: "x" });
    expect(
      lastTurnFromTimeline([
        env({ type: "turn_started", turnId: "1" }, 1),
        env({ type: "turn_completed", turnId: "1" }, 2),
        env({ type: "turn_started", turnId: "2" }, 3),
      ]),
    ).toBe("unfinished");
  });
});

describe.skipIf(!gitPath)("手动派发与 worktree", () => {
  test("拖到 running：建 worktree（task-<id> / agentdeck/task-<id>）、新会话 origin=kanban、内部发送任务提示", async () => {
    const repo = await makeRepo();
    const h = await setup();
    await h.service.updateSettings(repo, { defaultAssignee: { provider: "fake" } });
    const task = await addTask(h, repo, "实现登录", { description: "用 OAuth" });
    const board = await h.service.moveTask(repo, task.id, "running");
    const moved = taskOf(board, task.id);
    expect(moved.status).toBe("running");
    expect(moved.worktree).toEqual({
      path: path.join(realpathSync.native(repo), "tmp", "worktrees", `task-${task.id}`),
      branch: `agentdeck/task-${task.id}`,
    });
    expect(await git(repo, "status", "--porcelain")).toBe("");
    expect(existsSync(moved.worktree!.path)).toBe(true);
    expect(await git(repo, "branch", "--list", `agentdeck/task-${task.id}`)).toContain("agentdeck/task-");

    const agent = h.manager.getAgent(moved.agentId!);
    expect(agent).toMatchObject({ origin: "kanban", title: "实现登录", cwd: moved.worktree!.path });
    expect(h.sessions[0]!.prompts[0]).toContain("实现登录");
    expect(h.sessions[0]!.prompts[0]).toContain("用 OAuth");
    expect(h.sessions[0]!.prompts[0]).toContain("TASK_DONE");
    expect(h.sessions[0]!.prompts[0]).toContain("TASK_BLOCKED");
    expect(h.changed.length).toBeGreaterThan(0);
  });

  test("worktreePerTask 关闭时直接用 projectPath；非 git 仓库忽略 worktree 设置", async () => {
    const repo = await makeRepo();
    const h = await setup();
    await h.service.updateSettings(repo, { worktreePerTask: false, defaultAssignee: { provider: "fake" } });
    const a = await addTask(h, repo, "A");
    const afterA = taskOf(await h.service.moveTask(repo, a.id, "running"), a.id);
    expect(afterA.worktree).toBeUndefined();
    expect(h.manager.getAgent(afterA.agentId!).cwd).toBe(repo);

    const plain = plainDir();
    await h.service.updateSettings(plain, { worktreePerTask: true, defaultAssignee: { provider: "fake" } });
    const b = await addTask(h, plain, "B");
    const afterB = taskOf(await h.service.moveTask(plain, b.id, "running"), b.id);
    expect(afterB.status).toBe("running");
    expect(afterB.worktree).toBeUndefined();
    expect(h.manager.getAgent(afterB.agentId!).cwd).toBe(plain);
  });

  test("派发失败（provider 不存在）：任务转 blocked 并记录原因，回滚 worktree", async () => {
    const repo = await makeRepo();
    const h = await setup();
    await h.service.updateSettings(repo, { defaultAssignee: { provider: "nope" } });
    const task = await addTask(h, repo, "X");
    const moved = taskOf(await h.service.moveTask(repo, task.id, "running"), task.id);
    expect(moved.status).toBe("blocked");
    expect(moved.blockedReason).toContain("派发失败");
    expect(existsSync(path.join(repo, "tmp", "worktrees", `task-${task.id}`))).toBe(false);
  });
});

describe("autoDispatch", () => {
  test("按 order、依赖全 done、受 maxConcurrent 限制", async () => {
    const project = plainDir();
    const h = await setup();
    await h.service.updateSettings(project, { defaultAssignee: { provider: "fake" }, maxConcurrent: 1 });
    const a = await addTask(h, project, "A");
    const b = await addTask(h, project, "B", { dependsOn: [a.id] });
    const c = await addTask(h, project, "C");
    let board = await h.service.updateSettings(project, { autoDispatch: true });
    // A 先派发（order 最小）；B 依赖 A、C 受并发上限，均等待
    expect(taskOf(board, a.id).status).toBe("running");
    expect(taskOf(board, b.id).status).toBe("todo");
    expect(taskOf(board, c.id).status).toBe("todo");

    h.sessions[0]!.finish("完成\nTASK_DONE");
    await vi.waitFor(async () => expect(taskOf(await boardOf(h, project), a.id).status).toBe("review"));
    // A 在 review（依赖尚未 done），释放并发 → C 派发，B 仍等待
    await vi.waitFor(async () => expect(taskOf(await boardOf(h, project), c.id).status).toBe("running"));
    board = await boardOf(h, project);
    expect(taskOf(board, b.id).status).toBe("todo");

    // A 手动标 done：B 依赖满足，但 C 仍占着并发
    board = await h.service.moveTask(project, a.id, "done");
    expect(taskOf(board, b.id).status).toBe("todo");
    const cSession = h.sessions[h.sessions.length - 1]!;
    cSession.finish("好了\nTASK_DONE");
    await vi.waitFor(async () => expect(taskOf(await boardOf(h, project), b.id).status).toBe("running"));
  });

  test("autoDispatch 关闭时 todo 不会被派发；maxConcurrent 调大后补派发", async () => {
    const project = plainDir();
    const h = await setup();
    await h.service.updateSettings(project, { defaultAssignee: { provider: "fake" }, maxConcurrent: 1, autoDispatch: true });
    const a = await addTask(h, project, "A");
    const b = await addTask(h, project, "B");
    let board = await boardOf(h, project);
    expect([taskOf(board, a.id).status, taskOf(board, b.id).status]).toEqual(["running", "todo"]);
    board = await h.service.updateSettings(project, { maxConcurrent: 2 });
    expect(taskOf(board, b.id).status).toBe("running");
  });
});

describe("回合结束判定与失败重试", () => {
  async function runOne(opts: { maxAttempts?: number } = {}) {
    const project = plainDir();
    const h = await setup();
    await h.service.updateSettings(project, { defaultAssignee: { provider: "fake" } });
    const task = await addTask(h, project, "T", opts);
    await h.service.moveTask(project, task.id, "running");
    return { h, project, task, session: h.sessions[0]! };
  }

  test("末行 TASK_DONE → review", async () => {
    const { h, project, task, session } = await runOne();
    session.finish("做完了\nTASK_DONE");
    await vi.waitFor(async () => expect(taskOf(await boardOf(h, project), task.id).status).toBe("review"));
  });

  test("TASK_BLOCKED: 原因 → blocked 并记录原因", async () => {
    const { h, project, task, session } = await runOne();
    session.finish("卡住了\nTASK_BLOCKED: 缺少数据库密码");
    await vi.waitFor(async () =>
      expect(taskOf(await boardOf(h, project), task.id)).toMatchObject({
        status: "blocked",
        blockedReason: "缺少数据库密码",
      }),
    );
  });

  test("没有标记 → review", async () => {
    const { h, project, task, session } = await runOne();
    session.finish("我做了一些事情");
    await vi.waitFor(async () => expect(taskOf(await boardOf(h, project), task.id).status).toBe("review"));
  });

  test("turn_failed：未到 maxAttempts 在同一会话重试，到达后 blocked", async () => {
    const { h, project, task, session } = await runOne({ maxAttempts: 2 });
    session.finish("", "failed");
    await vi.waitFor(() => expect(session.prompts).toHaveLength(2));
    expect(session.prompts[1]).toBe("上次执行失败：boom，请重试");
    expect(h.sessions).toHaveLength(1);
    expect(taskOf(await boardOf(h, project), task.id)).toMatchObject({ status: "running", attempts: 1 });
    session.finish("", "failed");
    await vi.waitFor(async () => expect(taskOf(await boardOf(h, project), task.id).status).toBe("blocked"));
    const finalTask = taskOf(await boardOf(h, project), task.id);
    expect(finalTask.attempts).toBe(2);
    expect(finalTask.blockedReason).toContain("boom");
  });

  test("失败后重试成功 → 仍按末行标记判定", async () => {
    const { h, project, task, session } = await runOne();
    session.finish("", "failed");
    await vi.waitFor(() => expect(session.prompts).toHaveLength(2));
    session.finish("好了\nTASK_DONE");
    await vi.waitFor(async () => expect(taskOf(await boardOf(h, project), task.id).status).toBe("review"));
  });

  test("用户在任务会话里手动发送消息不改变状态，回合结束仍按规则判定", async () => {
    const { h, project, task, session } = await runOne();
    session.finish("先做一半");
    await vi.waitFor(async () => expect(taskOf(await boardOf(h, project), task.id).status).toBe("review"));
    await h.manager.sendPrompt(taskOf(await boardOf(h, project), task.id).agentId!, "补充一下");
    expect(taskOf(await boardOf(h, project), task.id).status).toBe("review");
    session.finish("补充完\nTASK_BLOCKED: 不对");
    await new Promise((resolve) => setTimeout(resolve, 100));
    // 任务已不在 running，回合结束不再改变状态
    expect(taskOf(await boardOf(h, project), task.id).status).toBe("review");
  });
});

describe("移动 / 中断 / 删除 / 会话删除", () => {
  test("运行中任务移出 running：先中断会话，之后回合结束事件不再改状态", async () => {
    const project = plainDir();
    const h = await setup();
    await h.service.updateSettings(project, { defaultAssignee: { provider: "fake" } });
    const task = await addTask(h, project, "T");
    await h.service.moveTask(project, task.id, "running");
    const board = await h.service.moveTask(project, task.id, "todo");
    expect(h.sessions[0]!.interrupted).toBe(1);
    expect(taskOf(board, task.id).status).toBe("todo");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(taskOf(await boardOf(h, project), task.id).status).toBe("todo");
  });

  test("moveTask 的 order 生效；再次拖回 running 复用原会话", async () => {
    const project = plainDir();
    const h = await setup();
    await h.service.updateSettings(project, { defaultAssignee: { provider: "fake" } });
    const a = await addTask(h, project, "A");
    const b = await addTask(h, project, "B");
    let board = await h.service.moveTask(project, b.id, "todo", 0.5);
    expect(board.tasks.sort((x, y) => x.order - y.order).map((t) => t.title)).toEqual(["B", "A"]);
    await h.service.moveTask(project, a.id, "running");
    h.sessions[0]!.finish("好\nTASK_DONE");
    await vi.waitFor(async () => expect(taskOf(await boardOf(h, project), a.id).status).toBe("review"));
    board = await h.service.moveTask(project, a.id, "running");
    expect(taskOf(board, a.id).status).toBe("running");
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]!.prompts).toHaveLength(2);
  });

  test("会话被删除：对应任务解除 agentId，running → todo", async () => {
    const project = plainDir();
    const h = await setup();
    await h.service.updateSettings(project, { defaultAssignee: { provider: "fake" } });
    const task = await addTask(h, project, "T");
    const running = taskOf(await h.service.moveTask(project, task.id, "running"), task.id);
    await h.manager.deleteAgent(running.agentId!);
    await vi.waitFor(async () => expect(taskOf(await boardOf(h, project), task.id)).toMatchObject({ status: "todo" }));
    expect(taskOf(await boardOf(h, project), task.id).agentId).toBeUndefined();
  });

  test.skipIf(!gitPath)("删除任务：可选清理 worktree 与分支，并从其它任务的依赖中移除", async () => {
    const repo = await makeRepo();
    const h = await setup();
    await h.service.updateSettings(repo, { defaultAssignee: { provider: "fake" } });
    const a = await addTask(h, repo, "A");
    const b = await addTask(h, repo, "B", { dependsOn: [a.id] });
    const running = taskOf(await h.service.moveTask(repo, a.id, "running"), a.id);
    const wt = running.worktree!;
    const result = await h.service.deleteTask(repo, a.id, true);
    expect(h.sessions[0]!.interrupted).toBe(1);
    expect(result.board.tasks.map((t) => t.id)).toEqual([b.id]);
    expect(taskOf(result.board, b.id).dependsOn).toBeUndefined();
    expect(existsSync(wt.path)).toBe(false);
    expect(await git(repo, "branch", "--list", wt.branch)).toBe("");
    await expect(h.service.deleteTask(repo, "ghost")).rejects.toThrow(/不存在/);
  });
});

describe.skipIf(!gitPath)("board.merge", () => {
  async function reviewTask(h: Harness, repo: string, change: (wt: string) => void) {
    await h.service.updateSettings(repo, { defaultAssignee: { provider: "fake" } });
    const task = await addTask(h, repo, "改文件");
    const running = taskOf(await h.service.moveTask(repo, task.id, "running"), task.id);
    change(running.worktree!.path);
    h.sessions[h.sessions.length - 1]!.finish("好\nTASK_DONE");
    await vi.waitFor(async () => expect(taskOf(await boardOf(h, repo), task.id).status).toBe("review"));
    return { task, wt: running.worktree! };
  }

  test("成功：自动提交 worktree 改动并 --no-ff 合并，任务 done；removeWorktree 时清理目录与分支", async () => {
    const repo = await makeRepo();
    const h = await setup();
    const { task, wt } = await reviewTask(h, repo, (dir) => writeFileSync(path.join(dir, "new.txt"), "from agent\n"));
    const result = await h.service.merge(repo, task.id, true);
    expect(result.ok).toBe(true);
    expect(taskOf(result.board, task.id)).toMatchObject({ status: "done" });
    expect(taskOf(result.board, task.id).worktree).toBeUndefined();
    expect(readFileSync(path.join(repo, "new.txt"), "utf8")).toBe("from agent\n");
    expect(await git(repo, "log", "-1", "--format=%P")).toMatch(/\S+ \S+/); // 合并提交有两个父提交
    expect(existsSync(wt.path)).toBe(false);
    expect(await git(repo, "branch", "--list", wt.branch)).toBe("");
  });

  test("成功但不删 worktree：保留目录与分支", async () => {
    const repo = await makeRepo();
    const h = await setup();
    const { task, wt } = await reviewTask(h, repo, (dir) => writeFileSync(path.join(dir, "keep.txt"), "x\n"));
    const result = await h.service.merge(repo, task.id, false);
    expect(result.ok).toBe(true);
    expect(existsSync(wt.path)).toBe(true);
    expect(taskOf(result.board, task.id).worktree).toEqual(wt);
  });

  test("冲突：merge --abort，返回冲突文件，任务留在 review", async () => {
    const repo = await makeRepo();
    const h = await setup();
    const { task } = await reviewTask(h, repo, (dir) => writeFileSync(path.join(dir, "a.txt"), "from task\n"));
    writeFileSync(path.join(repo, "a.txt"), "from main\n");
    await git(repo, "commit", "-am", "main change");
    const result = await h.service.merge(repo, task.id, true);
    expect(result).toMatchObject({ ok: false, conflicts: ["a.txt"] });
    expect(taskOf(result.board, task.id).status).toBe("review");
    expect(await git(repo, "status", "--porcelain")).toBe("");
    expect(readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("from main\n");
  });

  test("项目工作区有未提交改动：拒绝合并（中文错误），任务不变", async () => {
    const repo = await makeRepo();
    const h = await setup();
    const { task } = await reviewTask(h, repo, (dir) => writeFileSync(path.join(dir, "n.txt"), "n\n"));
    writeFileSync(path.join(repo, "a.txt"), "dirty\n");
    await expect(h.service.merge(repo, task.id, false)).rejects.toThrow("项目工作区有未提交改动");
    expect(taskOf(await boardOf(h, repo), task.id).status).toBe("review");
  });

  test("非 review 任务 / 无 worktree 的任务不能合并", async () => {
    const repo = await makeRepo();
    const h = await setup();
    const todo = await addTask(h, repo, "T");
    await expect(h.service.merge(repo, todo.id, false)).rejects.toThrow("待评审");
    await h.service.updateSettings(repo, { worktreePerTask: false, defaultAssignee: { provider: "fake" } });
    await h.service.moveTask(repo, todo.id, "running");
    await h.service.moveTask(repo, todo.id, "review");
    await expect(h.service.merge(repo, todo.id, false)).rejects.toThrow("没有独立分支");
  });
});

describe("sidecar 重启补判", () => {
  test("running 任务的会话已无进行中回合：按最后一个已结束回合补判；会话不存在则回 todo", async () => {
    const project = plainDir();
    const h = await setup({ persist: true });
    await h.service.updateSettings(project, { defaultAssignee: { provider: "fake" } });
    const done = await addTask(h, project, "完成的");
    const blocked = await addTask(h, project, "受阻的");
    const lost = await addTask(h, project, "丢会话的");
    const interrupted = await addTask(h, project, "半途的");
    for (const task of [done, blocked, lost, interrupted]) {
      await h.service.moveTask(project, task.id, "running");
    }
    // 重启前：服务停止（不再处理事件），前两个会话在“宕机期间”结束回合
    await h.service.stop();
    h.sessions[0]!.finish("好\nTASK_DONE");
    h.sessions[1]!.finish("不行\nTASK_BLOCKED: 缺依赖");
    await h.manager.flush();
    const lostAgentId = taskOf(await h.service.get(project), lost.id).agentId!;
    await h.manager.shutdown();

    const h2 = await setup({ dataDir: h.dataDir, persist: true, start: false });
    // 丢会话：新 manager 中删除该会话
    await h2.manager.deleteAgent(lostAgentId);
    await h2.service.start();
    const board = await h2.service.get(project);
    expect(taskOf(board, done.id).status).toBe("review");
    expect(taskOf(board, blocked.id)).toMatchObject({ status: "blocked", blockedReason: "缺依赖" });
    expect(taskOf(board, lost.id)).toMatchObject({ status: "todo" });
    expect(taskOf(board, lost.id).agentId).toBeUndefined();
    expect(taskOf(board, interrupted.id).status).toBe("blocked");
    expect(taskOf(board, interrupted.id).blockedReason).toContain("重启");
  });

  test("启动时检查自动派发", async () => {
    const project = plainDir();
    const h = await setup();
    await h.service.updateSettings(project, { defaultAssignee: { provider: "fake" }, autoDispatch: false });
    const task = await addTask(h, project, "A");
    await h.service.stop();
    writeFileSync(
      path.join(h.dataDir, "boards", `${boardKey(project)}.json`),
      JSON.stringify({ ...(await h.service.get(project)), settings: { ...(await h.service.get(project)).settings, autoDispatch: true } }),
    );
    const h2 = await setup({ dataDir: h.dataDir });
    await vi.waitFor(async () => expect(taskOf(await boardOf(h2, project), task.id).status).toBe("running"));
    expect(readdirSync(path.join(h.dataDir, "boards")).some((name) => name.endsWith(".bad"))).toBe(false);
  });
});
