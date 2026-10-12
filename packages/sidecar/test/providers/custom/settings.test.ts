// Claude 中转的整份 settings（design.md 4.7）：schema 规则、深合并顺序、未填 baseUrl / apiKey 时沿用 settings.env、
// settingsFile 读取（不存在 / 非法 JSON / BOM / 每次启动重新读取 / PROVIDER_UNAVAILABLE）、provider.test 回退与脱敏、
// 中转凭据隔离（中转只发送 profile 自己提供的凭据，未提供的置空，都没有时写占位值）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { format } from "node:util";

import type { ProviderProfile } from "@agentdeck/protocol";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { AgentManager } from "../../../src/agent/agent-manager.js";
import { AgentRpcError } from "../../../src/agent/errors.js";
import { createSilentLogger, type Logger } from "../../../src/logger.js";
import {
  ClaudeAgentClient,
  type ClaudeCliHandle,
  type ClaudeCliOptions,
} from "../../../src/providers/claude/index.js";
import { buildClaudeChildEnv } from "../../../src/providers/claude/claude-agent.js";
import {
  addSecrets,
  buildClaudeLaunchOverride,
  collectSecrets,
  createCustomClaudeLaunch,
  createCustomProviderClient,
  createProviderProfilesSchema,
  createRedactingLogger,
  deepMergeSettings,
  isAbsoluteSettingsPath,
  mergeClaudeSettings,
  providerProfileSchema,
  readClaudeSettingsFile,
  RELAY_NO_KEY_PLACEHOLDER,
  reservedProfileIds,
  testProviderProfile,
  toProviderProfile,
} from "../../../src/providers/custom/index.js";
import { formatIssues } from "../../../src/providers/custom/schema.js";
import { MockAgentClient } from "../../../src/providers/mock/index.js";
import { ProviderRegistry } from "../../../src/providers/registry.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "agentdeck-settings-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeJson(name: string, content: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, content, "utf8");
  return file;
}

function settingsOf(args: readonly string[]): Record<string, any> | null {
  const index = args.indexOf("--settings");
  return index >= 0 ? JSON.parse(args[index + 1]!) : null;
}

function issuesOf(input: unknown) {
  const result = createProviderProfilesSchema(reservedProfileIds(["claude", "codex", "mock"])).safeParse(input);
  return result.success ? [] : formatIssues(result.error.issues, ["providers"]);
}

function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const push = (message: string, ...args: unknown[]) => lines.push(format(message, ...args));
  return { lines, debug: push, info: push, warn: push, error: push, close: () => undefined };
}

