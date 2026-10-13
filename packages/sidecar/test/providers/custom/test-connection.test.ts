// provider.test：请求 URL / 请求头（本地 http 服务器）、超时、不可达、错误信息脱敏；以及日志脱敏工具。
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { ProviderProfile } from "@agentdeck/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { Logger } from "../../../src/logger.js";
import {
  collectSecrets,
  createRedactingLogger,
  redactText,
  testProviderProfile,
} from "../../../src/providers/custom/index.js";
import { redactBackgroundTask, redactEvent } from "../../../src/providers/custom/redact.js";

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}

let server: Server;
let base: string;
let seen: Seen[];
let reply: { status: number; body: string; hang?: boolean };

beforeEach(async () => {
  seen = [];
  reply = { status: 200, body: JSON.stringify({ data: [{ id: "m1", display_name: "模型一" }, { id: "m2" }] }) };
  server = createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    if (reply.hang) return;
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const claude = (overrides: Partial<ProviderProfile> = {}): ProviderProfile => ({
  id: "c",
  extends: "claude",
  label: "c",
  baseUrl: base,
  apiKey: "sk-claude-secret",
  ...overrides,
});

describe("provider.test 请求", () => {
  test("claude auth_token：GET {baseUrl}/v1/models，anthropic-version + Bearer", async () => {
    const result = await testProviderProfile(claude({ baseUrl: `${base}/anthropic` }));
    expect(result).toMatchObject({
      ok: true,
      status: 200,
      models: [
        { id: "m1", label: "模型一" },
        { id: "m2", label: "m2" },
      ],
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "GET", url: "/anthropic/v1/models" });
    expect(seen[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(seen[0]!.headers.authorization).toBe("Bearer sk-claude-secret");
    expect(seen[0]!.headers["x-api-key"]).toBeUndefined();
  });

  test("claude api_key：x-api-key，不带 Authorization", async () => {
    await testProviderProfile(claude({ authMode: "api_key" }));
    expect(seen[0]!.url).toBe("/v1/models");
    expect(seen[0]!.headers["x-api-key"]).toBe("sk-claude-secret");
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(seen[0]!.headers["anthropic-version"]).toBe("2023-06-01");
  });

  test.each([
    ["", "/v1/models"],
    ["/", "/v1/models"],
    ["/v1", "/v1/models"],
    ["/v1/", "/v1/models"],
    ["/openai", "/openai/v1/models"],
  ])("codex：baseUrl 后缀「%s」→ GET %s，Bearer", async (suffix, expectedPath) => {
    const result = await testProviderProfile({
      id: "x",
      extends: "codex",
      label: "x",
      baseUrl: `${base}${suffix}`,
      apiKey: "sk-codex-secret",
    });
    expect(result.ok).toBe(true);
    expect(seen[0]!.url).toBe(expectedPath);
    expect(seen[0]!.headers.authorization).toBe("Bearer sk-codex-secret");
    expect(seen[0]!.headers["anthropic-version"]).toBeUndefined();
  });

  test("非 2xx：ok=false，带状态码与中文错误；服务端回显的密钥被脱敏", async () => {
    reply = {
      status: 401,
      body: JSON.stringify({ error: { message: "invalid key sk-claude-secret" } }),
    };
    const result = await testProviderProfile(claude());
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toContain("接口返回 HTTP 401");
    expect(result.error).toContain("请检查密钥");
    expect(result.error).not.toContain("sk-claude-secret");
    expect(result.error).toContain("***");
  });

  test("2xx 但响应不是模型列表：ok=true，不带 models", async () => {
    reply = { status: 200, body: "OK" };
    const result = await testProviderProfile(claude());
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(result.models).toBeUndefined();
  });

  test("超时：ok=false，中文提示", async () => {
    reply = { status: 200, body: "", hang: true };
    const result = await testProviderProfile(claude(), { timeoutMs: 200 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/连接超时/);
  });

  test("不可达端口：连接被拒绝", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const result = await testProviderProfile(claude({ baseUrl: `http://127.0.0.1:${port}` }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("无法连接到");
    expect(result.error).toContain("连接被拒绝");
    expect(result.error).not.toContain("sk-claude-secret");
  });

  test("acp：只检查命令能否解析，不发请求", async () => {
    const ok = await testProviderProfile(
      { id: "a", extends: "acp", label: "a", command: ["kimi", "acp"] },
      { findExecutable: async (name) => (name === "kimi" ? "C:\\bin\\kimi.exe" : null) },
    );
    expect(ok.ok).toBe(true);
    const missing = await testProviderProfile(
      { id: "a", extends: "acp", label: "a", command: ["nope"] },
      { findExecutable: async () => null },
    );
    expect(missing).toMatchObject({ ok: false });
    expect(missing.error).toContain("未找到命令「nope」");
    expect(seen).toHaveLength(0);
  });
});

describe("脱敏", () => {
  test("collectSecrets：apiKey 与足够长的 env 值，长的优先", () => {
    expect(
      collectSecrets({ apiKey: "sk-abc", env: { A: "1", B: "true", C: "longer-secret-value" } }),
    ).toEqual(["longer-secret-value", "sk-abc"]);
  });

  test("redactText / redactEvent", () => {
    expect(redactText("key=sk-abc; again sk-abc", ["sk-abc"])).toBe("key=***; again ***");
    expect(
      redactEvent({ type: "turn_failed", turnId: "t", error: "401 sk-abc" }, ["sk-abc"]),
    ).toEqual({ type: "turn_failed", turnId: "t", error: "401 ***" });
    expect(
      redactEvent({ type: "timeline", item: { type: "error", message: "bad sk-abc" } }, ["sk-abc"]),
    ).toEqual({ type: "timeline", item: { type: "error", message: "bad ***" } });
  });

  test("redactBackgroundTask：描述 / 摘要 / 错误脱敏", () => {
    const task = {
      taskId: "bk1",
      kind: "command" as const,
      description: "curl -H sk-abc",
      status: "failed" as const,
      startedAt: 1,
      summary: "sk-abc 失败",
      error: "401 sk-abc",
    };
    expect(redactBackgroundTask(task, ["sk-abc"])).toEqual({
      ...task,
      description: "curl -H ***",
      summary: "*** 失败",
      error: "401 ***",
    });
    expect(redactBackgroundTask(task, [])).toBe(task);
  });

  test("createRedactingLogger：格式化参数里的密钥也被替换", () => {
    const lines: string[] = [];
    const base: Logger = {
      debug: (m, ...a) => lines.push([m, ...a].join(" ")),
      info: (m, ...a) => lines.push([m, ...a].join(" ")),
      warn: (m, ...a) => lines.push([m, ...a].join(" ")),
      error: (m, ...a) => lines.push([m, ...a].join(" ")),
      close: () => undefined,
    };
    const logger = createRedactingLogger(base, collectSecrets({ apiKey: "sk-abc", env: { T: "env-secret-value" } }));
    logger.info("启动参数：%s", '--settings {"env":{"ANTHROPIC_AUTH_TOKEN":"sk-abc"}}');
    logger.error("stderr: %s / %d", "env-secret-value", 3);
    expect(lines.join("\n")).not.toMatch(/sk-abc|env-secret-value/);
    expect(lines).toHaveLength(2);
  });
});
