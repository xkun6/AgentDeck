// @vitest-environment node
//
// 集成测试：拉起真实的 Node sidecar（packages/sidecar/src/main.ts），用 sidecar-client +
// use-agent-session 的动作层跑一轮 mock 对话、一次审批与一次中断，验证 reduceAgentEvent
// 归约出的会话内容。web 包没有 @types/node，这里用动态 import + 本地最小接口。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStore } from "jotai";
import { SidecarClient } from "./sidecar-client";
import { bindSidecarToStore, createAgentSessionActions } from "@/hooks/use-agent-session";
import { chatRuntimeBySessionAtom, type ChatSessionRuntime } from "@/stores/chat";
import { agentSnapshotsAtom } from "@/stores/agents";

interface ReadableLike {
  on(event: "data", listener: (chunk: unknown) => void): void;
}
interface ChildLike {
  pid?: number;
  exitCode: number | null;
  stdout: ReadableLike;
  stderr: ReadableLike;
  stdin: { end(): void };
  kill(signal?: string): boolean;
  once(event: "exit", listener: (code: number | null) => void): void;
}
interface ChildProcessModule {
  spawn(
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string | undefined>; stdio: string[]; windowsHide: boolean },
  ): ChildLike;
}
interface ProcessLike {
  execPath: string;
  env: Record<string, string | undefined>;
}

const nodeProcess = (globalThis as unknown as { process: ProcessLike }).process;
const TOKEN = "integration-token";

let child: ChildLike | null = null;
let port = 0;
let stderrLog = "";
let client: SidecarClient;
const store = createStore();
let unbind: () => void = () => {};
const actions = () => createAgentSessionActions(client, store);
let workspace = "";

async function waitFor<T>(read: () => T | undefined | null | false, label: string, timeoutMs = 20_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`等待超时：${label}\nsidecar stderr：\n${stderrLog.slice(-2_000)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function runtimeOf(agentId: string): ChatSessionRuntime | undefined {
  return store.get(chatRuntimeBySessionAtom)[agentId];
}

function textOf(runtime: ChatSessionRuntime | undefined): string {
  return (runtime?.messages ?? [])
    .flatMap((message) => message.parts)
    .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
    .join("\n");
}

beforeAll(async () => {
  const childProcessName = "node:child_process";
  const urlModuleName = "node:url";
  const fsModuleName = "node:fs/promises";
  const { spawn } = (await import(/* @vite-ignore */ childProcessName)) as ChildProcessModule;
  const { fileURLToPath } = (await import(/* @vite-ignore */ urlModuleName)) as {
    fileURLToPath(url: URL): string;
  };
  const { mkdir } = (await import(/* @vite-ignore */ fsModuleName)) as {
    mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
  };

  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const sidecarDir = fileURLToPath(new URL("../../../packages/sidecar/", import.meta.url));
  const tmpRoot = fileURLToPath(new URL("../../../tmp/web-sidecar-it/", import.meta.url));
  workspace = fileURLToPath(new URL("../../../tmp/web-sidecar-it/workspace/", import.meta.url));
  await mkdir(workspace, { recursive: true });
  expect(repoRoot).toBeTruthy();

  const spawned = spawn(nodeProcess.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: sidecarDir,
    env: {
      ...nodeProcess.env,
      AGENTDECK_TOKEN: TOKEN,
      AGENTDECK_PORT: "0",
      AGENTDECK_DATA_DIR: `${tmpRoot}data`,
      AGENTDECK_LOG_DIR: `${tmpRoot}logs`,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child = spawned;
  spawned.stderr.on("data", (chunk) => {
    stderrLog += String(chunk);
  });

  let stdout = "";
  const ready = await new Promise<{ type: string; port: number; version: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`sidecar 启动超时\n${stderrLog}`)), 30_000);
    spawned.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`sidecar 提前退出（${code}）\n${stderrLog}`));
    });
    spawned.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const newline = stdout.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(stdout.slice(0, newline)));
      } catch (error) {
        reject(error);
      }
    });
  });
  expect(ready.type).toBe("ready");
  port = ready.port;

  client = new SidecarClient({
    resolveUrl: async () => `ws://127.0.0.1:${port}/rpc?token=${TOKEN}`,
    wakeListeners: false,
    requestTimeoutMs: 20_000,
  });
  unbind = bindSidecarToStore(client, store);
  await client.connect();
}, 60_000);