describe("schema：settingsFile / settings", () => {
  test("extends 非 claude 时填写 → 校验失败（路径 providers.<i>.settingsFile / settings）", () => {
    const issues = issuesOf([
      { id: "c", extends: "codex", label: "c", settingsFile: "C:\\s.json", settings: { env: {} } },
      { id: "a", extends: "acp", label: "a", command: ["x"], settings: {} },
    ]);
    expect(issues).toEqual(
      expect.arrayContaining([
        { path: "providers.0.settingsFile", message: "只有基于 Claude Code 的中转可以使用设置文件" },
        { path: "providers.0.settings", message: "只有基于 Claude Code 的中转可以使用内联设置" },
        { path: "providers.1.settings", message: "只有基于 Claude Code 的中转可以使用内联设置" },
      ]),
    );
    // 空字符串视为未填写：非 claude 也不报错
    expect(issuesOf([{ id: "c", extends: "codex", label: "c", settingsFile: "  " }])).toEqual([]);
  });

  test.each(["settings.json", "./a/settings.json", "C:settings.json", "\\settings.json", "~/x.json"])(
    "相对路径 %s → 校验失败",
    (settingsFile) => {
      expect(issuesOf([{ id: "c", extends: "claude", label: "c", settingsFile }])).toEqual([
        { path: "providers.0.settingsFile", message: "设置文件路径必须是绝对路径" },
      ]);
    },
  );

  test.each(["C:\\Users\\me\\.claude\\relay.json", "d:/cfg/s.json", "\\\\server\\share\\s.json", "/home/me/s.json"])(
    "绝对路径 %s 合法",
    (settingsFile) => {
      expect(isAbsoluteSettingsPath(settingsFile)).toBe(true);
      expect(issuesOf([{ id: "c", extends: "claude", label: "c", settingsFile }])).toEqual([]);
    },
  );

  test.each([[["a"]], ["{}"], [null], [42]])("settings 不是普通对象（%j）→ 校验失败", (settings) => {
    expect(issuesOf([{ id: "c", extends: "claude", label: "c", settings }])).toEqual([
      { path: "providers.0.settings", message: "settings 必须是 JSON 对象" },
    ]);
  });

  test("toProviderProfile 保留 settingsFile（去空白）与 settings（深拷贝）", () => {
    const settings = { env: { A: "1" }, permissions: { allow: ["Bash(ls)"] } };
    const profile = toProviderProfile(
      providerProfileSchema.parse({
        id: "c",
        extends: "claude",
        label: "c",
        settingsFile: "  C:\\s.json ",
        settings,
      }),
    );
    expect(profile).toEqual({ id: "c", extends: "claude", label: "c", settingsFile: "C:\\s.json", settings });
    expect(profile.settings).not.toBe(settings);
  });
});

describe("深合并与合并顺序", () => {
  test("deepMergeSettings：对象按键递归合并，数组与标量整体替换，不修改入参", () => {
    const base = { env: { A: "1", B: "2" }, permissions: { allow: ["x", "y"], deny: ["d"] }, model: "a", hooks: { S: [1] } };
    const overlay = { env: { B: "3", C: "4" }, permissions: { allow: ["z"] }, model: { nested: true }, hooks: "off" };
    expect(deepMergeSettings(base, overlay)).toEqual({
      env: { A: "1", B: "3", C: "4" },
      permissions: { allow: ["z"], deny: ["d"] },
      model: { nested: true },
      hooks: "off",
    });
    expect(base).toEqual({ env: { A: "1", B: "2" }, permissions: { allow: ["x", "y"], deny: ["d"] }, model: "a", hooks: { S: [1] } });
  });

  test("顺序：settingsFile → settings → 推导 env（含置空另一个凭据）→ profile.env", () => {
    const fileSettings = {
      env: { FROM: "file", KEEP: "file", ANTHROPIC_BASE_URL: "http://decoy", ANTHROPIC_API_KEY: "sk-file-key" },
      permissions: { allow: ["Read"], deny: ["Bash(rm:*)"] },
      hooks: { SessionStart: [{ hooks: [] }] },
    };
    const profile: ProviderProfile = {
      id: "r",
      extends: "claude",
      label: "r",
      baseUrl: "http://form",
      apiKey: "sk-form-token",
      settings: { env: { FROM: "inline", INLINE: "inline", LAST: "inline" }, permissions: { allow: ["Edit"] } },
      env: { LAST: "profile-env" },
    };
    expect(mergeClaudeSettings(profile, fileSettings)).toEqual({
      env: {
        FROM: "inline",
        KEEP: "file",
        INLINE: "inline",
        LAST: "profile-env",
        ANTHROPIC_BASE_URL: "http://form",
        ANTHROPIC_AUTH_TOKEN: "sk-form-token",
        ANTHROPIC_API_KEY: "",
      },
      permissions: { allow: ["Edit"], deny: ["Bash(rm:*)"] },
      hooks: { SessionStart: [{ hooks: [] }] },
    });
    // 作为一份 JSON 传给 --settings
    const { extraArgs } = buildClaudeLaunchOverride(profile, fileSettings);
    expect(extraArgs.filter((arg) => arg === "--settings")).toHaveLength(1);
    expect(settingsOf(extraArgs)).toEqual(mergeClaudeSettings(profile, fileSettings));
  });

  test("未填 baseUrl / apiKey：不推导、不置空，settings.env 的值生效；继承环境中的凭据仍被剔除", () => {
    const fileSettings = {
      env: { ANTHROPIC_BASE_URL: "http://from-file", ANTHROPIC_AUTH_TOKEN: "sk-file-token", ANTHROPIC_API_KEY: "sk-file-key" },
    };
    const profile: ProviderProfile = { id: "r", extends: "claude", label: "r", settings: { env: { ANTHROPIC_API_KEY: "sk-inline-key" } } };
    const launch = buildClaudeLaunchOverride(profile, fileSettings);
    expect(settingsOf(launch.extraArgs)).toEqual({
      env: { ANTHROPIC_BASE_URL: "http://from-file", ANTHROPIC_AUTH_TOKEN: "sk-file-token", ANTHROPIC_API_KEY: "sk-inline-key" },
    });
    expect(launch.envOverlay).toEqual({});
    const childEnv = buildClaudeChildEnv(
      { PATH: "/bin", ANTHROPIC_BASE_URL: "http://inherited", ANTHROPIC_AUTH_TOKEN: "sk-inherited" },
      launch,
    );
    expect(childEnv).toEqual({ PATH: "/bin" });
    // settings.env 指定了中转地址：同样默认禁用 WebSearch
    expect(launch.extraArgs.slice(-2)).toEqual(["--disallowedTools", "WebSearch"]);
  });

  test("只填 apiKey（auth_token）时只置空 ANTHROPIC_API_KEY，ANTHROPIC_BASE_URL 仍取 settings", () => {
    const profile: ProviderProfile = {
      id: "r",
      extends: "claude",
      label: "r",
      apiKey: "sk-form",
      settings: { env: { ANTHROPIC_BASE_URL: "http://inline", ANTHROPIC_API_KEY: "sk-inline" } },
    };
    expect(settingsOf(buildClaudeLaunchOverride(profile).extraArgs)?.env).toEqual({
      ANTHROPIC_BASE_URL: "http://inline",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "sk-form",
    });
  });
});

