// 会话互通 MCP 端点的注入（design.md 4.26）：Claude --mcp-config、Codex config.mcp_servers、ACP mcpServers
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { AgentSession, InteropEndpoint } from "../../src/agent/types.js";
import { createLogger, createSilentLogger } from "../../src/logger.js";
import {
  ClaudeAgentClient,
  type ClaudeCliFactory,
  type ClaudeCliHandle,
  type ClaudeCliOptions,
} from "../../src/providers/claude/index.js";
import { buildClaudeCliArgs } from "../../src/providers/claude/claude-cli-session.js";
import { CodexAgentClient } from "../../src/providers/codex/index.js";
import type { CodexLaunch } from "../../src/providers/codex/launch.js";
import { claudeInteropArgs, codexInteropConfig } from "../../src/providers/shared/interop.js";
import { fakeClient, waitUntil } from "./acp/helpers.js";

const TOKEN = `adi_${"ab12cd34".repeat(6)}`;
const ENDPOINT: InteropEndpoint = { url: "http://127.0.0.1:45678/mcp", token: TOKEN };
const EXPECTED_BEARER = `Bearer ${TOKEN}`;
/** Computer Use 代理端点（design.md 4.37） */
const CU_ENDPOINT: InteropEndpoint = { url: "http://127.0.0.1:45678/mcp/cua", token: TOKEN };
const EXPECTED_CLAUDE_CU = { type: "http", url: CU_ENDPOINT.url, headers: { Authorization: EXPECTED_BEARER } };

let tmpDir: string;
const sessions: AgentSession[] = [];

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "agentdeck-interop-inject-"));
});

