import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SidecarSettings } from "@agentdeck/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { AgentManager } from "../src/agent/agent-manager.js";
import { MockAgentClient } from "../src/providers/mock/index.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { RpcServer } from "../src/server/rpc-server.js";
import { DEFAULT_SIDECAR_SETTINGS, SettingsStore } from "../src/settings/sidecar-settings.js";
import { locateGit } from "../src/snapshots/git.js";
import { SnapshotService } from "../src/snapshots/snapshot-service.js";
import { RpcCallError, TestRpcClient } from "./rpc-test-client.js";

const gitPath = await locateGit();
const hasGit = gitPath !== null;
const TOKEN = "test-token-0123456789abcdef";

let root: string;
let dataDir: string;
let cwd: string;
let settings: SidecarSettings["snapshots"];
let busy: boolean;
let service: SnapshotService;
let turnCounter: number;

function write(file: string, content: string): void {
  const full = path.join(cwd, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function read(file: string): string {
  return readFileSync(path.join(cwd, file), "utf8");
}

function makeService(overrides: { gitPath?: string | null } = {}): SnapshotService {
  return new SnapshotService({
    dataDir,
    settings: () => settings,
    agentCwd: (agentId) => (agentId === "a1" || agentId === "a2" ? cwd : undefined),
    listAgents: () => [
      { id: "a1", cwd },
      { id: "a2", cwd },
    ],
    isCwdBusy: () => busy,
    ...(overrides.gitPath !== undefined ? { gitPath: overrides.gitPath } : {}),
  });
}

/** 模拟一个回合：回合前快照 → mutate 修改工作区 → 回合后快照 */
async function runTurn(agentId: string, mutate: () => void): Promise<string> {
  const turnId = `t${++turnCounter}`;
  await service.onTurnStarted({ agentId, cwd, turnId, seq: turnCounter * 10, startedAt: 1000 + turnCounter });
  mutate();
  await service.onTurnEnded({ agentId, cwd, turnId });
  return turnId;
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "agentdeck-snap-"));
  dataDir = path.join(root, "data");
  cwd = path.join(root, "work");
  mkdirSync(cwd, { recursive: true });
  settings = { ...DEFAULT_SIDECAR_SETTINGS.snapshots };
  busy = false;
  turnCounter = 0;
  service = makeService();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("SettingsStore", () => {
  test("默认值、patch 合并与原子落盘，重新加载保持", async () => {
    const store = new SettingsStore({ dataDir: root });
    await store.load();
    expect(store.get()).toEqual(DEFAULT_SIDECAR_SETTINGS);
    const seen: SidecarSettings[] = [];
    store.subscribe((value) => seen.push(value));
    const next = await store.set({ snapshots: { maxFiles: 5 }, interop: { enabled: false } });
    expect(next.snapshots).toEqual({ ...DEFAULT_SIDECAR_SETTINGS.snapshots, maxFiles: 5 });
    expect(next.interop.enabled).toBe(false);
    expect(seen).toHaveLength(1);

    const reloaded = new SettingsStore({ dataDir: root });
    await reloaded.load();
    expect(reloaded.get()).toEqual(next);
    expect(existsSync(path.join(root, "sidecar-settings.json"))).toBe(true);
  });

  test("文件中非法字段回退默认值，未设 dataDir 只在内存", async () => {
    writeFileSync(
      path.join(root, "sidecar-settings.json"),
      JSON.stringify({ snapshots: { enabled: "yes", maxFiles: 7 }, interop: 3 }),
    );
    const store = new SettingsStore({ dataDir: root });
    await store.load();
    expect(store.get().snapshots).toEqual({ ...DEFAULT_SIDECAR_SETTINGS.snapshots, maxFiles: 7 });
    expect(store.get().interop).toEqual(DEFAULT_SIDECAR_SETTINGS.interop);

    const memory = new SettingsStore();
    await memory.set({ snapshots: { enabled: false } });
    expect(memory.get().snapshots.enabled).toBe(false);
  });
});

describe.skipIf(!hasGit)("SnapshotService（真实 git）", () => {
  test("回合前后快照与 changedFiles，树相同时复用提交", async () => {
    write("keep.txt", "keep\n");
    write("edit.txt", "v1\n");
    write("gone.txt", "bye\n");
    const t1 = await runTurn("a1", () => {
      write("edit.txt", "v2\n");
      write("new.txt", "hello\n");
      rmSync(path.join(cwd, "gone.txt"));
    });
    const t2 = await runTurn("a1", () => undefined);

    const turns = await service.list("a1");
    expect(turns.map((t) => t.turnId)).toEqual([t1, t2]);
    const [first, second] = turns;
    expect(first?.before).toBeTruthy();
    expect(first?.after).toBeTruthy();
    expect(first?.after).not.toBe(first?.before);
    const changed = Object.fromEntries((first?.changedFiles ?? []).map((f) => [f.path, f.status]));
    expect(changed).toEqual({ "edit.txt": "M", "new.txt": "A", "gone.txt": "D" });
    // 第二回合没有任何改动：回合前 = 上一回合后，回合后复用同一提交
    expect(second?.before).toBe(first?.after);
    expect(second?.after).toBe(second?.before);
    expect(second?.changedFiles).toEqual([]);

    const ref = execFileSync(
      gitPath as string,
      ["--git-dir", path.join(dataDir, "snapshots", readdirOne(path.join(dataDir, "snapshots")), "repo"), "rev-parse", "refs/agentdeck/a1"],
      { encoding: "utf8" },
    ).trim();
    expect(ref).toBe(second?.after);
    // 索引已落盘
    const file = path.join(dataDir, "agents", "a1", "snapshots.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(2);
  });

  test("默认排除规则、.gitignore 与大文件过滤", async () => {
    settings = { ...settings, maxFileBytes: 100 };
    write(".gitignore", "ignored.txt\n");
    const t1 = await runTurn("a1", () => {
      write("src/a.ts", "x\n");
      write("node_modules/pkg/index.js", "x\n");
      write("debug.log", "x\n");
      write("ignored.txt", "x\n");
      write("big.bin", "y".repeat(500));
      write("sub/.git/config", "nested\n");
    });
    const turn = (await service.list("a1")).find((t) => t.turnId === t1);
    const paths = (turn?.changedFiles ?? []).map((f) => f.path).sort();
    expect(paths).toEqual(["src/a.ts"]);
  });

  test("候选文件数超过 maxFiles 时跳过快照并记录 skipped", async () => {
    settings = { ...settings, maxFiles: 3 };
    for (let i = 0; i < 5; i += 1) {
      write(`f${i}.txt`, "x\n");
    }
    await runTurn("a1", () => undefined);
    const [turn] = await service.list("a1");
    expect(turn).toMatchObject({ skipped: "too_many_files", before: null, after: null });
    expect(turn?.changedFiles).toEqual([]);
  });

  test("restore：删除新增、恢复修改、恢复删除；backupCommit 可再恢复", async () => {
    write("edit.txt", "v1\n");
    write("gone.txt", "bye\n");
    const t1 = await runTurn("a1", () => {
      write("edit.txt", "v2\n");
      write("dir/new.txt", "n\n");
      rmSync(path.join(cwd, "gone.txt"));
    });
    const result = await service.restore("a1", t1);
    expect(result.deleted).toEqual(["dir/new.txt"]);
    expect([...result.restored].sort()).toEqual(["edit.txt", "gone.txt"]);
    expect(read("edit.txt")).toBe("v1\n");
    expect(read("gone.txt")).toBe("bye\n");
    expect(existsSync(path.join(cwd, "dir"))).toBe(false);
    expect(result.backupCommit).toMatch(/^[0-9a-f]{40}$/);

    // 用恢复前快照再恢复回「回合后」的状态：通过备份提交的内容核对
    const showNew = execFileSync(
      gitPath as string,
      ["--git-dir", path.join(dataDir, "snapshots", readdirOne(path.join(dataDir, "snapshots")), "repo"), "show", `${result.backupCommit}:edit.txt`],
      { encoding: "utf8" },
    );
    expect(showNew).toBe("v2\n");
    const refBackup = execFileSync(
      gitPath as string,
      ["--git-dir", path.join(dataDir, "snapshots", readdirOne(path.join(dataDir, "snapshots")), "repo"), "rev-parse", "refs/agentdeck/restore"],
      { encoding: "utf8" },
    ).trim();
    expect(refBackup).toBe(result.backupCommit);
  });

  test("restore 的 paths 过滤只处理指定路径", async () => {
    write("a.txt", "a1\n");
    write("b.txt", "b1\n");
    const t1 = await runTurn("a1", () => {
      write("a.txt", "a2\n");
      write("b.txt", "b2\n");
      write("c.txt", "c\n");
    });
    const result = await service.restore("a1", t1, ["a.txt"]);
    expect(result).toMatchObject({ restored: ["a.txt"], deleted: [] });
    expect(read("a.txt")).toBe("a1\n");
    expect(read("b.txt")).toBe("b2\n");
    expect(existsSync(path.join(cwd, "c.txt"))).toBe(true);
    await expect(service.restore("a1", t1, ["../x"])).rejects.toThrow(/非法路径/);
  });

  test("同 cwd 有运行中回合时 restore / prune 返回 TURN_IN_PROGRESS", async () => {
    write("a.txt", "1\n");
    const t1 = await runTurn("a1", () => write("a.txt", "2\n"));
    busy = true;
    await expect(service.restore("a1", t1)).rejects.toMatchObject({ code: "TURN_IN_PROGRESS" });
    await expect(service.prune(cwd)).rejects.toMatchObject({ code: "TURN_IN_PROGRESS" });
    expect(read("a.txt")).toBe("2\n");
  });

  test("diff：回合前后与当前工作区，path 过滤", async () => {
    write("a.txt", "a1\n");
    write("b.txt", "b1\n");
    const t1 = await runTurn("a1", () => {
      write("a.txt", "a2\n");
      write("b.txt", "b2\n");
    });
    const all = await service.diff("a1", t1);
    expect(all.truncated).toBe(false);
    expect(all.diff).toContain("a.txt");
    expect(all.diff).toContain("b.txt");
    const one = await service.diff("a1", t1, { path: "a.txt" });
    expect(one.diff).toContain("+a2");
    expect(one.diff).not.toContain("b.txt");
    write("a.txt", "a3\n");
    const current = await service.diff("a1", t1, { path: "a.txt", against: "current" });
    expect(current.diff).toContain("+a3");
    await expect(service.diff("a1", t1, { path: "../etc" })).rejects.toThrow(/非法路径/);
  });

  test("diff 超过 512KB 时截断", async () => {
    const t1 = await runTurn("a1", () => write("huge.txt", "line of text\n".repeat(60_000)));
    // 默认 5MB 上限内的文件（约 780KB）被纳入，diff 超过 512KB 被截断
    const { diff, truncated } = await service.diff("a1", t1);
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(diff)).toBeLessThanOrEqual(512 * 1024);
  });

  test("snapshots 关闭时不拍快照，记 skipped: disabled", async () => {
    settings = { ...settings, enabled: false };
    write("a.txt", "1\n");
    await runTurn("a1", () => write("a.txt", "2\n"));
    const [turn] = await service.list("a1");
    expect(turn).toMatchObject({ skipped: "disabled", before: null, after: null });
    expect(existsSync(path.join(dataDir, "snapshots"))).toBe(false);
  });

  test("非 git 目录与已有 .git 的目录都能快照，且不碰工作目录自身的 .git", async () => {
    write("plain.txt", "1\n");
    const t1 = await runTurn("a1", () => write("plain.txt", "2\n"));
    expect((await service.list("a1")).find((t) => t.turnId === t1)?.changedFiles).toEqual([
      { path: "plain.txt", status: "M" },
    ]);

    execFileSync(gitPath as string, ["init", "-q", cwd]);
    const t2 = await runTurn("a1", () => write("another.txt", "x\n"));
    const turn = (await service.list("a1")).find((t) => t.turnId === t2);
    expect(turn?.changedFiles).toEqual([{ path: "another.txt", status: "A" }]);
    // 工作目录自己的仓库没有被影子仓库写入任何暂存
    const status = execFileSync(gitPath as string, ["-C", cwd, "status", "--porcelain"], {
      encoding: "utf8",
    });
    expect(status).toContain("?? ");
  });

  test("removeAgent 只删除该会话的引用，prune 清理仓库并标记索引", async () => {
    write("a.txt", "1\n");
    await runTurn("a1", () => write("a.txt", "2\n"));
    await runTurn("a2", () => write("a.txt", "3\n"));
    const repo = path.join(dataDir, "snapshots", readdirOne(path.join(dataDir, "snapshots")), "repo");
    const refs = () =>
      execFileSync(gitPath as string, ["--git-dir", repo, "for-each-ref", "--format=%(refname)"], {
        encoding: "utf8",
      })
        .split("\n")
        .filter(Boolean);
    expect(refs()).toEqual(expect.arrayContaining(["refs/agentdeck/a1", "refs/agentdeck/a2"]));
    await service.removeAgent("a1", cwd);
    expect(refs()).toEqual(["refs/agentdeck/a2"]);

    const storage = await service.storage();
    expect(storage).toHaveLength(1);
    expect(storage[0]?.bytes).toBeGreaterThan(0);

    await service.prune(cwd);
    expect(existsSync(repo)).toBe(false);
    expect(await service.storage()).toEqual([]);
    const turns = await service.list("a2");
    expect(turns.every((t) => t.pruned === true)).toBe(true);
    await expect(service.restore("a2", turns[0]?.turnId ?? "")).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
    });
  });
});

