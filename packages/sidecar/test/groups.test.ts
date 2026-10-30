import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AgentGroup,
  AgentPermissionRequest,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentStreamEvent,
} from "@agentdeck/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";

import { AgentManager } from "../src/agent/agent-manager.js";
import { AgentStore } from "../src/agent/agent-store.js";
import type { AgentClient, AgentSession, AgentSessionConfig } from "../src/agent/types.js";
import {
  buildChairPrompt,
  GROUP_REPLY_MAX_CHARS,
  GroupService,
} from "../src/groups/group-service.js";
import { groupCreateSchema, type ParsedGroupCreate } from "../src/groups/schema.js";
import { GroupStore } from "../src/groups/store.js";
import { locateGit, runGit } from "../src/snapshots/git.js";

const gitPath = await locateGit();

const tempDirs: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agentdeck-group-"));
  tempDirs.push(dir);
  return dir;
}

function promptText(prompt: AgentPromptInput): string {
  return typeof prompt === "string"
    ? prompt
    : prompt.map((part) => (part.type === "text" ? part.text : "")).join("");
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runGit(gitPath!, args, { cwd });
  if (result.code !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout.toString("utf8");
}

async function makeRepo(): Promise<string> {
  const repo = path.join(makeDir(), "repo");
  await runGit(gitPath!, ["init", repo]);
  await git(repo, "config", "user.email", "t@example.com");
  await git(repo, "config", "user.name", "t");
  writeFileSync(path.join(repo, "a.txt"), "hello\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "init");
  return repo;
}

/** 由测试驱动的假会话：startTurn 后回合保持运行，直到 finish() */
class FakeSession implements AgentSession {
  readonly provider = "fake";
  private listeners = new Set<(event: AgentStreamEvent) => void>();
  private turnCounter = 0;
  prompts: string[] = [];
  currentTurnId: string | null = null;

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
      this.emit({
        type: "timeline",
        turnId,
        item: { type: "assistant_message", text, messageId: `m-${turnId}` },
      });
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
  service: GroupService;
  sessions: FakeSession[];
  changed: AgentGroup[];
  removed: string[];
  dataDir: string;
  /** 第 N 次（从 1 起）createSession 抛错 */
  failCreateAt: number | null;
  sessionOf(agentId: string): FakeSession;
}

const managers: AgentManager[] = [];
const services: GroupService[] = [];

/** 复用同一个 dataDir 可模拟 sidecar 重启 */
async function setup(dataDir: string = makeDir()): Promise<Harness> {
  const sessions: FakeSession[] = [];
  const harness = { failCreateAt: null } as unknown as Harness;
  let counter = 0;
  const create = (cfg: AgentSessionConfig, id?: string) => {
    counter += 1;
    if (harness.failCreateAt === counter) {
      throw new Error("创建会话失败（测试）");
    }
    const session = new FakeSession(cfg, id ?? `native-${dataDir.length}-${counter}-${sessions.length}`);
    sessions.push(session);
    return session;
  };
  const makeClient = (available: boolean): AgentClient => ({
    provider: "fake",
    kind: "mock",
    label: "Fake",
    isAvailable: async () => (available ? { available: true } : { available: false, reason: "未安装" }),
    fetchCatalog: async () => ({ models: [], modes: [{ id: "default", label: "默认" }] }),
    createSession: async (cfg) => create(cfg),
    resumeSession: async (handle: AgentPersistenceHandle, cfg: AgentSessionConfig) =>
      create(cfg, handle.sessionId),
  });
  const clients: Record<string, AgentClient> = { fake: makeClient(true), off: makeClient(false) };
  const registry = { get: (id: string) => clients[id] };
  const manager = new AgentManager({ registry, store: new AgentStore({ dataDir }) });
  managers.push(manager);
  await manager.restore();
  const service = new GroupService({ manager, registry, store: new GroupStore({ dataDir }) });
  services.push(service);
  const changed: AgentGroup[] = [];
  const removed: string[] = [];
  service.subscribe({ onChanged: (group) => changed.push(group), onRemoved: (id) => removed.push(id) });
  await service.start();
  Object.assign(harness, {
    manager,
    service,
    sessions,
    changed,
    removed,
    dataDir,
    sessionOf: (agentId: string) => {
      const sessionId = manager.getAgent(agentId).persistence?.sessionId;
      const session = sessions.find((item) => item.id === sessionId);
      if (!session) throw new Error(`找不到会话 ${agentId}`);
      return session;
    },
  });
  return harness;
}

function input(overrides: Partial<ParsedGroupCreate> & { cwd: string }): ParsedGroupCreate {
  return groupCreateSchema.parse({
    prompt: "实现排序",
    members: [{ provider: "fake" }, { provider: "fake" }],
    worktree: "none",
    ...overrides,
  });
}

const settle = (check: () => void) => vi.waitFor(check, { timeout: 5_000, interval: 10 });

afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.stop();
  }
  await Promise.allSettled(managers.splice(0).map((manager) => manager.shutdown()));
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("group.create 入参校验", () => {
  test("成员数需为 2–6，worktree 取值受限，chair.mode 受限", () => {
    const base = { prompt: "p", cwd: "/x", worktree: "none" };
    const one = { ...base, members: [{ provider: "a" }] };
    const seven = { ...base, members: Array.from({ length: 7 }, () => ({ provider: "a" })) };
    const six = { ...base, members: Array.from({ length: 6 }, () => ({ provider: "a" })) };
    expect(groupCreateSchema.safeParse(one).success).toBe(false);
    expect(groupCreateSchema.safeParse(seven).success).toBe(false);
    expect(groupCreateSchema.safeParse(six).success).toBe(true);
    expect(groupCreateSchema.safeParse({ ...six, worktree: "x" }).success).toBe(false);
    expect(groupCreateSchema.safeParse({ ...six, chair: { provider: "a", mode: "vote" } }).success).toBe(false);
    expect(groupCreateSchema.safeParse({ ...six, prompt: "  " }).success).toBe(false);
  });

  test("provider 不存在 / 不可用走业务错误，且不建会话", async () => {
    const h = await setup();
    await expect(
      h.service.create(input({ cwd: h.dataDir, members: [{ provider: "fake" }, { provider: "nope" }] })),
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" });
    await expect(
      h.service.create(input({ cwd: h.dataDir, members: [{ provider: "fake" }, { provider: "off" }] })),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(h.manager.listAgents()).toHaveLength(0);
  });

  test("per-member 但 cwd 不在 git 仓库内 → 参数错误（中文说明）", async () => {
    const h = await setup();
    const plain = makeDir();
    const promise = h.service.create(input({ cwd: plain, worktree: "per-member" }));
    await expect(promise).rejects.toThrow(/git 仓库/);
    await expect(promise).rejects.toMatchObject({ name: "AgentInvalidParamsError" });
    expect(h.manager.listAgents()).toHaveLength(0);
  });
});

describe("并行扇出与汇总", () => {
  test("成员会话带 groupId / origin，并同时收到同一 prompt；无 chair 时全部结束即 done", async () => {
    const h = await setup();
    const group = await h.service.create(input({ cwd: h.dataDir, title: "排序对比" }));
    expect(group.status).toBe("running");
    expect(group.members).toHaveLength(2);
    for (const member of group.members) {
      const snapshot = h.manager.getAgent(member.agentId);
      expect(snapshot).toMatchObject({ groupId: group.id, origin: "group", cwd: h.dataDir });
      expect(h.sessionOf(member.agentId).prompts).toEqual(["实现排序"]);
    }
    h.sessionOf(group.members[0]!.agentId).finish("A 答案");
    await settle(() => expect(h.service.get(group.id).status).toBe("running"));
    h.sessionOf(group.members[1]!.agentId).finish("", "failed");
    await settle(() => expect(h.service.get(group.id).status).toBe("done"));
    expect(h.manager.listAgents()).toHaveLength(2);
    expect(h.changed.at(-1)!.status).toBe("done");
    // 广播先于落盘；stop() 会等待挂起的写入完成
    await h.service.stop();
    const stored = JSON.parse(readFileSync(path.join(h.dataDir, "groups", `${group.id}.json`), "utf8")) as AgentGroup;
    expect(stored.status).toBe("done");
  });

  test("chair 在全部成员首个回合结束后才创建（含一个成员失败）；状态 running → chairing → done", async () => {
    const h = await setup();
    const group = await h.service.create(
      input({ cwd: h.dataDir, members: [{ provider: "fake" }, { provider: "fake" }, { provider: "fake" }], chair: { provider: "fake", mode: "synthesize" } }),
    );
    const [m1, m2, m3] = group.members.map((member) => h.sessionOf(member.agentId));
    m1!.finish("答案一");
    m2!.finish("", "failed");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.manager.listAgents()).toHaveLength(3);
    expect(h.service.get(group.id).status).toBe("running");

    m3!.finish("答案三");
    await settle(() => expect(h.service.get(group.id).status).toBe("chairing"));
    await settle(() => expect(h.manager.listAgents()).toHaveLength(4));
    const chairId = h.service.get(group.id).chair!.agentId!;
    expect(h.manager.getAgent(chairId)).toMatchObject({ groupId: group.id, origin: "group", cwd: h.dataDir });
    await settle(() => expect(h.sessionOf(chairId).prompts).toHaveLength(1));
    const prompt = h.sessionOf(chairId).prompts[0]!;
    expect(prompt).toContain("以下是 3 个 Agent 对同一任务的回答，请综合出一个最佳答案，并指出各自的优缺点");
    expect(prompt).toContain("答案一");
    expect(prompt).toContain("答案三");
    expect(prompt).toContain("该成员回合失败：boom");

    h.sessionOf(chairId).finish("综合结论");
    await settle(() => expect(h.service.get(group.id).status).toBe("done"));
    expect(h.changed.map((item) => item.status)).toEqual(
      expect.arrayContaining(["running", "chairing", "done"]),
    );
  });

  test("chair 回合失败 → 协作组 failed；review 模式用评审模板", async () => {
    const h = await setup();
    const group = await h.service.create(input({ cwd: h.dataDir, chair: { provider: "fake", mode: "review" } }));
    for (const member of group.members) h.sessionOf(member.agentId).finish("方案");
    await settle(() => expect(h.service.get(group.id).chair?.agentId).toBeTruthy());
    const chairId = h.service.get(group.id).chair!.agentId!;
    await settle(() => expect(h.sessionOf(chairId).prompts).toHaveLength(1));
    expect(h.sessionOf(chairId).prompts[0]).toContain("请评审以下 2 个方案，给出排序与理由");
    h.sessionOf(chairId).finish("", "failed");
    await settle(() => expect(h.service.get(group.id).status).toBe("failed"));
  });

  test("buildChairPrompt：各成员回答超过 20k 字截断，per-member 附 diffStat", () => {
    const long = "x".repeat(GROUP_REPLY_MAX_CHARS + 500);
    const prompt = buildChairPrompt("synthesize", "任务", [
      { label: "成员 1", reply: long, diff: " a.txt | 1 +", worktree: { path: "/w/1", branch: "agentdeck/g/1" } },
      { label: "成员 2", reply: "短答案", diff: "", worktree: { path: "/w/2", branch: "agentdeck/g/2" } },
    ]);
    expect(prompt).toContain(`已截断，超过 ${GROUP_REPLY_MAX_CHARS} 字`);
    expect(prompt).not.toContain("x".repeat(GROUP_REPLY_MAX_CHARS + 1));
    expect(prompt).toContain("a.txt | 1 +");
    expect(prompt).toContain("（无改动）");
    expect(prompt).toContain("agentdeck/g/2");
    expect(prompt).toContain("# 原任务\n任务");
  });
});

describe.skipIf(!gitPath)("per-member worktree", () => {
  test("为每个成员建 worktree 与分支；汇总提示含各 worktree 的 diffStat；delete 解除 groupId 并按需删除 worktree", async () => {
    const repo = await makeRepo();
    const h = await setup();
    const group = await h.service.create(
      input({ cwd: repo, worktree: "per-member", chair: { provider: "fake", mode: "review" } }),
    );
    expect(group.members.map((member) => member.worktree!.branch)).toEqual([
      `agentdeck/${group.id}/1`,
      `agentdeck/${group.id}/2`,
    ]);
    for (const [index, member] of group.members.entries()) {
      expect(member.worktree!.path).toBe(path.join(realpathSync.native(repo), "tmp", "worktrees", group.id, String(index + 1)));
      expect(existsSync(path.join(member.worktree!.path, "a.txt"))).toBe(true);
      expect(h.manager.getAgent(member.agentId).cwd).toBe(member.worktree!.path);
    }
    writeFileSync(path.join(group.members[0]!.worktree!.path, "only-in-1.txt"), "new\n");
    for (const member of group.members) h.sessionOf(member.agentId).finish("完成");
    await settle(() => expect(h.service.get(group.id).chair?.agentId).toBeTruthy());
    const chairId = h.service.get(group.id).chair!.agentId!;
    expect(h.manager.getAgent(chairId).cwd).toBe(repo);
    await settle(() => expect(h.sessionOf(chairId).prompts).toHaveLength(1));
    expect(h.sessionOf(chairId).prompts[0]).toContain("only-in-1.txt");
    h.sessionOf(chairId).finish("评审结果");
    await settle(() => expect(h.service.get(group.id).status).toBe("done"));

    const result = await h.service.delete(group.id, true);
    expect(result).toEqual({});
    for (const member of group.members) {
      expect(existsSync(member.worktree!.path)).toBe(false);
      // 成员会话保留，只解除 groupId
      expect(h.manager.getAgent(member.agentId).groupId).toBeUndefined();
    }
    expect(existsSync(path.join(repo, "tmp", "worktrees", group.id))).toBe(false);
    expect(h.manager.getAgent(chairId).groupId).toBeUndefined();
    expect(await git(repo, "branch", "--list", `agentdeck/${group.id}/*`)).toBe("");
    expect(existsSync(path.join(h.dataDir, "groups", `${group.id}.json`))).toBe(false);
    expect(h.removed).toEqual([group.id]);
    expect(h.service.list()).toEqual([]);
  });

  test("delete 不删 worktree 时保留目录与分支，运行中的成员不受影响", async () => {
    const repo = await makeRepo();
    const h = await setup();
    const group = await h.service.create(input({ cwd: repo, worktree: "per-member" }));
    await h.service.delete(group.id, false);
    for (const member of group.members) {
      expect(existsSync(member.worktree!.path)).toBe(true);
      expect(h.manager.getAgent(member.agentId).status).toBe("running");
      expect(h.manager.getAgent(member.agentId).groupId).toBeUndefined();
    }
    expect(await git(repo, "branch", "--list", `agentdeck/${group.id}/*`)).toContain(`agentdeck/${group.id}/1`);
  });

  test("某个成员会话创建失败时回滚已建的 worktree 与会话", async () => {
    const repo = await makeRepo();
    const h = await setup();
    h.failCreateAt = 2;
    await expect(
      h.service.create(input({ cwd: repo, worktree: "per-member" })),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(h.manager.listAgents()).toHaveLength(0);
    expect(readdirSync(path.join(repo, "tmp", "worktrees"))).toEqual([]);
    expect(await git(repo, "worktree", "list")).not.toContain("worktrees");
    expect(await git(repo, "branch", "--list", "agentdeck/*")).toBe("");
    expect(h.service.list()).toEqual([]);
  });

  test("worktree 创建失败返回 INTERNAL_ERROR 且不建任何会话", async () => {
    const repo = await makeRepo();
    const h = await setup();
    // 让项目的 tmp 是个文件，mkdir 必然失败
    writeFileSync(path.join(repo, "tmp"), "占位");
    await expect(h.service.create(input({ cwd: repo, worktree: "per-member" }))).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    expect(h.manager.listAgents()).toHaveLength(0);
  });
});

describe("成员会话被删除", () => {
  test("从组中移除该成员（组仍保留）；剩余成员都结束后照常触发 chair", async () => {
    const h = await setup();
    const group = await h.service.create(
      input({ cwd: h.dataDir, chair: { provider: "fake", mode: "synthesize" } }),
    );
    h.sessionOf(group.members[0]!.agentId).finish("A");
    await h.manager.deleteAgent(group.members[1]!.agentId);
    await settle(() => expect(h.service.get(group.id).members).toHaveLength(1));
    await settle(() => expect(h.service.get(group.id).chair?.agentId).toBeTruthy());
    const chairId = h.service.get(group.id).chair!.agentId!;
    await settle(() => expect(h.sessionOf(chairId).prompts[0]).toContain("以下是 1 个 Agent"));
  });

  test("汇总会话被删除：进行中的组转 failed", async () => {
    const h = await setup();
    const group = await h.service.create(input({ cwd: h.dataDir, chair: { provider: "fake", mode: "review" } }));
    for (const member of group.members) h.sessionOf(member.agentId).finish("x");
    await settle(() => expect(h.service.get(group.id).chair?.agentId).toBeTruthy());
    const chairId = h.service.get(group.id).chair!.agentId!;
    await h.manager.deleteAgent(chairId);
    await settle(() => expect(h.service.get(group.id).status).toBe("failed"));
    expect(h.service.get(group.id).chair?.agentId).toBeUndefined();
  });
});

describe("sidecar 重启恢复", () => {
  async function restart(h: Harness): Promise<Harness> {
    await h.service.stop();
    await h.manager.shutdown();
    return setup(h.dataDir);
  }

  test("running：成员回合在重启时被打断，按失败处理并继续推进到 chair", async () => {
    const h1 = await setup();
    const group = await h1.service.create(input({ cwd: h1.dataDir, chair: { provider: "fake", mode: "synthesize" } }));
    h1.sessionOf(group.members[0]!.agentId).finish("已完成的答案");
    await settle(() => expect(h1.service.get(group.id).status).toBe("running"));
    const h2 = await restart(h1);
    await settle(() => expect(h2.service.get(group.id).chair?.agentId).toBeTruthy());
    expect(h2.service.get(group.id).status).toBe("chairing");
    const chairId = h2.service.get(group.id).chair!.agentId!;
    await settle(() => expect(h2.sessionOf(chairId).prompts).toHaveLength(1));
    expect(h2.sessionOf(chairId).prompts[0]).toContain("已完成的答案");
    expect(h2.sessionOf(chairId).prompts[0]).toContain("sidecar 重启时该回合被中断");
  });

  test("chairing 且汇总会话尚未建出：重启后重新建汇总会话", async () => {
    const h1 = await setup();
    const group = await h1.service.create(input({ cwd: h1.dataDir, chair: { provider: "fake", mode: "review" } }));
    for (const member of group.members) h1.sessionOf(member.agentId).finish("答");
    await settle(() => expect(h1.service.get(group.id).chair?.agentId).toBeTruthy());
    const oldChair = h1.service.get(group.id).chair!.agentId!;
    // 模拟「已标 chairing 但汇总会话没建出」：改磁盘文件并删掉汇总会话
    await h1.manager.deleteAgent(oldChair);
    const file = path.join(h1.dataDir, "groups", `${group.id}.json`);
    const stored = JSON.parse(readFileSync(file, "utf8")) as AgentGroup;
    delete stored.chair!.agentId;
    stored.status = "chairing";
    await h1.service.stop();
    writeFileSync(file, JSON.stringify(stored));
    await h1.manager.shutdown();
    const h2 = await setup(h1.dataDir);
    await settle(() => expect(h2.service.get(group.id).chair?.agentId).toBeTruthy());
    expect(h2.service.get(group.id).chair!.agentId).not.toBe(oldChair);
  });

  test("chairing：汇总会话已有结束回合 → 按结局 done；没有结束回合 → 继续等待", async () => {
    const h1 = await setup();
    const doneGroup = await h1.service.create(input({ cwd: h1.dataDir, chair: { provider: "fake", mode: "synthesize" } }));
    const waitGroup = await h1.service.create(input({ cwd: h1.dataDir, chair: { provider: "fake", mode: "synthesize" } }));
    for (const group of [doneGroup, waitGroup]) {
      for (const member of group.members) h1.sessionOf(member.agentId).finish("答");
    }
    await settle(() => expect(h1.service.get(doneGroup.id).chair?.agentId).toBeTruthy());
    await settle(() => expect(h1.service.get(waitGroup.id).chair?.agentId).toBeTruthy());
    const doneChair = h1.service.get(doneGroup.id).chair!.agentId!;
    await settle(() => expect(h1.sessionOf(doneChair).prompts).toHaveLength(1));
    h1.sessionOf(doneChair).finish("结论");
    await settle(() => expect(h1.service.get(doneGroup.id).status).toBe("done"));
    // 把 doneGroup 在磁盘上改回 chairing，模拟重启前尚未写入终态
    const file = path.join(h1.dataDir, "groups", `${doneGroup.id}.json`);
    const stored = JSON.parse(readFileSync(file, "utf8")) as AgentGroup;
    stored.status = "chairing";
    await h1.service.stop();
    writeFileSync(file, JSON.stringify(stored));
    await h1.manager.shutdown();
    const h2 = await setup(h1.dataDir);
    await settle(() => expect(h2.service.get(doneGroup.id).status).toBe("done"));
    expect(h2.service.get(waitGroup.id).status).toBe("chairing");
  });

  test("损坏的组文件被跳过，不影响其它组", async () => {
    const h1 = await setup();
    const group = await h1.service.create(input({ cwd: h1.dataDir }));
    await h1.service.stop();
    writeFileSync(path.join(h1.dataDir, "groups", "broken.json"), "{ not json");
    await h1.manager.shutdown();
    const h2 = await setup(h1.dataDir);
    expect(h2.service.list().map((item) => item.id)).toEqual([group.id]);
  });
});
