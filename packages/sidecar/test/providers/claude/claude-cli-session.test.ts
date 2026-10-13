// ClaudeCliSession 与假 claude 脚本（fixtures/fake-claude.mjs）之间走真实的子进程 + stream-json stdio。
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentStreamEvent } from "@agentdeck/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createSilentLogger } from "../../../src/logger.js";
import {
  ClaudeAgentClient,
  ClaudeCliSession,
  buildClaudeCliArgs,
  type ClaudeCliOptions,
} from "../../../src/providers/claude/index.js";
import { buildClaudeChildEnv } from "../../../src/providers/claude/claude-agent.js";
import type {
  ClaudeCanUseTool,
  ClaudeOutputMessage,
  ClaudeResultMessage,
} from "../../../src/providers/claude/stream-json-types.js";

const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude.mjs");
const FAKE_SESSION_ID = "fake-session-0001";

let cwd: string;
const sessions: ClaudeCliSession[] = [];

beforeEach(() => {
  cwd = mkdtempSync(path.join(os.tmpdir(), "agentdeck-claude-cli-"));
});

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  rmSync(cwd, { recursive: true, force: true });
});

const denyAll: ClaudeCanUseTool = async () => ({ behavior: "deny", message: "no" });

function start(overrides: Partial<ClaudeCliOptions> = {}): ClaudeCliSession {
  const session = new ClaudeCliSession({
    executablePath: FAKE_CLAUDE,
    cwd,
    env: buildClaudeChildEnv(process.env),
    model: null,
    permissionMode: "default",
    resumeSessionId: null,
    canUseTool: denyAll,
    logger: createSilentLogger(),
    ...overrides,
  });
  sessions.push(session);
  return session;
}

function userMessage(text: string, uuid = `u-${text}`) {
  return {
    type: "user" as const,
    message: { role: "user" as const, content: [{ type: "text" as const, text }] },
    parent_tool_use_id: null,
    session_id: "",
    uuid,
  };
}

/** 读消息直到出现 result，返回本轮全部消息 */
async function readTurn(iterator: AsyncIterator<ClaudeOutputMessage, void>): Promise<ClaudeOutputMessage[]> {
  const messages: ClaudeOutputMessage[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) throw new Error("消息流提前结束");
    messages.push(next.value);
    if (next.value.type === "result") return messages;
  }
}