describe("中转凭据隔离：中转只发送 profile 自己提供的凭据", () => {
  const claudeProfile = (overrides: Partial<ProviderProfile> = {}): ProviderProfile => ({
    id: "r",
    extends: "claude",
    label: "r",
    ...overrides,
  });
  const envOf = (profile: ProviderProfile, fileSettings?: Record<string, unknown>) =>
    settingsOf(buildClaudeLaunchOverride(profile, fileSettings).extraArgs)?.env;

  test.each<[string, ProviderProfile, Record<string, unknown> | undefined, Record<string, string>]>([
    [
      "表单 apiKey（auth_token）",
      claudeProfile({ baseUrl: "http://relay", apiKey: "sk-form" }),
      undefined,
      { ANTHROPIC_BASE_URL: "http://relay", ANTHROPIC_AUTH_TOKEN: "sk-form", ANTHROPIC_API_KEY: "" },
    ],
    [
      "表单 apiKey（api_key）",
      claudeProfile({ baseUrl: "http://relay", apiKey: "sk-form", authMode: "api_key" }),
      undefined,
      { ANTHROPIC_BASE_URL: "http://relay", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_API_KEY: "sk-form" },
    ],
    [
      "内联 settings 只给 AUTH_TOKEN",
      claudeProfile({ settings: { env: { ANTHROPIC_BASE_URL: "http://relay", ANTHROPIC_AUTH_TOKEN: "sk-inline" } } }),
      undefined,
      { ANTHROPIC_BASE_URL: "http://relay", ANTHROPIC_AUTH_TOKEN: "sk-inline", ANTHROPIC_API_KEY: "" },
    ],
    [
      "settingsFile 只给 AUTH_TOKEN（复现的泄露场景）",
      claudeProfile({ settingsFile: "C:\relay.json" }),
      { env: { ANTHROPIC_BASE_URL: "http://relay", ANTHROPIC_AUTH_TOKEN: "sk-file" } },
      { ANTHROPIC_BASE_URL: "http://relay", ANTHROPIC_AUTH_TOKEN: "sk-file", ANTHROPIC_API_KEY: "" },
    ],
    [
      "settingsFile 只给 API_KEY",
      claudeProfile({ settingsFile: "C:\relay.json" }),
      { env: { ANTHROPIC_BASE_URL: "http://relay", ANTHROPIC_API_KEY: "sk-file" } },
      { ANTHROPIC_BASE_URL: "http://relay", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_API_KEY: "sk-file" },
    ],
    [
      "profile.env 只给 API_KEY（地址来自表单）",
      claudeProfile({ baseUrl: "http://relay", env: { ANTHROPIC_API_KEY: "sk-env" } }),
      undefined,
      { ANTHROPIC_BASE_URL: "http://relay", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_API_KEY: "sk-env" },
    ],
  ])("只给一种凭据（%s）→ 另一种置空", (_name, profile, fileSettings, expected) => {
    expect(envOf(profile, fileSettings)).toEqual(expected);
    expect(mergeClaudeSettings(profile, fileSettings).env).toEqual(expected);
  });

  test("两种都给 → 都保留（来源可以不同）", () => {
    const profile = claudeProfile({
      settings: { env: { ANTHROPIC_API_KEY: "sk-inline-key" } },
      env: { ANTHROPIC_AUTH_TOKEN: "sk-env-token" },
    });
    expect(envOf(profile, { env: { ANTHROPIC_BASE_URL: "http://relay" } })).toEqual({
      ANTHROPIC_BASE_URL: "http://relay",
      ANTHROPIC_AUTH_TOKEN: "sk-env-token",
      ANTHROPIC_API_KEY: "sk-inline-key",
    });
  });

  test.each<[string, ProviderProfile, Record<string, unknown> | undefined]>([
    ["只填表单 baseUrl", claudeProfile({ baseUrl: "http://relay" }), undefined],
    ["地址只在 settingsFile", claudeProfile({ settingsFile: "C:\relay.json" }), { env: { ANTHROPIC_BASE_URL: "http://relay" } }],
    [
      "凭据为空串 / 空白视为未提供",
      claudeProfile({ baseUrl: "http://relay", settings: { env: { ANTHROPIC_AUTH_TOKEN: "  ", ANTHROPIC_API_KEY: "" } } }),
      undefined,
    ],
  ])("都不给（%s）→ AUTH_TOKEN 写占位值，API_KEY 置空（压住用户 OAuth 令牌）", (_name, profile, fileSettings) => {
    expect(envOf(profile, fileSettings)).toEqual({
      ANTHROPIC_BASE_URL: "http://relay",
      ANTHROPIC_AUTH_TOKEN: RELAY_NO_KEY_PLACEHOLDER,
      ANTHROPIC_API_KEY: "",
    });
    expect(RELAY_NO_KEY_PLACEHOLDER).toBe("agentdeck-no-key");
  });

  test("非中转（有效 ANTHROPIC_BASE_URL 为空）不置空、不写占位值", () => {
    // 只换凭据 / 设置，不换端点
    expect(envOf(claudeProfile({ settings: { env: { ANTHROPIC_AUTH_TOKEN: "sk-inline" } } }))).toEqual({
      ANTHROPIC_AUTH_TOKEN: "sk-inline",
    });
    expect(settingsOf(buildClaudeLaunchOverride(claudeProfile({ settings: { model: "opus" } })).extraArgs)).toEqual({
      model: "opus",
    });
    expect(buildClaudeLaunchOverride(claudeProfile()).extraArgs).toEqual([]);
    // profile.env 把 settings 里的地址覆盖为空串：同样视为非中转
    expect(
      envOf(claudeProfile({ env: { ANTHROPIC_BASE_URL: "" } }), { env: { ANTHROPIC_BASE_URL: "http://relay", ANTHROPIC_API_KEY: "sk-file" } }),
    ).toEqual({ ANTHROPIC_BASE_URL: "", ANTHROPIC_API_KEY: "sk-file" });
  });
});

