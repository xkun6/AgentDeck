import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentStreamEnvelope } from "@agentdeck/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";

import { AgentStore, writeFileAtomic, type PersistedAgentMeta } from "../src/agent/agent-store.js";
import type { Logger } from "../src/logger.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function makeDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agentdeck-store-"));
  tempDirs.push(dir);
  return dir;
}

function recordingLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string, ...args: unknown[]) => warnings.push([message, ...args].join(" ")),
    error: (message: string, ...args: unknown[]) => warnings.push([message, ...args].join(" ")),
    close: () => undefined,
  };
}

function meta(id: string, overrides: Partial<PersistedAgentMeta> = {}): PersistedAgentMeta {
  return {
    id,
    provider: "mock",
    cwd: "/work",
    model: null,
    modeId: null,
    status: "idle",
    lastError: null,
    persistence: { provider: "mock", sessionId: `s-${id}` },
    lastSeq: 0,
    resumable: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function envelope(agentId: string, seq: number): AgentStreamEnvelope {
  return {
    agentId,
    seq,
    epoch: "e1",
    timestamp: seq,
    event: { type: "timeline", item: { type: "assistant_message", text: `t${seq}` } },
  };
}

describe("AgentStore", () => {
  test("写入/读取往返：meta + timeline，目录结构符合 4.5", async () => {
    const dataDir = makeDataDir();
    const store = new AgentStore({ dataDir });
    const current = meta("a1", { lastSeq: 2, preview: "你好" });
    store.appendEntry("a1", envelope("a1", 1));
    store.appendEntry("a1", envelope("a1", 2));
    await store.flushMeta("a1", () => current);

    const dir = path.join(dataDir, "agents", "a1");
    expect(readdirSync(dir).sort()).toEqual(["meta.json", "timeline.jsonl"]);
    const lines = readFileSync(path.join(dir, "timeline.jsonl"), "utf8").trimEnd().split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([envelope("a1", 1), envelope("a1", 2)]);

    const reloaded = new AgentStore({ dataDir });
    const metas = await reloaded.loadAll();
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({ id: "a1", lastSeq: 2, preview: "你好", status: "idle" });
    // resumable 由 manager 重新计算，读取时一律置 false
    expect(metas[0]!.resumable).toBe(false);
    await expect(reloaded.readTimeline("a1")).resolves.toEqual({
      entries: [envelope("a1", 1), envelope("a1", 2)],
      lastSeq: 2,
    });
  });

  test("backgroundActive 不持久化：即使 meta.json 里有也在读取时丢弃", async () => {
    const dataDir = makeDataDir();
    const store = new AgentStore({ dataDir });
    await store.flushMeta("a1", () => meta("a1", { backgroundActive: true } as Partial<PersistedAgentMeta>));
    const metas = await new AgentStore({ dataDir }).loadAll();
    expect(metas).toHaveLength(1);
    expect("backgroundActive" in metas[0]!).toBe(false);
  });

  test("meta 原子写：目标已存在时覆盖，且不残留临时文件", async () => {
    const dataDir = makeDataDir();
    const file = path.join(dataDir, "meta.json");
    writeFileSync(file, "old");
    await writeFileAtomic(file, "new");
    expect(readFileSync(file, "utf8")).toBe("new");
    expect(readdirSync(dataDir)).toEqual(["meta.json"]);
  });

  test("meta 500ms 防抖：窗口内多次 schedule 只写一次最新值；flushMeta 立即落盘", async () => {
    vi.useFakeTimers();
    const dataDir = makeDataDir();
    const store = new AgentStore({ dataDir });
    const file = path.join(dataDir, "agents", "a1", "meta.json");
    let value = meta("a1", { updatedAt: 1 });
    const source = vi.fn(() => value);

    store.scheduleMeta("a1", source);
    value = meta("a1", { updatedAt: 2 });
    store.scheduleMeta("a1", source);
    await vi.advanceTimersByTimeAsync(499);
    expect(existsSync(file)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await store.flushAll();
    expect(source).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ updatedAt: 2 });

    // 强制落盘：不等防抖
    value = meta("a1", { updatedAt: 3 });
    store.scheduleMeta("a1", source);
    await store.flushMeta("a1");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ updatedAt: 3 });
    expect(source).toHaveBeenCalledTimes(2);
  });

  test("flushAll 写出全部待写 agent", async () => {
    const dataDir = makeDataDir();
    const store = new AgentStore({ dataDir, debounceMs: 60_000 });
    store.scheduleMeta("a1", () => meta("a1"));
    store.scheduleMeta("a2", () => meta("a2"));
    store.appendEntry("a3", envelope("a3", 1));
    await store.flushAll();
    expect(existsSync(path.join(dataDir, "agents", "a1", "meta.json"))).toBe(true);
    expect(existsSync(path.join(dataDir, "agents", "a2", "meta.json"))).toBe(true);
    expect(existsSync(path.join(dataDir, "agents", "a3", "timeline.jsonl"))).toBe(true);
  });

  test("损坏的 meta / 目录记日志后跳过，不影响其它会话", async () => {
    const dataDir = makeDataDir();
    const agentsDir = path.join(dataDir, "agents");
    const write = (name: string, content: string) => {
      mkdirSync(path.join(agentsDir, name), { recursive: true });
      writeFileSync(path.join(agentsDir, name, "meta.json"), content);
    };
    write("good", JSON.stringify(meta("good")));
    write("broken", "{ not json");
    write("mismatch", JSON.stringify(meta("other-id")));
    write("missing-fields", JSON.stringify({ id: "missing-fields" }));
    mkdirSync(path.join(agentsDir, "no-meta"), { recursive: true });
    writeFileSync(path.join(agentsDir, "stray-file.txt"), "x");

    const logger = recordingLogger();
    const metas = await new AgentStore({ dataDir, logger }).loadAll();
    expect(metas.map((m) => m.id)).toEqual(["good"]);
    expect(logger.warnings.length).toBeGreaterThanOrEqual(4);
  });

  test("数据目录不存在时返回空列表", async () => {
    const dataDir = path.join(makeDataDir(), "not-yet");
    await expect(new AgentStore({ dataDir }).loadAll()).resolves.toEqual([]);
    await expect(new AgentStore({ dataDir }).readTimeline("x")).resolves.toEqual({
      entries: [],
      lastSeq: 0,
    });
  });

  test("timeline 损坏行跳过；末尾半行时下次追加先补换行，seq 续号", async () => {
    const dataDir = makeDataDir();
    const dir = path.join(dataDir, "agents", "a1");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "timeline.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify(envelope("a1", 1)),
        "garbage",
        JSON.stringify({ seq: "2" }),
        JSON.stringify(envelope("a1", 3)),
        JSON.stringify(envelope("a1", 2)), // 乱序：跳过
        '{"agentId":"a1","seq":4,"ev', // 崩溃留下的半行
      ].join("\n"),
    );

    const logger = recordingLogger();
    const store = new AgentStore({ dataDir, logger });
    const loaded = await store.readTimeline("a1");
    expect(loaded.entries.map((e) => e.seq)).toEqual([1, 3]);
    expect(loaded.lastSeq).toBe(3);
    expect(logger.warnings.some((w) => w.includes("损坏") && w.endsWith(" 4"))).toBe(true);

    store.appendEntry("a1", envelope("a1", 4));
    await store.flushAll();
    const reread = await new AgentStore({ dataDir }).readTimeline("a1");
    expect(reread.entries.map((e) => e.seq)).toEqual([1, 3, 4]);
  });

  test("deleteAgent 删除目录，之后的写入被忽略", async () => {
    const dataDir = makeDataDir();
    const store = new AgentStore({ dataDir });
    store.appendEntry("a1", envelope("a1", 1));
    await store.flushMeta("a1", () => meta("a1"));
    const dir = path.join(dataDir, "agents", "a1");
    expect(existsSync(dir)).toBe(true);

    store.scheduleMeta("a1", () => meta("a1"));
    await store.deleteAgent("a1");
    expect(existsSync(dir)).toBe(false);
    store.appendEntry("a1", envelope("a1", 2));
    await store.flushMeta("a1", () => meta("a1"));
    await store.flushAll();
    expect(existsSync(dir)).toBe(false);
    await expect(store.deleteAgent("../evil")).rejects.toThrow("非法");
  });
});