function assistantText(messages: ClaudeOutputMessage[]): string {
  return messages
    .flatMap((m) => (m.type === "assistant" ? (m.message.content ?? []) : []))
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil 超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("buildClaudeCliArgs：思考强度", () => {
  test("档位 → --effort；off → --thinking disabled；null 不传", () => {
    const base = { model: null, permissionMode: null, resumeSessionId: null } as const;
    const low = buildClaudeCliArgs({ ...base, thinkingOptionId: "low" });
    expect(low.join(" ")).toContain("--effort low");
    expect(low).not.toContain("--thinking");
    const off = buildClaudeCliArgs({ ...base, thinkingOptionId: "off" });
    expect(off.join(" ")).toContain("--thinking disabled");
    expect(off).not.toContain("--effort");
    for (const args of [buildClaudeCliArgs(base), buildClaudeCliArgs({ ...base, thinkingOptionId: null })]) {
      expect(args).not.toContain("--effort");
      expect(args).not.toContain("--thinking");
    }
    // 位于 --resume 与 extraArgs 之前
    const full = buildClaudeCliArgs({
      ...base,
      thinkingOptionId: "max",
      resumeSessionId: "s-1",
      extraArgs: ["--settings", "{}"],
    });
    expect(full.slice(-6)).toEqual(["--effort", "max", "--resume", "s-1", "--settings", "{}"]);
  });
});

describe("buildClaudeCliArgs", () => {
  test("固定参数 + 可选 model / resume", () => {
    const base = buildClaudeCliArgs({ model: null, permissionMode: "default", resumeSessionId: null });
    expect(base).toEqual([
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--include-partial-messages",
      "--permission-prompt-tool",
      "stdio",
      "--setting-sources",
      "user,project,local",
      "--permission-mode",
      "default",
      "--allow-dangerously-skip-permissions",
    ]);
    const full = buildClaudeCliArgs({ model: "haiku", permissionMode: "plan", resumeSessionId: "s-1" });
    expect(full.slice(-4)).toEqual(["--model", "haiku", "--resume", "s-1"]);
    expect(full).toContain("plan");
  });

  test("permissionMode 为 null 时不传 --permission-mode，仍保留 --allow-dangerously-skip-permissions", () => {
    const args = buildClaudeCliArgs({ model: null, permissionMode: null, resumeSessionId: null });
    expect(args).not.toContain("--permission-mode");
    expect(args.at(-1)).toBe("--allow-dangerously-skip-permissions");
    expect(buildClaudeCliArgs({ model: null, permissionMode: "auto", resumeSessionId: null })).toContain("auto");
  });
});

describe("ClaudeCliSession（假 claude 脚本）", () => {
  test("initialize 自动发送；正常一轮：system / stream_event / assistant / result", async () => {
    const session = start();
    const init = (await session.initialized) as { models?: unknown[]; argv?: string[] };
    expect(init.models).toHaveLength(2);
    expect(init.argv).toEqual(buildClaudeCliArgs({ model: null, permissionMode: "default", resumeSessionId: null }));

    const iterator = session[Symbol.asyncIterator]();
    session.sendUserMessage(userMessage("hello", "uuid-1"));
    const messages = await readTurn(iterator);
    expect(messages.map((m) => m.type)).toEqual([
      "system",
      "stream_event",
      "stream_event",
      "stream_event",
      "assistant",
      "result",
    ]);
    expect(messages[0]).toMatchObject({ type: "system", subtype: "init", session_id: FAKE_SESSION_ID });
    const result = messages.at(-1) as ClaudeResultMessage;
    expect(result).toMatchObject({ subtype: "success", is_error: false, user_message_uuid: "uuid-1", total_cost_usd: 0.001 });

    // 非 JSON 行被跳过，不影响后续消息
    session.sendUserMessage(userMessage("noisy", "uuid-2"));
    const second = await readTurn(iterator);
    expect(assistantText(second)).toBe("Hello");
  });

  test("resume / model / 权限模式拼接进命令行", async () => {
    const session = start({ model: "haiku", permissionMode: "plan", resumeSessionId: FAKE_SESSION_ID });
    const init = (await session.initialized) as { argv?: string[] };
    const argv = init.argv ?? [];
    expect(argv.slice(argv.indexOf("--resume"), argv.indexOf("--resume") + 2)).toEqual(["--resume", FAKE_SESSION_ID]);
    expect(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2)).toEqual(["--model", "haiku"]);
    expect(argv.slice(argv.indexOf("--permission-mode"), argv.indexOf("--permission-mode") + 2)).toEqual([
      "--permission-mode",
      "plan",
    ]);
  });

  test("权限 allow：回调拿到工具名 / 输入 / toolUseId，应答回传 updatedInput", async () => {
    const calls: unknown[] = [];
    const session = start({
      canUseTool: async (toolName, input, ctx) => {
        calls.push({ toolName, input, toolUseId: ctx.toolUseId, title: ctx.title });
        return { behavior: "allow", updatedInput: { ...input, file_path: "b.txt" } };
      },
    });
    const iterator = session[Symbol.asyncIterator]();
    session.sendUserMessage(userMessage("perm:Write"));
    const messages = await readTurn(iterator);
    expect(calls).toEqual([
      {
        toolName: "Write",
        input: { file_path: "a.txt", content: "x" },
        toolUseId: "toolu_1",
        title: "Claude wants to use Write",
      },
    ]);
    const decision = JSON.parse(assistantText(messages).replace(/^decision:/, ""));
    expect(decision).toMatchObject({
      subtype: "success",
      response: {
        behavior: "allow",
        updatedInput: { file_path: "b.txt", content: "x" },
        toolUseID: "toolu_1",
      },
    });
  });

  test("权限 deny：应答带 message", async () => {
    const session = start({
      canUseTool: async () => ({ behavior: "deny", message: "用户拒绝了该操作" }),
    });
    const iterator = session[Symbol.asyncIterator]();
    session.sendUserMessage(userMessage("perm:Bash"));
    const decision = JSON.parse(assistantText(await readTurn(iterator)).replace(/^decision:/, ""));
    expect(decision.response).toMatchObject({ behavior: "deny", message: "用户拒绝了该操作" });
  });

  test("control_cancel_request 触发 canUseTool 的 AbortSignal", async () => {
    let aborted = false;
    const session = start({
      canUseTool: (_tool, _input, ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ behavior: "deny", message: "已取消" });
          });
        }),
    });
    const iterator = session[Symbol.asyncIterator]();
    session.sendUserMessage(userMessage("cancel-perm"));
    const decision = JSON.parse(assistantText(await readTurn(iterator)).replace(/^decision:/, ""));
    expect(aborted).toBe(true);
    expect(decision.response).toMatchObject({ behavior: "deny", message: "已取消" });
  });

  test("interrupt：控制请求得到应答，本轮以 error_during_execution 结束；setModel / setPermissionMode 可用", async () => {
    const session = start();
    const iterator = session[Symbol.asyncIterator]();
    session.sendUserMessage(userMessage("hang", "uuid-hang"));
    expect((await iterator.next()).value).toMatchObject({ type: "system", subtype: "init" });
    await session.interrupt();
    const result = (await iterator.next()).value as ClaudeResultMessage;
    expect(result).toMatchObject({ type: "result", subtype: "error_during_execution", user_message_uuid: "uuid-hang" });

    await expect(session.setModel("haiku")).resolves.toBeUndefined();
    await expect(session.setModel(null)).resolves.toBeUndefined();
    await expect(session.setPermissionMode("acceptEdits")).resolves.toBeUndefined();
  });

  test("子进程意外退出：消息流以错误结束（含退出码与 stderr），后续写入与控制请求失败", async () => {
    const stderr: string[] = [];
    const session = start({ onStderr: (text) => stderr.push(text) });
    await session.initialized;
    const iterator = session[Symbol.asyncIterator]();
    session.sendUserMessage(userMessage("crash"));
    await expect(iterator.next()).rejects.toThrow(/code=3.*fatal: boom/);
    expect(stderr.join("")).toContain("fatal: boom");
    expect(() => session.sendUserMessage(userMessage("hello"))).toThrow("已退出");
    await expect(session.interrupt()).rejects.toThrow();
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  test("控制请求超时", async () => {
    const session = start({
      env: { ...buildClaudeChildEnv(process.env), FAKE_CLAUDE_SILENT: "1" },
      controlTimeoutMs: 200,
    });
    await expect(session.initialized).rejects.toThrow("控制请求超时：initialize");
  });

  test("close：结束 stdin 并 tree-kill，消息流正常结束，进程不残留", async () => {
    const session = start();
    await session.initialized;
    const pid = session.pid!;
    expect(isAlive(pid)).toBe(true);
    const iterator = session[Symbol.asyncIterator]();
    const pending = iterator.next();
    await session.close();
    await expect(pending).resolves.toEqual({ value: undefined, done: true });
    await waitUntil(() => !isAlive(pid));
    await session.close(); // 幂等
  });
});

