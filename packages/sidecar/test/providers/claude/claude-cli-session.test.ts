// ClaudeCliSession 与假 claude 脚本（fixtures/fake-claude.mjs）之间走真实的子进程 + stream-json stdio。
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentStreamEvent } from "@agentdeck/protocol";

import type { ProviderSubagentInputEvent } from "../../../src/agent/types.js";
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
    const init = (await session.initialized) as {
      models?: unknown[];
      argv?: string[];
      forwardSubagentText?: unknown;
    };
    expect(init.models).toHaveLength(2);
    // initialize 打开子代理文本转发（design.md 4.11）
    expect(init.forwardSubagentText).toBe(true);
    // 声明逐个停止后台任务（design.md 4.15）
    expect((init as { perTaskStopAffordance?: unknown }).perTaskStopAffordance).toBe(true);
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

  test("stop_task 控制请求：带 task_id，未知任务时 reject", async () => {
    const session = start();
    await session.initialized;
    await expect(session.stopTask("bk1")).resolves.toBeUndefined();
    await expect(session.stopTask("nope")).rejects.toThrow(/stop_task.*No task found with ID: nope/);
  });

  test("mcp_status / mcp_reconnect 控制请求：应答原样返回，重连带 serverName，失败时 reject", async () => {
    const session = start();
    await session.initialized;
    await expect(session.mcpStatus()).resolves.toEqual({
      mcpServers: [{ name: "fs", status: "connected", scope: "user", tools: [{ name: "read" }] }],
    });
    await expect(session.mcpReconnect("fs")).resolves.toBeUndefined();
    await expect(session.mcpReconnect("nope")).rejects.toThrow(/mcp_reconnect.*Server not found: nope/);
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
      if (event.type === "provider_subagent" || event.type === "provider_background_tasks") return;
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

  test("子代理：task 公告与 sidechain 帧写入子代理时间线，父卡片为 sub_agent 并带 log，被过滤的 local_bash 不出现", async () => {
    const session = await createClient().createSession({ cwd });
    const events: AgentStreamEvent[] = [];
    const subagentEvents: ProviderSubagentInputEvent[] = [];
    session.subscribe((event) => {
      if (event.type === "provider_subagent") subagentEvents.push(event.event);
      else if (event.type !== "provider_background_tasks") events.push(event);
    });
    try {
      await session.startTurn("subagent");
      await waitTerminal(events, 1);
      expect(events.at(-1)?.type).toBe("turn_completed");

      // 主时间线只有父会话自己的文本
      const mainText = events
        .flatMap((e) => (e.type === "timeline" && e.item.type === "assistant_message" ? [e.item.text] : []))
        .join("");
      expect(mainText).toBe("子代理回报 name 是 demo");

      // 被过滤的 local_bash 任务及其帧不进入子代理 store
      expect(subagentEvents.every((e) => e.id === "toolu_task")).toBe(true);
      expect(subagentEvents[0]).toMatchObject({
        type: "upsert",
        id: "toolu_task",
        status: "running",
        title: "Explore",
        description: "读 package.json",
        toolCallId: "toolu_task",
      });
      const subtitles = subagentEvents.flatMap((e) => (e.type === "upsert" && e.subtitle ? [e.subtitle] : []));
      expect(subtitles.at(-1)).toBe("Explore · Haiku 4.5 · 2k tokens");
      const statuses = subagentEvents.flatMap((e) => (e.type === "upsert" && e.status ? [e.status] : []));
      expect(statuses.at(-1)).toBe("completed");

      const timeline = subagentEvents.flatMap((e) => (e.type === "timeline" ? [e.item] : []));
      expect(timeline[0]).toEqual({ type: "user_message", text: "读取 name" });
      expect(
        timeline.map((item) => (item.type === "tool_call" ? `tool:${item.name}:${item.status}` : item.type)),
      ).toEqual(["user_message", "tool:Read:running", "tool:Read:completed", "assistant_message"]);
      expect(timeline.at(-1)).toMatchObject({ type: "assistant_message", text: "name 是 demo" });

      // 父卡片：同一 callId，sub_agent，log 记录了子代理动作，最终 completed
      const cards = events.flatMap((e) =>
        e.type === "timeline" && e.item.type === "tool_call" && e.item.callId === "toolu_task" ? [e.item] : [],
      );
      const last = cards.at(-1);
      expect(last).toMatchObject({ status: "completed", detail: { type: "sub_agent", subAgentType: "Explore" } });
      expect(last?.detail.type === "sub_agent" ? last.detail.log : "").toContain("[Read] package.json");
    } finally {
      await session.close();
    }
  });

  /** 事件的简写：turn_* 带来源，timeline 带类型与 turnId 归属 */
  function describeEvents(events: AgentStreamEvent[], turnIds: string[]): string[] {
    const label = (turnId: string | undefined) => (turnId ? `T${turnIds.indexOf(turnId) + 1}` : "-");
    return events.flatMap((e) => {
      switch (e.type) {
        case "turn_started":
          if (!turnIds.includes(e.turnId)) turnIds.push(e.turnId);
          return [`turn_started:${label(e.turnId)}${e.origin ? `:${e.origin}` : ""}`];
        case "turn_completed":
        case "turn_failed":
        case "turn_canceled":
          return [`${e.type}:${label(e.turnId)}`];
        case "timeline":
          return [
            `timeline:${e.item.type === "tool_call" ? `tool:${e.item.name}:${e.item.status}` : e.item.type}:${label(e.turnId)}`,
          ];
        default:
          return [];
      }
    });
  }

  test("CLI 自发轮次：后台子代理完成后 CLI 自行开一轮 → turn_started(background) → 时间线 → turn_completed", async () => {
    const session = await createClient().createSession({ cwd });
    const events: AgentStreamEvent[] = [];
    const subagentEvents: ProviderSubagentInputEvent[] = [];
    session.subscribe((event) => {
      if (event.type === "provider_subagent") subagentEvents.push(event.event);
      else if (event.type !== "provider_background_tasks") events.push(event);
    });
    try {
      const { turnId } = await session.startTurn("background");
      await waitTerminal(events, 2);
      // 之后的空轮（init + 空 result）不显示成回合
      await new Promise((resolve) => setTimeout(resolve, 100));
      const turnIds = [turnId];
      const sequence = describeEvents(events, turnIds);
      expect(sequence.slice(0, 1)).toEqual(["turn_started:T1"]);
      // 第一轮正常结束；之后 CLI 自发的一轮：后台命令的完成提示 + 文本，最后 turn_completed
      expect(sequence.slice(sequence.indexOf("turn_completed:T1"))).toEqual([
        "turn_completed:T1",
        "turn_started:T2:background",
        "timeline:tool:task_notification:completed:T2",
        "timeline:assistant_message:T2",
        "timeline:assistant_message:T2",
        "turn_completed:T2",
      ]);
      const bgText = events
        .slice(events.findIndex((e) => e.type === "turn_started" && e.origin === "background"))
        .flatMap((e) => (e.type === "timeline" && e.item.type === "assistant_message" ? [e.item.text] : []))
        .join("");
      expect(bgText).toBe("子代理回报：name 是 demo");
      const notice = events.find(
        (e) => e.type === "timeline" && e.item.type === "tool_call" && e.item.name === "task_notification",
      );
      expect(notice).toMatchObject({
        item: {
          callId: "task_notification_task_bg_bash",
          detail: {
            type: "plain_text",
            label: 'Background command "sleep 1" completed (exit code 0)',
            text: "输出文件：C:\\tmp\\task_bg_bash.output",
          },
        },
      });
      // 后台子代理以 task_notification 收尾，不另出提示卡片
      const statuses = subagentEvents.flatMap((e) => (e.type === "upsert" && e.status ? [e.status] : []));
      expect(statuses.at(-1)).toBe("completed");
      expect(events.filter((e) => e.type === "turn_started")).toHaveLength(2);
    } finally {
      await session.close();
    }
  });

  test("CLI 自发轮次进行中用户发送：先结束自发轮次再开新回合，消息由 CLI 排队，事件不丢、不重复", async () => {
    const session = await createClient().createSession({ cwd });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => {
      if (event.type !== "provider_subagent" && event.type !== "provider_background_tasks") events.push(event);
    });
    try {
      const { turnId } = await session.startTurn("background-race");
      // 等自发轮次开始并已有输出
      await waitUntil(() =>
        events.some((e) => e.type === "timeline" && e.item.type === "assistant_message" && e.item.text === "子代理回报："),
      );
      const second = await session.startTurn("hello");
      await waitTerminal(events, 3);
      // 被接管的自发轮次的 result 被跳过，新回合以自己的 result 结束
      await new Promise((resolve) => setTimeout(resolve, 100));
      const turnIds = [turnId];
      const sequence = describeEvents(events, turnIds);
      expect(turnIds[2]).toBe(second.turnId);
      expect(sequence.slice(sequence.indexOf("turn_completed:T1"))).toEqual([
        "turn_completed:T1",
        "turn_started:T2:background",
        "timeline:tool:task_notification:completed:T2",
        "timeline:assistant_message:T2",
        "turn_completed:T2",
        "turn_started:T3",
        // 自发轮次剩余的输出并入新回合（不丢；已流式输出过的完整消息不重复）
        "timeline:assistant_message:T3",
        // 排队的用户消息：Hello 分两段增量
        "timeline:assistant_message:T3",
        "timeline:assistant_message:T3",
        "turn_completed:T3",
      ]);
      const t3Text = events
        .flatMap((e) =>
          e.type === "timeline" && e.turnId === second.turnId && e.item.type === "assistant_message" ? [e.item.text] : [],
        )
        .join("");
      expect(t3Text).toBe("name 是 demoHello");
      expect(events.filter((e) => e.type === "turn_started")).toHaveLength(3);
    } finally {
      await session.close();
    }
  });
});