function toolEnvelope(agentId: string, seq: number, callId: string): AgentStreamEnvelope {
  return {
    agentId,
    seq,
    epoch: "e1",
    timestamp: seq,
    event: {
      type: "timeline",
      item: { type: "tool_call", callId, name: "Agent", status: "running", detail: { type: "unknown", input: seq, output: null } },
    },
  };
}

describe("AgentStore：tool_call 中间更新压缩（design.md 4.5）", () => {
  test("readTimeline 返回压缩结果，写入链随后原子重写磁盘文件", async () => {
    const dataDir = makeDataDir();
    const dir = path.join(dataDir, "agents", "a1");
    mkdirSync(dir, { recursive: true });
    const all = [
      envelope("a1", 1),
      toolEnvelope("a1", 2, "c1"),
      toolEnvelope("a1", 3, "c1"),
      toolEnvelope("a1", 4, "c1"),
      envelope("a1", 5),
    ];
    const file = path.join(dir, "timeline.jsonl");
    writeFileSync(file, all.map((e) => `${JSON.stringify(e)}\n`).join(""), "utf8");

    const store = new AgentStore({ dataDir });
    const loaded = await store.readTimeline("a1");
    expect(loaded.entries.map((e) => e.seq)).toEqual([1, 2, 4, 5]);
    expect(loaded.lastSeq).toBe(5);

    // 第二次读取会先 drain 写入链，此时重写已完成
    const again = await store.readTimeline("a1");
    expect(again.entries.map((e) => e.seq)).toEqual([1, 2, 4, 5]);
    const onDisk = readFileSync(file, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
    expect(onDisk.map((e: AgentStreamEnvelope) => e.seq)).toEqual([1, 2, 4, 5]);
    expect(again.lastSeq).toBe(5);
  });
});
