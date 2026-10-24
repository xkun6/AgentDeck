import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

import { TestRpcClient } from "./rpc-test-client.js";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "e2e-token-abcdef";

interface ReadyLine {
  type: "ready";
  port: number;
  version: string;
  pid: number;
}

const children: ChildProcess[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function startSidecar(env: Record<string, string | undefined>) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (key.toUpperCase().startsWith("AGENTDECK_")) delete childEnv[key];
  }
  // mock provider 只在 AGENTDECK_ENABLE_MOCK=1 时注册，本测试依赖它
  Object.assign(childEnv, { AGENTDECK_ENABLE_MOCK: "1" }, env);
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: PACKAGE_DIR,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  children.push(child);

  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => (stdout += chunk));
  child.stderr!.on("data", (chunk: string) => (stderr += chunk));

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  const ready = new Promise<ReadyLine>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ready 超时，stderr:\n${stderr}`)), 20_000);
    const onData = () => {
      const newline = stdout.indexOf("\n");
      if (newline >= 0) {
        clearTimeout(timer);
        child.stdout!.off("data", onData);
        resolve(JSON.parse(stdout.slice(0, newline)) as ReadyLine);
      }
    };
    child.stdout!.on("data", onData);
    void exited.then(({ code }) => {
      clearTimeout(timer);
      reject(new Error(`sidecar 提前退出（code=${code}），stderr:\n${stderr}`));
    });
  });

  return {
    child,
    ready,
    exited,
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

describe("main.ts 端到端", () => {
  test("输出 ready 行 → WS 跑一轮 mock 对话 → 关闭 stdin 后 5 秒内以 0 退出", async () => {
    const logDir = mkdtempSync(path.join(tmpdir(), "agentdeck-sidecar-log-"));
    tempDirs.push(logDir);
    const nestedLogDir = path.join(logDir, "nested", "logs");
    const sidecar = startSidecar({ AGENTDECK_TOKEN: TOKEN, AGENTDECK_LOG_DIR: nestedLogDir });

    const ready = await sidecar.ready;
    expect(ready).toMatchObject({ type: "ready", version: "0.3.7", pid: sidecar.child.pid });
    expect(ready.port).toBeGreaterThan(0);

    const health = await fetch(`http://127.0.0.1:${ready.port}/health`);
    await expect(health.json()).resolves.toEqual({ ok: true, version: "0.3.7" });

    const client = await TestRpcClient.connect(
      `ws://127.0.0.1:${ready.port}/rpc?token=${TOKEN}`,
    );
    const { agent } = await client.call("agent.create", { provider: "mock", cwd: PACKAGE_DIR });
    await client.call("agent.send", { agentId: agent.id, prompt: "端到端" });
    await expect(client.waitForTurnEnd(agent.id)).resolves.toMatchObject({
      type: "turn_completed",
    });
    const text = client
      .eventsFor(agent.id)
      .map((e) => (e.type === "timeline" && e.item.type === "assistant_message" ? e.item.text : ""))
      .join("");
    expect(text).toBe("Mock 回复：端到端");

    sidecar.child.stdin!.end();
    const exit = await withTimeout(sidecar.exited, 5_000, "关闭 stdin 后 5 秒内未退出");
    expect(exit).toEqual({ code: 0, signal: null });
    await client.close();

    // stdout 只有 ready 一行
    expect(sidecar.getStdout().trim().split("\n")).toHaveLength(1);
    const log = readFileSync(path.join(nestedLogDir, "sidecar.log"), "utf8");
    expect(log).toContain("开始关闭：stdin");
  });

  test("AGENTDECK_DATA_DIR：跑一轮 → 退出 → 同目录重启 → dormant + 历史 timeline → send 自动恢复且 seq 接续", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "agentdeck-sidecar-data-"));
    tempDirs.push(dataDir);
    const env = { AGENTDECK_TOKEN: TOKEN, AGENTDECK_DATA_DIR: dataDir };

    // 第一次启动：建会话跑一轮
    const first = startSidecar(env);
    const firstReady = await first.ready;
    const c1 = await TestRpcClient.connect(`ws://127.0.0.1:${firstReady.port}/rpc?token=${TOKEN}`);
    const { agent } = await c1.call("agent.create", { provider: "mock", cwd: PACKAGE_DIR });
    await c1.call("agent.send", { agentId: agent.id, prompt: "第一轮\n持久化" });
    await expect(c1.waitForTurnEnd(agent.id)).resolves.toMatchObject({ type: "turn_completed" });
    const firstEntries = (await c1.call("agent.timeline", { agentId: agent.id })).entries;
    const firstLastSeq = firstEntries.at(-1)!.seq;
    expect(firstEntries.map((e) => e.seq)).toEqual(
      Array.from({ length: firstLastSeq }, (_, i) => i + 1),
    );

    first.child.stdin!.end();
    expect(await withTimeout(first.exited, 5_000, "第一次关闭 stdin 后未退出")).toEqual({
      code: 0,
      signal: null,
    });
    await c1.close();

    const agentDir = path.join(dataDir, "agents", agent.id);
    const meta = JSON.parse(readFileSync(path.join(agentDir, "meta.json"), "utf8"));
    expect(meta).toMatchObject({ id: agent.id, lastSeq: firstLastSeq, preview: "第一轮 持久化" });
    expect(meta).not.toHaveProperty("pendingPermissions");
    const timelineLines = readFileSync(path.join(agentDir, "timeline.jsonl"), "utf8")
      .trimEnd()
      .split("\n");
    expect(timelineLines).toHaveLength(firstLastSeq);

    // 第二次启动：同一数据目录
    const second = startSidecar(env);
    const secondReady = await second.ready;
    const c2 = await TestRpcClient.connect(
      `ws://127.0.0.1:${secondReady.port}/rpc?token=${TOKEN}`,
    );
    const { agents } = await c2.call("agent.list");
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      id: agent.id,
      status: "dormant",
      resumable: true,
      lastSeq: firstLastSeq,
      preview: "第一轮 持久化",
    });

    const history = await c2.call("agent.timeline", { agentId: agent.id });
    expect(history.entries).toEqual(firstEntries);
    expect(history.epoch).not.toBe(firstEntries[0]!.epoch);

    await c2.call("agent.send", { agentId: agent.id, prompt: "第二轮" });
    await expect(c2.waitForTurnEnd(agent.id)).resolves.toMatchObject({ type: "turn_completed" });
    const newSeqs = c2.streams.filter((s) => s.agentId === agent.id).map((s) => s.seq);
    expect(newSeqs[0]).toBe(firstLastSeq + 1);
    expect(newSeqs).toEqual(Array.from({ length: newSeqs.length }, (_, i) => firstLastSeq + 1 + i));
    const statuses = c2.states.filter((s) => s.id === agent.id).map((s) => s.status);
    expect(statuses.slice(0, 3)).toEqual(["starting", "idle", "running"]);
    const replyText = c2
      .eventsFor(agent.id)
      .map((e) => (e.type === "timeline" && e.item.type === "assistant_message" ? e.item.text : ""))
      .join("");
    expect(replyText).toBe("Mock 回复：第二轮");

    second.child.stdin!.end();
    await withTimeout(second.exited, 5_000, "第二次关闭 stdin 后未退出");
    await c2.close();
  });

  test("翻译（design.md 4.35）：配置 endpoint → 会话开启翻译 → Agent 收到译文、时间线保留原文 → 回复翻译经磁盘缓存跨重启复用", async () => {
    // 假的 OpenAI 兼容接口：把 <translate-input> 里的原文加 "EN:" 前缀
    let llmCalls = 0;
    const llm: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += String(chunk)));
      req.on("end", () => {
        llmCalls += 1;
        const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
        const user = parsed.messages.find((m) => m.role === "user")!.content;
        const source = /<translate-input>\n([\s\S]*)\n<\/translate-input>/.exec(user)![1]!;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: `EN:${source}` } }] }));
      });
    });
    await new Promise<void>((resolve) => llm.listen(0, "127.0.0.1", resolve));
    const llmPort = (llm.address() as AddressInfo).port;
    const dataDir = mkdtempSync(path.join(tmpdir(), "agentdeck-sidecar-translation-"));
    tempDirs.push(dataDir);
    try {
      const first = startSidecar({ AGENTDECK_TOKEN: TOKEN, AGENTDECK_DATA_DIR: dataDir });
      const ready = await first.ready;
      const client = await TestRpcClient.connect(`ws://127.0.0.1:${ready.port}/rpc?token=${TOKEN}`);
      await client.call("translation.endpoint.set", {
        patch: { baseUrl: `http://127.0.0.1:${llmPort}/v1`, model: "fake" },
      });
      const { agent } = await client.call("agent.create", { provider: "mock", cwd: PACKAGE_DIR });
      await client.call("agent.update", { agentId: agent.id, translation: true });
      await client.call("agent.send", { agentId: agent.id, prompt: "端到端" });
      await client.waitForTurnEnd(agent.id);
      const events = client.eventsFor(agent.id);
      const user = events.find((e) => e.type === "timeline" && e.item.type === "user_message");
      expect(user).toMatchObject({ item: { text: "端到端", translatedText: "EN:端到端" } });
      const reply = events
        .map((e) => (e.type === "timeline" && e.item.type === "assistant_message" ? e.item.text : ""))
        .join("");
      expect(reply).toBe("Mock 回复：EN:端到端");
      expect(await client.call("translation.translate", { direction: "agent-to-user", text: reply })).toEqual({
        text: `EN:${reply}`,
      });
      expect(llmCalls).toBe(2);
      first.child.stdin!.end();
      await withTimeout(first.exited, 5_000, "关闭 stdin 后 5 秒内未退出");
      await client.close();

      // 同目录重启：endpoint 配置还在，回复翻译命中磁盘缓存
      const second = startSidecar({ AGENTDECK_TOKEN: TOKEN, AGENTDECK_DATA_DIR: dataDir });
      const ready2 = await second.ready;
      const client2 = await TestRpcClient.connect(`ws://127.0.0.1:${ready2.port}/rpc?token=${TOKEN}`);
      expect(await client2.call("translation.endpoint.get")).toMatchObject({ model: "fake" });
      expect(await client2.call("translation.translate", { direction: "agent-to-user", text: reply })).toEqual({
        text: `EN:${reply}`,
      });
      expect(llmCalls).toBe(2);
      second.child.stdin!.end();
      await withTimeout(second.exited, 5_000, "关闭 stdin 后 5 秒内未退出");
      await client2.close();
    } finally {
      await new Promise<void>((resolve) => llm.close(() => resolve()));
    }
  });

  test("缺少 AGENTDECK_TOKEN 时以退出码 2 退出", async () => {
    const sidecar = startSidecar({});
    sidecar.ready.catch(() => undefined);
    const exit = await withTimeout(sidecar.exited, 15_000, "未退出");
    expect(exit.code).toBe(2);
    expect(sidecar.getStdout()).toBe("");
    expect(sidecar.getStderr()).toContain("AGENTDECK_TOKEN");
  });

  test("父进程消失时自动退出", async () => {
    // 先起一个短命进程拿到一个随后会消失的 pid
    const parent = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    children.push(parent);
    const parentExited = new Promise((resolve) => parent.once("exit", resolve));
    const sidecar = startSidecar({
      AGENTDECK_TOKEN: TOKEN,
      AGENTDECK_PARENT_PID: String(parent.pid),
    });
    await sidecar.ready;
    await parentExited;
    const exit = await withTimeout(sidecar.exited, 8_000, "父进程退出后 sidecar 未退出");
    expect(exit.code).toBe(0);
    expect(sidecar.getStderr()).toContain("父进程");
  });
});