afterEach(async () => {
  await Promise.allSettled(sessions.splice(0).map((session) => session.close()));
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("Claude：--mcp-config", () => {
  function stubCli(): ClaudeCliHandle {
    return {
      initialized: new Promise(() => undefined),
      sendUserMessage: () => undefined,
      interrupt: async () => undefined,
      setModel: async () => undefined,
      setPermissionMode: async () => undefined,
      mcpStatus: async () => ({}),
      mcpReconnect: async () => undefined,
      stopTask: async () => undefined,
      getContextUsage: async () => ({}),
      close: async () => undefined,
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
    };
  }

  function makeClient(
    seen: ClaudeCliOptions[],
    logger = createSilentLogger(),
    extraArgs?: string[],
  ): ClaudeAgentClient {
    const cliFactory: ClaudeCliFactory = (options) => {
      seen.push(options);
      return stubCli();
    };
    return new ClaudeAgentClient({
      logger,
      env: {},
      loadSettings: async () => null,
      cliFactory,
      terminateProcess: async () => "terminated",
      resolveExecutable: async () => ({
        available: true,
        path: "C:\\fake\\claude.exe",
        source: "path",
        version: "2.1.296 (Claude Code)",
      }),
      ...(extraArgs ? { launch: { extraArgs } } : {}),
    });
  }

  function mcpConfigOf(args: string[]): unknown {
    const index = args.indexOf("--mcp-config");
    expect(index).toBeGreaterThanOrEqual(0);
    return JSON.parse(args[index + 1]!);
  }

  const EXPECTED_CONFIG = {
    mcpServers: {
      agentdeck: { type: "http", url: ENDPOINT.url, headers: { Authorization: EXPECTED_BEARER } },
    },
  };

  test("claudeInteropArgs：内联 JSON，type http + Authorization 头", () => {
    expect(JSON.parse(claudeInteropArgs(ENDPOINT)[1]!)).toEqual(EXPECTED_CONFIG);
  });

  test("createSession / resumeSession / forkSession 的启动参数都带 --mcp-config", async () => {
    const seen: ClaudeCliOptions[] = [];
    const client = makeClient(seen);

    const created = await client.createSession({ cwd: tmpDir, interop: ENDPOINT });
    sessions.push(created);
    await created.startTurn("hi");

    const resumed = await client.resumeSession(
      { provider: "claude", sessionId: "sess-1" },
      { cwd: tmpDir, interop: ENDPOINT },
    );
    sessions.push(resumed);
    await resumed.startTurn("hi");

    const forked = await client.forkSession!(
      { provider: "claude", sessionId: "sess-1" },
      { cwd: tmpDir, interop: ENDPOINT },
    );
    sessions.push(forked);
    await forked.startTurn("hi");

    expect(seen).toHaveLength(3);
    for (const options of seen) {
      expect(mcpConfigOf(buildClaudeCliArgs(options))).toEqual(EXPECTED_CONFIG);
    }
    expect(seen[1]!.resumeSessionId).toBe("sess-1");
    expect(seen[2]!.forkSession).toBe(true);
  });

  test("自定义中转的 extraArgs（--settings）与 --mcp-config 并存；没有 interop 时不注入", async () => {
    const seen: ClaudeCliOptions[] = [];
    const client = makeClient(seen, createSilentLogger(), ["--settings", "{}"]);
    const withInterop = await client.createSession({ cwd: tmpDir, interop: ENDPOINT });
    sessions.push(withInterop);
    await withInterop.startTurn("hi");
    const plain = await client.createSession({ cwd: tmpDir });
    sessions.push(plain);
    await plain.startTurn("hi");

    const first = buildClaudeCliArgs(seen[0]!);
    expect(first).toContain("--settings");
    expect(mcpConfigOf(first)).toEqual(EXPECTED_CONFIG);
    const second = buildClaudeCliArgs(seen[1]!);
    expect(second).toContain("--settings");
    expect(second).not.toContain("--mcp-config");
  });

  test("Computer Use：agentdeck_cua 与 agentdeck 合在同一份 --mcp-config；只开 Computer Use 时单独注入", async () => {
    expect(JSON.parse(claudeInteropArgs(ENDPOINT, CU_ENDPOINT)[1]!)).toEqual({
      mcpServers: { ...EXPECTED_CONFIG.mcpServers, agentdeck_cua: EXPECTED_CLAUDE_CU },
    });
    expect(claudeInteropArgs(undefined)).toEqual([]);

    const seen: ClaudeCliOptions[] = [];
    const client = makeClient(seen);
    const resumed = await client.resumeSession(
      { provider: "claude", sessionId: "sess-1" },
      { cwd: tmpDir, computerUse: CU_ENDPOINT },
    );
    sessions.push(resumed);
    await resumed.startTurn("hi");
    expect(mcpConfigOf(buildClaudeCliArgs(seen[0]!))).toEqual({ mcpServers: { agentdeck_cua: EXPECTED_CLAUDE_CU } });
  });

  test("cliApprovesMcpTools：default / acceptEdits / plan / auto 由 CLI 审批，bypassPermissions 与未知模式由 sidecar 审批", async () => {
    const client = makeClient([]);
    for (const [modeId, expected] of [
      ["default", true],
      ["acceptEdits", true],
      ["plan", true],
      ["auto", true],
      ["bypassPermissions", false],
    ] as const) {
      const session = await client.createSession({ cwd: tmpDir, modeId });
      sessions.push(session);
      expect(session.cliApprovesMcpTools?.(), modeId).toBe(expected);
    }
    // 跟随用户设置：initialize 报告默认模式之前未知
    const follow = await client.createSession({ cwd: tmpDir });
    sessions.push(follow);
    expect(follow.cliApprovesMcpTools?.()).toBe(false);
  });

  test("cliApprovesMcpTools：跟随用户设置时按 initialize 报告的 current_permission_mode", async () => {
    const reported = (mode: string) =>
      new ClaudeAgentClient({
        logger: createSilentLogger(),
        env: {},
        loadSettings: async () => null,
        cliFactory: () => ({
          ...stubCli(),
          initialized: Promise.resolve({ current_permission_mode: mode }) as ClaudeCliHandle["initialized"],
        }),
        terminateProcess: async () => "terminated",
        resolveExecutable: async () => ({
          available: true,
          path: "C:\\fake\\claude.exe",
          source: "path",
          version: "2.1.296 (Claude Code)",
        }),
      });
    const auto = await reported("auto").createSession({ cwd: tmpDir });
    sessions.push(auto);
    await auto.startTurn("hi");
    await waitUntil(() => auto.cliApprovesMcpTools?.() === true);
    const bypass = await reported("bypassPermissions").createSession({ cwd: tmpDir });
    sessions.push(bypass);
    await bypass.startTurn("hi");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bypass.cliApprovesMcpTools?.()).toBe(false);
  });

  test("token 不出现在 sidecar 日志里（含 CLI stderr 回显）", async () => {
    const logDir = path.join(tmpDir, "logs");
    const logger = createLogger({ logDir, stderr: false });
    const seen: ClaudeCliOptions[] = [];
    const client = makeClient(seen, logger);
    const session = await client.createSession({ cwd: tmpDir, interop: ENDPOINT });
    sessions.push(session);
    await session.startTurn("hi");
    seen[0]!.onStderr?.(`MCP server agentdeck failed: ${EXPECTED_BEARER}`);
    logger.warn("直接记录：%s", JSON.stringify(EXPECTED_CONFIG));
    logger.close();
    const log = readFileSync(path.join(logDir, "sidecar.log"), "utf8");
    expect(log).toContain("启动 Claude Code 会话");
    expect(log).not.toContain(TOKEN);
    expect(log).toContain("adi_***");
  });
});

describe("Codex：thread config.mcp_servers", () => {
  const FAKE_SERVER = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "codex",
    "fixtures",
    "fake-app-server.mjs",
  );

  function makeClient(threadConfig?: Record<string, unknown>): { client: CodexAgentClient; logFile: string } {
    const logFile = path.join(tmpDir, "fake-codex.log");
    const launch: CodexLaunch = {
      command: process.execPath,
      args: [FAKE_SERVER],
      envOverlay: { FAKE_CODEX_LOG: logFile },
      source: "env",
    };
    const client = new CodexAgentClient({
      logger: createSilentLogger(),
      env: process.env,
      resolveLaunch: () => launch,
      ...(threadConfig ? { launch: { threadConfig } } : {}),
    });
    return { client, logFile };
  }

  function received(logFile: string): Array<{ method?: string; params?: Record<string, any> }> {
    if (!existsSync(logFile)) return [];
    return readFileSync(logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.direction === "in")
      .map((entry) => entry.msg);
  }

  const EXPECTED_SERVER = {
    url: "http://localhost:45678/mcp",
    http_headers: { Authorization: EXPECTED_BEARER },
    tool_timeout_sec: 3700,
  };

  test("codexInteropConfig：localhost 主机、http_headers；仅 full-access 才自动批准工具", () => {
    expect(codexInteropConfig(ENDPOINT, { fullAccess: false })).toEqual({
      mcp_servers: { agentdeck: EXPECTED_SERVER },
    });
    expect(codexInteropConfig(ENDPOINT, { fullAccess: true })).toEqual({
      mcp_servers: { agentdeck: { ...EXPECTED_SERVER, default_tools_approval_mode: "approve" } },
    });
  });

  test("thread/start 带 config.mcp_servers.agentdeck；full-access 额外自动批准；没有 interop 时不带 config", async () => {
    const { client, logFile } = makeClient();
    const auto = await client.createSession({ cwd: tmpDir, interop: ENDPOINT });
    sessions.push(auto);
    await auto.startTurn("hello");
    await waitUntil(() => received(logFile).some((m) => m.method === "thread/start"));
    expect(received(logFile).find((m) => m.method === "thread/start")!.params!.config).toEqual({
      mcp_servers: { agentdeck: EXPECTED_SERVER },
    });

    const full = await client.createSession({ cwd: tmpDir, modeId: "full-access", interop: ENDPOINT });
    sessions.push(full);
    await full.startTurn("hello");
    await waitUntil(() => received(logFile).filter((m) => m.method === "thread/start").length === 2);
    const starts = received(logFile).filter((m) => m.method === "thread/start");
    expect(starts[1]!.params!.config.mcp_servers.agentdeck.default_tools_approval_mode).toBe("approve");

    const plain = await client.createSession({ cwd: tmpDir });
    sessions.push(plain);
    await plain.startTurn("hello");
    await waitUntil(() => received(logFile).filter((m) => m.method === "thread/start").length === 3);
    expect(received(logFile).filter((m) => m.method === "thread/start")[2]!.params!.config).toBeUndefined();
  });

  test("Computer Use：agentdeck_cua 在所有模式都自动批准（审批由 sidecar 发起），只开 Computer Use 时也注入", async () => {
    const EXPECTED_CU = {
      url: "http://localhost:45678/mcp/cua",
      http_headers: { Authorization: EXPECTED_BEARER },
      tool_timeout_sec: 3700,
      default_tools_approval_mode: "approve",
    };
    expect(codexInteropConfig(ENDPOINT, { fullAccess: false, computerUse: CU_ENDPOINT })).toEqual({
      mcp_servers: { agentdeck: EXPECTED_SERVER, agentdeck_cua: EXPECTED_CU },
    });
    const { client, logFile } = makeClient();
    const session = await client.createSession({ cwd: tmpDir, computerUse: CU_ENDPOINT });
    sessions.push(session);
    await session.startTurn("hello");
    await waitUntil(() => received(logFile).some((m) => m.method === "thread/start"));
    expect(received(logFile).find((m) => m.method === "thread/start")!.params!.config).toEqual({
      mcp_servers: { agentdeck_cua: EXPECTED_CU },
    });
    expect(session.cliApprovesMcpTools?.() ?? false).toBe(false);
  });

  test("thread/resume 与 thread/fork 同样注入，并与自定义中转的 threadConfig 合并", async () => {
    const { client, logFile } = makeClient({ model_provider: "agentdeck-relay" });
    const resumed = await client.resumeSession(
      { provider: "codex", sessionId: "thr_old" },
      { cwd: tmpDir, interop: ENDPOINT },
    );
    sessions.push(resumed);
    const forked = await client.forkSession!(
      { provider: "codex", sessionId: "thr_old" },
      { cwd: tmpDir, interop: ENDPOINT },
    );
    sessions.push(forked);
    const messages = received(logFile);
    for (const method of ["thread/resume", "thread/fork"]) {
      const call = messages.find((m) => m.method === method);
      expect(call, method).toBeDefined();
      expect(call!.params!.config).toEqual({
        model_provider: "agentdeck-relay",
        mcp_servers: { agentdeck: EXPECTED_SERVER },
      });
    }
  });
});