describe("ClaudeAgentClient + 假 claude 脚本（端到端）", () => {
  function createClient(): ClaudeAgentClient {
    return new ClaudeAgentClient({
      logger: createSilentLogger(),
      env: process.env,
      // 不读本机用户的 Claude 设置，保证模型列表与机器无关
      loadSettings: async () => null,
      resolveExecutable: async () => ({
        available: true,
        path: FAKE_CLAUDE,
        source: "env",
        version: "fake",
      }),
    });
  }

  async function waitTerminal(events: AgentStreamEvent[], count: number): Promise<void> {
    await waitUntil(
      () =>
        events.filter((e) => e.type === "turn_completed" || e.type === "turn_failed" || e.type === "turn_canceled")
          .length >= count,
    );
  }

  test("权限 allow 时 updatedInput 回传给 CLI；进程崩溃转为 turn_failed，下一轮以 --resume 重启", async () => {
    const client = createClient();
    const catalog = await client.fetchCatalog({ cwd });
    expect(catalog.models.map((m) => m.id)).toEqual(["default", "haiku"]);

    const session = await client.createSession({ cwd });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
      if (event.type === "permission_requested") {
        void session.respondToPermission(event.request.id, {
          behavior: "allow",
          updatedInput: { file_path: "c.txt", content: "y" },
        });
      }
    });
    try {
      await session.startTurn("perm:Write");
      await waitTerminal(events, 1);
      expect(events.at(-1)?.type).toBe("turn_completed");
      expect(events.find((e) => e.type === "thread_started")).toEqual({
        type: "thread_started",
        sessionId: FAKE_SESSION_ID,
      });
      const text = events
        .flatMap((e) => (e.type === "timeline" && e.item.type === "assistant_message" ? [e.item.text] : []))
        .join("");
      expect(JSON.parse(text.replace(/^decision:/, "")).response).toMatchObject({
        behavior: "allow",
        updatedInput: { file_path: "c.txt", content: "y" },
      });
      expect(events.find((e) => e.type === "usage_updated")).toMatchObject({
        usage: { inputTokens: 10, cachedInputTokens: 7, outputTokens: 2, totalCostUsd: 0.001 },
      });

      await session.startTurn("crash");
      await waitTerminal(events, 2);
      expect(events.at(-1)).toMatchObject({ type: "turn_failed" });
      expect((events.at(-1) as { error: string }).error).toContain("code=3");

      await session.startTurn("hello");
      await waitTerminal(events, 3);
      expect(events.at(-1)?.type).toBe("turn_completed");
      expect(session.describePersistence()).toEqual({ provider: "claude", sessionId: FAKE_SESSION_ID });
    } finally {
      await session.close();
    }
  });
});