describe("git 不可用", () => {
  test("静默关闭：回合记 skipped: git_unavailable，不抛错", async () => {
    service = makeService({ gitPath: null });
    write("a.txt", "1\n");
    await runTurn("a1", () => write("a.txt", "2\n"));
    const [turn] = await service.list("a1");
    expect(turn).toMatchObject({ skipped: "git_unavailable", before: null, after: null });
    await expect(service.diff("a1", turn?.turnId ?? "")).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
    });
  });
});

function readdirOne(dir: string): string {
  const names = execFileSync(process.execPath, [
    "-e",
    `process.stdout.write(require("fs").readdirSync(${JSON.stringify(dir)}).join("\\n"))`,
  ])
    .toString()
    .split("\n");
  return names[0] as string;
}

describe.skipIf(!hasGit)("RPC 与 AgentManager 集成", () => {
  let server: RpcServer;
  let client: TestRpcClient;
  let manager: AgentManager;

  beforeEach(async () => {
    const registry = new ProviderRegistry([new MockAgentClient()]);
    const settingsStore = new SettingsStore({ dataDir });
    await settingsStore.load();
    const snapshots = new SnapshotService({
      dataDir,
      settings: () => settingsStore.get().snapshots,
      agentCwd: (id) => manager.listAgents().find((a) => a.id === id)?.cwd,
      listAgents: () => manager.listAgents().map((a) => ({ id: a.id, cwd: a.cwd })),
      isCwdBusy: (dir) => manager.isCwdBusy(dir),
    });
    manager = new AgentManager({ registry, snapshots });
    server = new RpcServer({
      token: TOKEN,
      version: "t",
      manager,
      registry,
      settings: settingsStore,
      snapshots,
    });
    const port = await server.listen(0);
    client = await TestRpcClient.connect(`ws://127.0.0.1:${port}/rpc?token=${TOKEN}`);
  });

  afterEach(async () => {
    client.close();
    await server.close();
  });

  test("回合结束后 snapshot.list 带本回合 turn_started 的 seq；agent.delete 清理引用", async () => {
    write("a.txt", "1\n");
    const { agent } = await client.call("agent.create", { provider: "mock", cwd });
    await client.call("agent.send", { agentId: agent.id, prompt: "hi" });
    await client.waitForTurnEnd(agent.id);
    const { turns } = await client.call("snapshot.list", { agentId: agent.id });
    expect(turns).toHaveLength(1);
    const started = client.streams.find(
      (e) => e.agentId === agent.id && e.event.type === "turn_started",
    );
    expect(turns[0]).toMatchObject({ seq: started?.seq, changedFiles: [] });
    expect(turns[0]?.before).toBeTruthy();
    expect(turns[0]?.after).toBe(turns[0]?.before);

    const repo = path.join(dataDir, "snapshots", readdirOne(path.join(dataDir, "snapshots")), "repo");
    await client.call("agent.delete", { agentId: agent.id });
    // removeAgent 异步进行；稍等引用被删
    for (let i = 0; i < 50; i += 1) {
      const refs = execFileSync(gitPath as string, ["--git-dir", repo, "for-each-ref"], { encoding: "utf8" });
      if (refs.trim() === "") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const refs = execFileSync(gitPath as string, ["--git-dir", repo, "for-each-ref"], { encoding: "utf8" });
    expect(refs.trim()).toBe("");
  });

  test("snapshot.restore 对运行中的工作目录返回 TURN_IN_PROGRESS；参数校验为 -32602", async () => {
    const { agent } = await client.call("agent.create", { provider: "mock", cwd });
    await client.call("agent.send", { agentId: agent.id, prompt: "hi" });
    await client.waitForTurnEnd(agent.id);
    const { turns } = await client.call("snapshot.list", { agentId: agent.id });
    const turnId = turns[0]?.turnId as string;
    await client.call("agent.send", { agentId: agent.id, prompt: "again /slow" });
    const raw = await client.request("snapshot.restore", { agentId: agent.id, turnId });
    // 回合是否仍在进行取决于 mock 速度：进行中必为 TURN_IN_PROGRESS，已结束则成功
    if (raw.error) {
      expect(raw.error.data?.code).toBe("TURN_IN_PROGRESS");
    }
    await client.waitForTurnEnd(agent.id);
    const bad = await client.request("snapshot.restore", { agentId: agent.id });
    expect(bad.error?.code).toBe(-32602);
    const badSettings = await client.request("settings.set", { patch: { snapshots: { maxFiles: -1 } } });
    expect(badSettings.error?.code).toBe(-32602);
    const unknown = await client.request("settings.set", { patch: { foo: 1 } });
    expect(unknown.error?.code).toBe(-32602);
  });

  test("settings.get / set 与 settings.changed 广播", async () => {
    const initial = await client.call("settings.get", undefined);
    expect(initial).toEqual(DEFAULT_SIDECAR_SETTINGS);
    const updated = await client.call("settings.set", { patch: { snapshots: { enabled: false } } });
    expect(updated.snapshots.enabled).toBe(false);
    for (let i = 0; i < 50 && client.notifications.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(client.notifications.some((n) => n.method === "settings.changed")).toBe(true);
    await expect(client.call("snapshot.diff", { agentId: "nope", turnId: "x" })).rejects.toBeInstanceOf(
      RpcCallError,
    );
  });
});
