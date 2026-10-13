// Claude 中转的整份 settings（design.md 4.7）：schema 规则（含旧字段 settingsFile 被忽略）、深合并顺序、
// 未填 baseUrl / apiKey 时沿用 settings.env、provider.test 回退与脱敏、
// 中转凭据隔离（中转只发送 profile 自己提供的凭据，未提供的置空，都没有时写占位值）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import type { ProviderProfile } from "@agentdeck/protocol";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createSilentLogger } from "../../../src/logger.js";
import { buildClaudeChildEnv } from "../../../src/providers/claude/claude-agent.js";
import {
  buildClaudeLaunchOverride,
  collectSecrets,
  createCustomProviderClient,
  createProviderProfilesSchema,
  deepMergeSettings,
  loadCustomClaudeSettings,
  mergeClaudeSettings,
  providerProfileSchema,
  RELAY_NO_KEY_PLACEHOLDER,
  reservedProfileIds,
  testProviderProfile,
  toProviderProfile,
} from "../../../src/providers/custom/index.js";
import { formatIssues } from "../../../src/providers/custom/schema.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "agentdeck-settings-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function settingsOf(args: readonly string[]): Record<string, any> | null {
  const index = args.indexOf("--settings");
  return index >= 0 ? JSON.parse(args[index + 1]!) : null;
}

function issuesOf(input: unknown) {
  const result = createProviderProfilesSchema(reservedProfileIds(["claude", "codex", "mock"])).safeParse(input);
  return result.success ? [] : formatIssues(result.error.issues, ["providers"]);
}