afterAll(async () => {
  unbind();
  client?.close();
  const running = child;
  child = null;
  if (!running || running.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      running.kill();
      resolve();
    }, 5_000);
    running.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    running.stdin.end(); // 契约：stdin 关闭即优雅退出
  });
}, 15_000);

describe("sidecar 集成（mock provider）", () => {
  it("provider.list → agent.create → sendPrompt，归约出回复文本与一个 shell 工具", async () => {
    const providers = await actions().listProviders();
    const mock = providers.find((provider) => provider.id === "mock");
    expect(mock?.available).toBe(true);

    const agent = await actions().createSession({ provider: "mock", cwd: workspace, model: "mock-fast" });
    expect(agent.provider).toBe("mock");
    expect(store.get(agentSnapshotsAtom)[agent.id]).toBeTruthy();

    const { clientMessageId } = await actions().sendPrompt(agent.id, "你好 AgentDeck");
    const done = await waitFor(() => {
      const runtime = runtimeOf(agent.id);
      return runtime?.streamStatus === "complete" ? runtime : undefined;
    }, "第一轮完成");

    const users = done.messages.filter((message) => message.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0]!.id).toBe(clientMessageId);
    const assistants = done.messages.filter((message) => message.role === "assistant");
    expect(assistants).toHaveLength(1);
    const parts = assistants[0]!.parts;
    const text = parts.filter((part) => part.type === "text").map((part) => part.text).join("");
    expect(text).toContain("Mock 回复：你好 AgentDeck");
    const tools = parts.filter((part) => part.type === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "shell", state: "done", input: "echo 你好 AgentDeck" });
    expect(parts.some((part) => part.type === "reasoning")).toBe(true);
    expect(done.agentUsage?.outputTokens).toBeGreaterThan(0);

    // 历史：用一个全新的 store 通过 agent.timeline 回放，得到相同的会话内容
    const replayStore = createStore();
    const replayClient = new SidecarClient({
      resolveUrl: async () => `ws://127.0.0.1:${port}/rpc?token=${TOKEN}`,
      wakeListeners: false,
    });
    const unbindReplay = bindSidecarToStore(replayClient, replayStore);
    try {
      await createAgentSessionActions(replayClient, replayStore).loadTimeline(agent.id);
      const replayed = replayStore.get(chatRuntimeBySessionAtom)[agent.id];
      expect(textOf(replayed)).toContain("Mock 回复：你好 AgentDeck");
      expect(replayed?.messages.filter((message) => message.role === "user")).toHaveLength(1);
      expect(replayed?.streamStatus).toBe("complete");
    } finally {
      unbindReplay();
      replayClient.close();
    }
  }, 60_000);

  it("/approve 触发审批，允许后继续执行；mock-slow 下中断本轮；最后关闭会话", async () => {
    const agent = await actions().createSession({ provider: "mock", cwd: workspace });
    await actions().sendPrompt(agent.id, "/approve 部署");

    const pending = await waitFor(() => runtimeOf(agent.id)?.pendingApprovals[0], "审批请求");
    expect(pending.permission?.actions?.map((action) => action.id)).toEqual(["allow", "deny"]);
    expect(pending.command).toContain("echo /approve");

    await actions().respondPermission(agent.id, pending.requestId, { behavior: "allow", selectedActionId: "allow" });
    const approved = await waitFor(() => {
      const runtime = runtimeOf(agent.id);
      return runtime?.streamStatus === "complete" ? runtime : undefined;
    }, "审批后完成");
    expect(approved.pendingApprovals).toHaveLength(0);
    expect(textOf(approved)).toContain("Mock 回复：/approve 部署");

    await actions().setModel(agent.id, "mock-slow");
    await actions().sendPrompt(agent.id, "慢慢来");
    await waitFor(() => runtimeOf(agent.id)?.activeTurnId, "第二轮开始");
    await actions().interrupt(agent.id);
    const canceled = await waitFor(() => {
      const runtime = runtimeOf(agent.id);
      return runtime?.streamStatus === "idle" && textOf(runtime).includes("已中断本轮") ? runtime : undefined;
    }, "中断完成");
    expect(textOf(canceled)).not.toContain("Mock 回复：慢慢来");

    await actions().closeSession(agent.id);
    await waitFor(() => store.get(agentSnapshotsAtom)[agent.id]?.status === "closed", "会话关闭");
  }, 60_000);
});