describe("settingsFile 读取", () => {
  test("不存在 / 非法 JSON / 不是对象 → 中文错误；带 UTF-8 BOM 可读", async () => {
    await expect(readClaudeSettingsFile(path.join(dir, "missing.json"))).rejects.toThrow(/设置文件不存在/);
    await expect(readClaudeSettingsFile(writeJson("bad.json", "{ env: "))).rejects.toThrow(/不是合法的 JSON/);
    await expect(readClaudeSettingsFile(writeJson("arr.json", "[1]"))).rejects.toThrow(/必须是 JSON 对象/);
    await expect(readClaudeSettingsFile(dir)).rejects.toThrow(/目录|无法读取/);
    const bom = writeJson("bom.json", `\uFEFF${JSON.stringify({ env: { A: "1" } })}`);
    await expect(readClaudeSettingsFile(bom)).resolves.toEqual({ env: { A: "1" } });
  });

  function fakeCli(seen: ClaudeCliOptions[]) {
    return (options: ClaudeCliOptions): ClaudeCliHandle => {
      seen.push(options);
      let finish: () => void = () => undefined;
      const done = new Promise<void>((resolve) => (finish = resolve));
      return {
        initialized: Promise.resolve({}),
        sendUserMessage: () => undefined,
        interrupt: async () => undefined,
        setModel: async () => undefined,
        setPermissionMode: async () => undefined,
        close: async () => finish(),
        async *[Symbol.asyncIterator]() {
          await done;
        },
      };
    };
  }

  test("每次建会话 / 恢复会话都重新读取；读取失败 → PROVIDER_UNAVAILABLE；文件 env 值进入脱敏列表；日志只含顶层键", async () => {
    const file = writeJson("relay.json", JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "sk-file-v1-token" }, hooks: {} }));
    const profile: ProviderProfile = { id: "r", extends: "claude", label: "r", settingsFile: file, settings: { model: "x" } };
    const secrets = collectSecrets(profile);
    const logger = recordingLogger();
    const seen: ClaudeCliOptions[] = [];
    const client = new ClaudeAgentClient({
      logger: createSilentLogger(),
      env: {},
      providerId: "custom:r",
      launch: createCustomClaudeLaunch(profile, secrets, logger),
      cliFactory: fakeCli(seen),
      resolveExecutable: async () => ({ available: true, path: "C:\\fake\\claude.exe", source: "path", version: "1" }),
    });

    const first = await client.createSession({ cwd: dir });
    await first.startTurn("hi");
    await first.close();
    expect(settingsOf(seen[0]!.extraArgs ?? [])).toEqual({ env: { ANTHROPIC_AUTH_TOKEN: "sk-file-v1-token" }, hooks: {}, model: "x" });
    expect(secrets).toContain("sk-file-v1-token");

    writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "sk-file-v2-token" } }));
    const resumed = await client.resumeSession({ provider: "custom:r", sessionId: "s1" }, { cwd: dir });
    await resumed.startTurn("again");
    await resumed.close();
    expect(settingsOf(seen[1]!.extraArgs ?? [])?.env).toEqual({ ANTHROPIC_AUTH_TOKEN: "sk-file-v2-token" });
    expect(secrets).toEqual(expect.arrayContaining(["sk-file-v1-token", "sk-file-v2-token"]));

    expect(logger.lines.join("\n")).toMatch(/顶层键 \[env, hooks\]；内联设置顶层键 \[model\]/);
    expect(logger.lines.join("\n")).not.toMatch(/sk-file/);

    rmSync(file);
    const error = await client.createSession({ cwd: dir }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentRpcError);
    expect((error as AgentRpcError).code).toBe("PROVIDER_UNAVAILABLE");
    expect((error as AgentRpcError).message).toMatch(/设置文件不存在/);
    await expect(client.resumeSession({ provider: "custom:r", sessionId: "s1" }, { cwd: dir })).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
    // 模型探测读不到文件时回退静态别名，不抛错
    const catalog = await client.fetchCatalog({ cwd: dir });
    expect(catalog.models.length).toBeGreaterThan(0);
  });

  test("isAvailable：文件不存在 / 不是 JSON 对象 → 不可用（中文原因），修好后恢复可用；AgentManager 建会话返回 PROVIDER_UNAVAILABLE", async () => {
    const file = path.join(dir, "later.json");
    const profile: ProviderProfile = { id: "r", extends: "claude", label: "r", settingsFile: file };
    const client = createCustomProviderClient(profile, {
      logger: createSilentLogger(),
      env: {},
      createInner: () => new MockAgentClient(),
    });
    expect(await client.isAvailable()).toEqual({ available: false, reason: `设置文件不存在：${file}` });

    const registry = new ProviderRegistry([]);
    registry.replaceCustomClients([client]);
    const manager = new AgentManager({ registry, logger: createSilentLogger() });
    await expect(manager.createAgent({ provider: "custom:r", cwd: dir })).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      message: `设置文件不存在：${file}`,
    });

    writeFileSync(file, '"just a string"');
    expect((await client.isAvailable()).reason).toMatch(/必须是 JSON 对象/);
    writeFileSync(file, "{}");
    expect((await client.isAvailable()).available).toBe(true);
    await manager.shutdown();
  });
});