describe("schema：settings", () => {
  test("extends 非 claude 时填写 → 校验失败（路径 providers.<i>.settings）", () => {
    const issues = issuesOf([
      { id: "c", extends: "codex", label: "c", settings: { env: {} } },
      { id: "a", extends: "acp", label: "a", command: ["x"], settings: {} },
    ]);
    expect(issues).toEqual([
      { path: "providers.0.settings", message: "只有基于 Claude Code 的中转可以使用内联设置" },
      { path: "providers.1.settings", message: "只有基于 Claude Code 的中转可以使用内联设置" },
    ]);
  });

  test.each([[["a"]], ["{}"], [null], [42]])("settings 不是普通对象（%j）→ 校验失败", (settings) => {
    expect(issuesOf([{ id: "c", extends: "claude", label: "c", settings }])).toEqual([
      { path: "providers.0.settings", message: "settings 必须是 JSON 对象" },
    ]);
  });

  test("toProviderProfile 保留 settings（深拷贝）", () => {
    const settings = { env: { A: "1" }, permissions: { allow: ["Bash(ls)"] } };
    const profile = toProviderProfile(providerProfileSchema.parse({ id: "c", extends: "claude", label: "c", settings }));
    expect(profile).toEqual({ id: "c", extends: "claude", label: "c", settings });
    expect(profile.settings).not.toBe(settings);
  });

  test("旧字段 settingsFile 不再校验：任何值（含相对路径、非 claude）都被剥离，不报错", () => {
    expect(
      issuesOf([
        { id: "c", extends: "claude", label: "c", settingsFile: "relay.json" },
        { id: "x", extends: "codex", label: "x", settingsFile: "C:\\s.json" },
      ]),
    ).toEqual([]);
    const profile = toProviderProfile(
      providerProfileSchema.parse({ id: "c", extends: "claude", label: "c", settingsFile: "C:\\s.json", settings: {} }),
    );
    expect(profile).toEqual({ id: "c", extends: "claude", label: "c", settings: {} });
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

  test("顺序：settings → 推导 env（含置空另一个凭据）→ profile.env", () => {
    const profile: ProviderProfile = {
      id: "r",
      extends: "claude",
      label: "r",
      baseUrl: "http://form",
      apiKey: "sk-form-token",
      settings: {
        env: { FROM: "inline", LAST: "inline", ANTHROPIC_BASE_URL: "http://decoy", ANTHROPIC_API_KEY: "sk-inline-key" },
        permissions: { allow: ["Edit"], deny: ["Bash(rm:*)"] },
        hooks: { SessionStart: [{ hooks: [] }] },
      },
      env: { LAST: "profile-env" },
    };
    expect(mergeClaudeSettings(profile)).toEqual({
      env: {
        FROM: "inline",
        LAST: "profile-env",
        ANTHROPIC_BASE_URL: "http://form",
        ANTHROPIC_AUTH_TOKEN: "sk-form-token",
        ANTHROPIC_API_KEY: "",
      },
      permissions: { allow: ["Edit"], deny: ["Bash(rm:*)"] },
      hooks: { SessionStart: [{ hooks: [] }] },
    });
    // 作为一份 JSON 传给 --settings
    const { extraArgs } = buildClaudeLaunchOverride(profile);
    expect(extraArgs.filter((arg) => arg === "--settings")).toHaveLength(1);
    expect(settingsOf(extraArgs)).toEqual(mergeClaudeSettings(profile));
  });

  test("未填 baseUrl / apiKey：不推导、不置空，settings.env 的值生效；继承环境中的凭据仍被剔除", () => {
    const profile: ProviderProfile = {
      id: "r",
      extends: "claude",
      label: "r",
      settings: {
        env: { ANTHROPIC_BASE_URL: "http://from-settings", ANTHROPIC_AUTH_TOKEN: "sk-inline-token", ANTHROPIC_API_KEY: "sk-inline-key" },
      },
    };
    const launch = buildClaudeLaunchOverride(profile);
    expect(settingsOf(launch.extraArgs)).toEqual({
      env: { ANTHROPIC_BASE_URL: "http://from-settings", ANTHROPIC_AUTH_TOKEN: "sk-inline-token", ANTHROPIC_API_KEY: "sk-inline-key" },
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
  const envOf = (profile: ProviderProfile) => settingsOf(buildClaudeLaunchOverride(profile).extraArgs)?.env;

  test.each<[string, ProviderProfile, Record<string, string>]>([
    [
      "表单 apiKey（auth_token）",
      claudeProfile({ baseUrl: "http://relay", apiKey: "sk-form" }),
      { ANTHROPIC_BASE_URL: "http://relay", ANTHROPIC_AUTH_TOKEN: "sk-form", ANTHROPIC_API_KEY: "" },
    ],
    [
      "表单 apiKey（api_key）",
      claudeProfile({ baseUrl: "http://relay", apiKey: "sk-form", authMode: "api_key" }),
      { ANTHROPIC_BASE_URL: "http://relay", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_API_KEY: "sk-form" },
    ],
    [
      "settings 只给 AUTH_TOKEN（复现的泄露场景）",
      claudeProfile({ settings: { env: { ANTHROPIC_BASE_URL: "http://relay", ANTHROPIC_AUTH_TOKEN: "sk-inline" } } }),
      { ANTHROPIC_BASE_URL: "http://relay", ANTHROPIC_AUTH_TOKEN: "sk-inline", ANTHROPIC_API_KEY: "" },
    ],
    [
      "settings 只给 API_KEY",
      claudeProfile({ settings: { env: { ANTHROPIC_BASE_URL: "http://relay", ANTHROPIC_API_KEY: "sk-inline" } } }),
      { ANTHROPIC_BASE_URL: "http://relay", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_API_KEY: "sk-inline" },
    ],
    [
      "profile.env 只给 API_KEY（地址来自表单）",
      claudeProfile({ baseUrl: "http://relay", env: { ANTHROPIC_API_KEY: "sk-env" } }),
      { ANTHROPIC_BASE_URL: "http://relay", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_API_KEY: "sk-env" },
    ],
  ])("只给一种凭据（%s）→ 另一种置空", (_name, profile, expected) => {
    expect(envOf(profile)).toEqual(expected);
    expect(mergeClaudeSettings(profile).env).toEqual(expected);
  });

  test("两种都给 → 都保留（来源可以不同）", () => {
    const profile = claudeProfile({
      settings: { env: { ANTHROPIC_BASE_URL: "http://relay", ANTHROPIC_API_KEY: "sk-inline-key" } },
      env: { ANTHROPIC_AUTH_TOKEN: "sk-env-token" },
    });
    expect(envOf(profile)).toEqual({
      ANTHROPIC_BASE_URL: "http://relay",
      ANTHROPIC_AUTH_TOKEN: "sk-env-token",
      ANTHROPIC_API_KEY: "sk-inline-key",
    });
  });

  test.each<[string, ProviderProfile]>([
    ["只填表单 baseUrl", claudeProfile({ baseUrl: "http://relay" })],
    ["地址只在 settings", claudeProfile({ settings: { env: { ANTHROPIC_BASE_URL: "http://relay" } } })],
    [
      "凭据为空串 / 空白视为未提供",
      claudeProfile({ baseUrl: "http://relay", settings: { env: { ANTHROPIC_AUTH_TOKEN: "  ", ANTHROPIC_API_KEY: "" } } }),
    ],
  ])("都不给（%s）→ AUTH_TOKEN 写占位值，API_KEY 置空（压住用户 OAuth 令牌）", (_name, profile) => {
    expect(envOf(profile)).toEqual({
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
      envOf(
        claudeProfile({
          settings: { env: { ANTHROPIC_BASE_URL: "http://relay", ANTHROPIC_API_KEY: "sk-inline" } },
          env: { ANTHROPIC_BASE_URL: "" },
        }),
      ),
    ).toEqual({ ANTHROPIC_BASE_URL: "", ANTHROPIC_API_KEY: "sk-inline" });
  });
});

describe("中转的模型发现：只用中转自身合并后的 settings", () => {
  test("loadCustomClaudeSettings：settings → profile.env 合并", async () => {
    const profile: ProviderProfile = {
      id: "r",
      extends: "claude",
      label: "r",
      settings: { model: "relay-model[1m]", env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "relay-opus" } },
      env: { ANTHROPIC_SMALL_FAST_MODEL: "relay-fast" },
    };
    await expect(loadCustomClaudeSettings(profile)).resolves.toEqual({
      model: "relay-model[1m]",
      env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "relay-opus", ANTHROPIC_SMALL_FAST_MODEL: "relay-fast" },
    });
  });

  test("中转不读用户 settings；配了静态 models 时不追加任何设置里的模型", async () => {
    // 用户设置（CLAUDE_CONFIG_DIR）里有 user-model，中转不得继承
    const userDir = path.join(dir, "user-claude");
    mkdirSync(userDir);
    writeFileSync(path.join(userDir, "settings.json"), JSON.stringify({ model: "user-model", env: { ANTHROPIC_MODEL: "user-env-model" } }));
    const env = { CLAUDE_CONFIG_DIR: userDir };
    const missingExe = path.join(dir, "no-such-claude.exe");
    const profile: ProviderProfile = {
      id: "r",
      extends: "claude",
      label: "r",
      command: [missingExe],
      settings: { model: "relay-model[1m]", env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: "relay-haiku" } },
    };
    const client = createCustomProviderClient(profile, { logger: createSilentLogger(), env });
    const catalog = await client.fetchCatalog({ cwd: dir });
    const ids = catalog.models.map((m) => m.id);
    expect(ids).toEqual(["default", "sonnet", "opus", "haiku", "relay-model[1m]", "relay-haiku"]);
    expect(catalog.models.find((m) => m.id === "relay-model[1m]")?.label).toBe("relay-model · 1M 上下文");
    expect(catalog.models[0]!.description).toBe("跟随 Claude Code 设置（当前：relay-model[1m]）");
    expect(catalog.models.every((m) => m.provider === "custom:r")).toBe(true);

    const withStatic = createCustomProviderClient(
      { ...profile, models: [{ id: "glm-4.6", label: "GLM", isDefault: true }] },
      { logger: createSilentLogger(), env },
    );
    expect((await withStatic.fetchCatalog({ cwd: dir })).models.map((m) => m.id)).toEqual(["glm-4.6"]);
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

  test("表单留空：用 settings 中的地址与 AUTH_TOKEN（Bearer）", async () => {
    const result = await testProviderProfile({
      id: "r",
      extends: "claude",
      label: "r",
      settings: { env: { ANTHROPIC_BASE_URL: `${base}/relay/`, ANTHROPIC_AUTH_TOKEN: "sk-inline-token" } },
    });
    expect(result).toMatchObject({ ok: true, models: [{ id: "m1", label: "m1" }] });
    expect(seen[0]!.url).toBe("/relay/v1/models");
    expect(seen[0]!.headers.authorization).toBe("Bearer sk-inline-token");
    expect(seen[0]!.headers["x-api-key"]).toBeUndefined();
  });

  test("只有 ANTHROPIC_API_KEY（settings）→ x-api-key；表单 baseUrl 胜过 settings 中的诱饵地址", async () => {
    const result = await testProviderProfile({
      id: "r",
      extends: "claude",
      label: "r",
      baseUrl: base,
      settings: { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9/decoy", ANTHROPIC_API_KEY: "sk-inline-key" } },
    });
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("/v1/models");
    expect(seen[0]!.headers["x-api-key"]).toBe("sk-inline-key");
    expect(seen[0]!.headers.authorization).toBeUndefined();
  });

  test("接口报错：错误信息中 settings 里的密钥被脱敏", async () => {
    replyBody = JSON.stringify({ error: { message: "invalid token sk-inline-secret-123" } });
    const failed = await testProviderProfile({
      id: "r",
      extends: "claude",
      label: "r",
      settings: { env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: "sk-inline-secret-123" } },
    });
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("HTTP 401");
    expect(failed.error).not.toContain("sk-inline-secret-123");
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

    test("中转只有 settings 的 API_KEY → 只带 x-api-key，不带用户的 AUTH_TOKEN", async () => {
      const result = await testProviderProfile({
        id: "r",
        extends: "claude",
        label: "r",
        settings: { env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: "sk-inline-key" } },
      });
      expect(result.ok).toBe(true);
      expect(seen[0]!.headers["x-api-key"]).toBe("sk-inline-key");
      expect(seen[0]!.headers.authorization).toBeUndefined();
    });
  });
});

describe("脱敏：settings.env", () => {
  test("collectSecrets 含 settings.env 的字符串值（短值与非字符串忽略）", () => {
    expect(
      collectSecrets({
        apiKey: "sk-abc",
        settings: { env: { A: "inline-secret-value", B: "1", C: 123456789 }, model: "opus-long-name" },
      }),
    ).toEqual(["inline-secret-value", "sk-abc"]);
  });
});