describe("ACP：mcpServers", () => {
  function logged(file: string): Array<{ method: string; mcpServers: unknown[] }> {
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  const EXPECTED_SERVERS = [
    {
      type: "http",
      name: "agentdeck",
      url: ENDPOINT.url,
      headers: [{ name: "Authorization", value: EXPECTED_BEARER }],
    },
  ];

  test("agent 声明 mcpCapabilities.http 时 newSession / loadSession 传 mcpServers", async () => {
    const log = path.join(tmpDir, "acp-mcp.log");
    const client = fakeClient({ FAKE_ACP_MCP_HTTP: "1", FAKE_ACP_MCP_LOG: log, FAKE_ACP_LOAD_SESSION: "1" });
    const created = await client.createSession({ cwd: tmpDir, interop: ENDPOINT });
    sessions.push(created);
    const resumed = await client.resumeSession(
      { provider: "acp:fake", sessionId: "fake-session-9" },
      { cwd: tmpDir, interop: ENDPOINT },
    );
    sessions.push(resumed);
    expect(logged(log)).toEqual([
      { method: "session/new", mcpServers: EXPECTED_SERVERS },
      { method: "session/load", mcpServers: EXPECTED_SERVERS },
    ]);
  });

  test("agent 未声明 http 能力，或没有 interop 时不注入（mcpServers 为空）", async () => {
    const noHttpLog = path.join(tmpDir, "no-http.log");
    const noHttp = fakeClient({ FAKE_ACP_MCP_LOG: noHttpLog });
    sessions.push(await noHttp.createSession({ cwd: tmpDir, interop: ENDPOINT }));
    expect(logged(noHttpLog)).toEqual([{ method: "session/new", mcpServers: [] }]);

    const noInteropLog = path.join(tmpDir, "no-interop.log");
    const noInterop = fakeClient({ FAKE_ACP_MCP_HTTP: "1", FAKE_ACP_MCP_LOG: noInteropLog });
    sessions.push(await noInterop.createSession({ cwd: tmpDir }));
    expect(logged(noInteropLog)).toEqual([{ method: "session/new", mcpServers: [] }]);
  });
});