describe("provider.test 回退到 settings.env", () => {
  let server: Server;
  let base: string;
  let seen: { url: string; headers: IncomingHttpHeaders }[];
  let replyBody: string;

  beforeEach(async () => {
    seen = [];
    replyBody = JSON.stringify({ data: [{ id: "m1" }] });
    server = createServer((req, res) => {
      seen.push({ url: req.url ?? "", headers: req.headers });
      res.writeHead(replyBody.startsWith("{\"data") ? 200 : 401, { "content-type": "application/json" });
      res.end(replyBody);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("表单留空：用 settingsFile 中的地址与 AUTH_TOKEN（Bearer）", async () => {
    const file = writeJson("s.json", JSON.stringify({ env: { ANTHROPIC_BASE_URL: `${base}/relay/`, ANTHROPIC_AUTH_TOKEN: "sk-file-token" } }));
    const result = await testProviderProfile({ id: "r", extends: "claude", label: "r", settingsFile: file });
    expect(result).toMatchObject({ ok: true, models: [{ id: "m1", label: "m1" }] });
    expect(seen[0]!.url).toBe("/relay/v1/models");
    expect(seen[0]!.headers.authorization).toBe("Bearer sk-file-token");
    expect(seen[0]!.headers["x-api-key"]).toBeUndefined();
  });

  test("只有 ANTHROPIC_API_KEY（内联）→ x-api-key；表单 baseUrl 胜过文件中的诱饵地址", async () => {
    const file = writeJson("s.json", JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9/decoy" } }));
    const result = await testProviderProfile({
      id: "r",
      extends: "claude",
      label: "r",
      baseUrl: base,
      settingsFile: file,
      settings: { env: { ANTHROPIC_API_KEY: "sk-inline-key" } },
    });
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("/v1/models");
    expect(seen[0]!.headers["x-api-key"]).toBe("sk-inline-key");
    expect(seen[0]!.headers.authorization).toBeUndefined();
  });

  test("文件读取失败 → ok:false 且不发请求；错误信息中文件里的密钥被脱敏", async () => {
    const missing = await testProviderProfile({ id: "r", extends: "claude", label: "r", settingsFile: path.join(dir, "no.json") });
    expect(missing).toEqual({ ok: false, error: `设置文件不存在：${path.join(dir, "no.json")}` });
    expect(seen).toHaveLength(0);

    replyBody = JSON.stringify({ error: { message: "invalid token sk-file-secret-123" } });
    const file = writeJson("s.json", JSON.stringify({ env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: "sk-file-secret-123" } }));
    const failed = await testProviderProfile({ id: "r", extends: "claude", label: "r", settingsFile: file });
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("HTTP 401");
    expect(failed.error).not.toContain("sk-file-secret-123");
  });

  describe("不读取用户凭据", () => {
    beforeEach(() => {
      // 用户 Claude 配置目录：settings.json 带诱饵凭据，.credentials.json 带假 OAuth 令牌；进程环境同样带诱饵
      const configDir = path.join(dir, "user-claude");
      mkdirSync(configDir);
      writeFileSync(
        path.join(configDir, "settings.json"),
        JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "decoy-user-token", ANTHROPIC_API_KEY: "decoy-user-key" } }),
      );
      writeFileSync(
        path.join(configDir, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "fake-oauth-token", refreshToken: "x", expiresAt: 0, scopes: [] } }),
      );
      vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
      vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "decoy-env-token");
      vi.stubEnv("ANTHROPIC_API_KEY", "decoy-env-key");
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "decoy-env-oauth");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    test("中转没有任何凭据 → 不带鉴权头（也不发送占位值）", async () => {
      const result = await testProviderProfile({ id: "r", extends: "claude", label: "r", baseUrl: base });
      expect(result.ok).toBe(true);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.headers.authorization).toBeUndefined();
      expect(seen[0]!.headers["x-api-key"]).toBeUndefined();
    });

    test("中转只有 settingsFile 的 API_KEY → 只带 x-api-key，不带用户的 AUTH_TOKEN", async () => {
      const file = writeJson("s.json", JSON.stringify({ env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: "sk-file-key" } }));
      const result = await testProviderProfile({ id: "r", extends: "claude", label: "r", settingsFile: file });
      expect(result.ok).toBe(true);
      expect(seen[0]!.headers["x-api-key"]).toBe("sk-file-key");
      expect(seen[0]!.headers.authorization).toBeUndefined();
    });
  });
});

