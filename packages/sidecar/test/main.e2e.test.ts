import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  Object.assign(childEnv, env);
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
    expect(ready).toMatchObject({ type: "ready", version: "0.1.0", pid: sidecar.child.pid });
    expect(ready.port).toBeGreaterThan(0);

    const health = await fetch(`http://127.0.0.1:${ready.port}/health`);
    await expect(health.json()).resolves.toEqual({ ok: true, version: "0.1.0" });

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