describe("脱敏：settings.env", () => {
  test("collectSecrets 含内联 settings.env 与文件 settings.env 的字符串值（短值与非字符串忽略）", () => {
    expect(
      collectSecrets(
        { apiKey: "sk-abc", settings: { env: { A: "inline-secret-value", B: "1", C: 123456789 }, model: "opus-long-name" } },
        { env: { D: "file-secret-value-long" } },
      ),
    ).toEqual(["file-secret-value-long", "inline-secret-value", "sk-abc"]);
  });

  test("addSecrets 原地追加；growable logger 对之后追加的机密同样脱敏", () => {
    const lines: string[] = [];
    const base: Logger = {
      debug: (m, ...a) => lines.push([m, ...a].join(" ")),
      info: (m, ...a) => lines.push([m, ...a].join(" ")),
      warn: (m, ...a) => lines.push([m, ...a].join(" ")),
      error: (m, ...a) => lines.push([m, ...a].join(" ")),
      close: () => undefined,
    };
    const secrets: string[] = [];
    const logger = createRedactingLogger(base, secrets, true);
    expect(logger).not.toBe(base);
    addSecrets(secrets, ["short-1", "a-much-longer-secret"]);
    expect(secrets).toEqual(["a-much-longer-secret", "short-1"]);
    logger.warn("stderr: %s", "token a-much-longer-secret / short-1");
    expect(lines).toEqual(["%s stderr: token *** / ***"]);
    expect(createRedactingLogger(base, [])).toBe(base);
  });
});
