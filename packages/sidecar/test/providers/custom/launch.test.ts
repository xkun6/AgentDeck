// 中转启动参数：env 推导与剔除（两种 authMode）、--settings / --disallowedTools 拼接、Codex 配置注入。
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ProviderProfile } from "@agentdeck/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createSilentLogger } from "../../../src/logger.js";
import {
  buildClaudeCliArgs,
  ClaudeAgentClient,
  type ClaudeCliHandle,
  type ClaudeCliOptions,
} from "../../../src/providers/claude/index.js";
import { buildClaudeChildEnv } from "../../../src/providers/claude/claude-agent.js";
import { applyCodexEnvOverride, CodexAgentClient } from "../../../src/providers/codex/codex-agent.js";
import {
  buildClaudeLaunchOverride,
  buildCodexLaunchOverride,
  deriveClaudeEnv,
  deriveCodexEnv,
  normalizeOpenAiBaseUrl,
  resolveCodexRelay,
  resolveDisallowedTools,
} from "../../../src/providers/custom/index.js";

const relay = (overrides: Partial<ProviderProfile> = {}): ProviderProfile => ({
  id: "relay",
  extends: "claude",
  label: "中转",
  baseUrl: "https://relay.example.com",
  apiKey: "sk-relay",
  ...overrides,
});

const INHERITED = {
  PATH: "/usr/bin",
  ANTHROPIC_BASE_URL: "https://inherited.example.com",
  anthropic_api_key: "sk-inherited-lowercase",
  ANTHROPIC_AUTH_TOKEN: "sk-inherited-token",
  OPENAI_BASE_URL: "https://inherited-openai.example.com",
  OPENAI_API_KEY: "sk-inherited-openai",
  AGENTDECK_TOKEN: "internal",
  CLAUDECODE: "1",
};

function settingsOf(args: readonly string[]): { env: Record<string, string> } | null {
  const index = args.indexOf("--settings");
  return index >= 0 ? JSON.parse(args[index + 1]!) : null;
}

describe("Claude 中转：env 推导与剔除", () => {
  test("auth_token（默认）：写 ANTHROPIC_AUTH_TOKEN，剔除继承的凭据变量（不区分大小写）", () => {
    const launch = buildClaudeLaunchOverride(relay());
    const env = buildClaudeChildEnv(INHERITED, launch);
    expect(env).toEqual({
      PATH: "/usr/bin",
      OPENAI_BASE_URL: "https://inherited-openai.example.com",
      OPENAI_API_KEY: "sk-inherited-openai",
      ANTHROPIC_BASE_URL: "https://relay.example.com",
      ANTHROPIC_AUTH_TOKEN: "sk-relay",
    });
  });

  test("api_key：写 ANTHROPIC_API_KEY，不写 AUTH_TOKEN", () => {
    const launch = buildClaudeLaunchOverride(relay({ authMode: "api_key" }));
    const env = buildClaudeChildEnv(INHERITED, launch);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-relay");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.anthropic_api_key).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe("https://relay.example.com");
  });

  test("profile.env 最后应用，可覆盖推导值", () => {
    expect(
      deriveClaudeEnv(relay({ env: { ANTHROPIC_BASE_URL: "https://override.example.com", API_TIMEOUT_MS: "3000000" } })),
    ).toEqual({
      ANTHROPIC_BASE_URL: "https://override.example.com",
      ANTHROPIC_AUTH_TOKEN: "sk-relay",
      API_TIMEOUT_MS: "3000000",
    });
  });

  test("中转（表单或 settings.env 给出 baseUrl）剔除继承的 CLAUDE_CODE_OAUTH_TOKEN；非中转保留", () => {
    const inherited = { ...INHERITED, CLAUDE_CODE_OAUTH_TOKEN: "oauth-inherited" };
    const viaForm = buildClaudeLaunchOverride(relay());
    expect(viaForm.stripEnv).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(buildClaudeChildEnv(inherited, viaForm).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();

    const viaSettings = buildClaudeLaunchOverride({
      id: "s",
      extends: "claude",
      label: "s",
      settings: { env: { ANTHROPIC_BASE_URL: "https://relay.example.com" } },
    });
    expect(viaSettings.stripEnv).toContain("CLAUDE_CODE_OAUTH_TOKEN");

    const plain = buildClaudeLaunchOverride({ id: "p", extends: "claude", label: "p", apiKey: "sk-x" });
    expect(plain.stripEnv).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(buildClaudeChildEnv(inherited, plain).CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-inherited");
  });

  test("profile.env 显式设置 CLAUDE_CODE_OAUTH_TOKEN 时仍在剔除之后叠加", () => {
    const launch = buildClaudeLaunchOverride(relay({ env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-explicit" } }));
    expect(launch.stripEnv).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(launch.envOverlay.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-explicit");
    const env = buildClaudeChildEnv({ ...INHERITED, CLAUDE_CODE_OAUTH_TOKEN: "oauth-inherited" }, launch);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-explicit");
  });

  test("不传 launch 时与原行为一致（只剔除内部变量与父 Claude 会话变量）", () => {
    expect(buildClaudeChildEnv(INHERITED)).toEqual({
      PATH: "/usr/bin",
      ANTHROPIC_BASE_URL: "https://inherited.example.com",
      anthropic_api_key: "sk-inherited-lowercase",
      ANTHROPIC_AUTH_TOKEN: "sk-inherited-token",
      OPENAI_BASE_URL: "https://inherited-openai.example.com",
      OPENAI_API_KEY: "sk-inherited-openai",
    });
  });
});

describe("Claude 中转：--settings 与 --disallowedTools", () => {
  test("auth_token：--settings 注入同一组 env，并把 ANTHROPIC_API_KEY 置空（压住用户 settings 里的密钥）", () => {
    const { extraArgs } = buildClaudeLaunchOverride(relay({ env: { API_TIMEOUT_MS: "3000000" } }));
    expect(settingsOf(extraArgs)).toEqual({
      env: {
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_BASE_URL: "https://relay.example.com",
        ANTHROPIC_AUTH_TOKEN: "sk-relay",
        API_TIMEOUT_MS: "3000000",
      },
    });
    expect(extraArgs.slice(-2)).toEqual(["--disallowedTools", "WebSearch"]);
  });

  test("api_key：置空 ANTHROPIC_AUTH_TOKEN", () => {
    const { extraArgs } = buildClaudeLaunchOverride(relay({ authMode: "api_key" }));
    expect(settingsOf(extraArgs)?.env).toEqual({
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_BASE_URL: "https://relay.example.com",
      ANTHROPIC_API_KEY: "sk-relay",
    });
  });

  test("disallowedTools：有 baseUrl 默认 WebSearch；显式给出则照用（空数组不加参数）；无 baseUrl 不禁用", () => {
    expect(resolveDisallowedTools(relay())).toEqual(["WebSearch"]);
    expect(resolveDisallowedTools(relay({ disallowedTools: [] }))).toEqual([]);
    expect(resolveDisallowedTools(relay({ baseUrl: undefined }))).toEqual([]);
    const explicit = buildClaudeLaunchOverride(relay({ disallowedTools: ["WebSearch", "WebFetch"] }));
    expect(explicit.extraArgs.slice(-2)).toEqual(["--disallowedTools", "WebSearch,WebFetch"]);
    expect(buildClaudeLaunchOverride(relay({ disallowedTools: [] })).extraArgs).not.toContain(
      "--disallowedTools",
    );
  });

  test("没有任何中转字段时不加 --settings；command 的附加参数排在最前", () => {
    const plain = buildClaudeLaunchOverride({ id: "x", extends: "claude", label: "x" });
    expect(plain.extraArgs).toEqual([]);
    const withCommand = buildClaudeLaunchOverride(
      relay({ command: ["C:\\tools\\claude.exe", "--debug"] }),
    );
    expect(withCommand.extraArgs[0]).toBe("--debug");
    expect(withCommand.extraArgs[1]).toBe("--settings");
  });

  test("buildClaudeCliArgs 把 extraArgs 追加在固定参数之后", () => {
    const { extraArgs } = buildClaudeLaunchOverride(relay());
    const args = buildClaudeCliArgs({
      model: "glm",
      permissionMode: "default",
      resumeSessionId: "s1",
      extraArgs,
    });
    expect(args.slice(0, 2)).toEqual(["--print", "--verbose"]);
    expect(args.slice(-extraArgs.length)).toEqual(extraArgs);
    expect(args).toContain("--resume");
    // 不传 extraArgs 时参数不变
    expect(buildClaudeCliArgs({ model: null, permissionMode: "default", resumeSessionId: null })).not.toContain(
      "--settings",
    );
  });

  test("ClaudeAgentClient 把剔除后的 env 与 extraArgs 交给 claude 进程（探测进程与会话进程一致）", async () => {
    const seen: ClaudeCliOptions[] = [];
    const factory = (options: ClaudeCliOptions): ClaudeCliHandle => {
      seen.push(options);
      let finish: () => void = () => undefined;
      const done = new Promise<void>((resolve) => (finish = resolve));
      return {
        initialized: Promise.resolve({}),
        sendUserMessage: () => undefined,
        interrupt: async () => undefined,
        setModel: async () => undefined,
        setPermissionMode: async () => undefined,
        mcpStatus: async () => ({}),
        mcpReconnect: async () => undefined,
        stopTask: async () => undefined,
        getContextUsage: async () => ({}),
        close: async () => finish(),
        async *[Symbol.asyncIterator]() {
          await done;
        },
      };
    };
    const profile = relay({ authMode: "api_key" });
    const client = new ClaudeAgentClient({
      logger: createSilentLogger(),
      env: INHERITED,
      providerId: "custom:relay",
      label: profile.label,
      launch: buildClaudeLaunchOverride(profile),
      cliFactory: factory,
      resolveExecutable: async () => ({ available: true, path: "C:\\fake\\claude.exe", source: "path", version: "1" }),
    });
    expect(client.provider).toBe("custom:relay");
    const catalog = await client.fetchCatalog({ cwd: os.tmpdir() });
    expect(catalog.models.every((model) => model.provider === "custom:relay")).toBe(true);

    const session = await client.createSession({ cwd: os.tmpdir() });
    expect(session.provider).toBe("custom:relay");
    await session.startTurn("hi");
    await session.close();

    expect(seen).toHaveLength(2);
    for (const options of seen) {
      expect(options.env.ANTHROPIC_API_KEY).toBe("sk-relay");
      expect(options.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(options.env.anthropic_api_key).toBeUndefined();
      expect(options.env.ANTHROPIC_BASE_URL).toBe("https://relay.example.com");
      expect(options.env.AGENTDECK_TOKEN).toBeUndefined();
      expect(settingsOf(options.extraArgs ?? [])?.env.ANTHROPIC_API_KEY).toBe("sk-relay");
      expect(options.extraArgs?.slice(-2)).toEqual(["--disallowedTools", "WebSearch"]);
    }
  });
});

describe("Codex 中转：配置注入", () => {
  test.each([
    ["https://relay.example.com", "https://relay.example.com/v1"],
    ["https://relay.example.com/", "https://relay.example.com/v1"],
    ["https://relay.example.com/v1", "https://relay.example.com/v1"],
    ["https://relay.example.com/v1///", "https://relay.example.com/v1"],
    ["https://relay.example.com/openai/", "https://relay.example.com/openai/v1"],
  ])("normalizeOpenAiBaseUrl(%s) = %s", (input, expected) => {
    expect(normalizeOpenAiBaseUrl(input)).toBe(expected);
  });

  test("有 baseUrl 与 apiKey：model_provider + model_providers（含 env_key / requires_openai_auth）", () => {
    const override = buildCodexLaunchOverride(
      relay({ extends: "codex", baseUrl: "https://relay.example.com/", label: "我的 Codex" }),
    );
    expect(override).toEqual({
      stripEnv: ["OPENAI_BASE_URL", "OPENAI_API_KEY"],
      envOverlay: { OPENAI_API_KEY: "sk-relay" },
      threadConfig: {
        model_provider: "agentdeck-relay",
        model_providers: {
          "agentdeck-relay": {
            name: "我的 Codex",
            base_url: "https://relay.example.com/v1",
            wire_api: "responses",
            env_key: "OPENAI_API_KEY",
            requires_openai_auth: false,
          },
        },
      },
    });
  });

  test("无 apiKey 时不写 env_key（仍强制 requires_openai_auth=false）；无 baseUrl 时不注入 config；env.OPENAI_API_KEY 同样视为有密钥", () => {
    const noKey = buildCodexLaunchOverride(relay({ extends: "codex", apiKey: undefined }));
    expect(noKey.threadConfig).toEqual({
      model_provider: "agentdeck-relay",
      model_providers: {
        "agentdeck-relay": {
          name: "中转",
          base_url: "https://relay.example.com/v1",
          wire_api: "responses",
          requires_openai_auth: false,
        },
      },
    });
    expect(buildCodexLaunchOverride(relay({ extends: "codex", baseUrl: undefined })).threadConfig).toBeUndefined();
    const viaEnv = buildCodexLaunchOverride(
      relay({ extends: "codex", apiKey: undefined, env: { OPENAI_API_KEY: "sk-env" } }),
    );
    expect((viaEnv.threadConfig?.model_providers as Record<string, Record<string, unknown>>)["agentdeck-relay"]?.env_key).toBe(
      "OPENAI_API_KEY",
    );
  });

  test("applyCodexEnvOverride：剔除继承的 OPENAI_* 后叠加；不传覆盖时原样返回", () => {
    const override = buildCodexLaunchOverride(relay({ extends: "codex" }));
    const env = applyCodexEnvOverride(INHERITED, override);
    expect(env.OPENAI_API_KEY).toBe("sk-relay");
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe("https://inherited.example.com");
    expect(applyCodexEnvOverride(INHERITED, undefined)).toBe(INHERITED);
  });

  describe("config.toml / auth.json（会话级覆盖，design.md 4.7）", () => {
    // 典型 cc-switch 配置
    const CC_SWITCH_TOML = `model_provider = "custom"
model = "gpt-5-codex"
model_reasoning_effort = "high"

[model_providers.custom]
name = "custom"
base_url = "https://toml.example.com/v1"
wire_api = "responses"
requires_openai_auth = true
`;
    const codexRelay = (overrides: Partial<ProviderProfile> = {}): ProviderProfile => ({
      id: "relay",
      extends: "codex",
      label: "中转",
      ...overrides,
    });
    const entryOf = (threadConfig: Record<string, unknown> | undefined) =>
      (threadConfig?.model_providers as Record<string, Record<string, unknown>>)["agentdeck-relay"];

    test("典型 cc-switch 配置 + auth.json：条目改名、强制 requires_openai_auth=false、写 env_key，其余顶层键保留", () => {
      const override = buildCodexLaunchOverride(
        codexRelay({ codexConfig: CC_SWITCH_TOML, codexAuth: { OPENAI_API_KEY: "sk-xxx" } }),
      );
      expect(override.envOverlay).toEqual({ OPENAI_API_KEY: "sk-xxx" });
      expect(override.threadConfig).toEqual({
        model_provider: "agentdeck-relay",
        model: "gpt-5-codex",
        model_reasoning_effort: "high",
        model_providers: {
          "agentdeck-relay": {
            name: "custom",
            base_url: "https://toml.example.com/v1",
            wire_api: "responses",
            requires_openai_auth: false,
            env_key: "OPENAI_API_KEY",
          },
        },
      });
      expect(Object.keys(override.threadConfig?.model_providers as object)).toEqual(["agentdeck-relay"]);
    });

    test("表单 baseUrl 覆盖 TOML 的 base_url（补 /v1）；TOML 的 base_url 原样保留", () => {
      const viaForm = resolveCodexRelay(
        codexRelay({ codexConfig: CC_SWITCH_TOML, baseUrl: "https://form.example.com" }),
      );
      expect(entryOf(viaForm.threadConfig)?.base_url).toBe("https://form.example.com/v1");
      expect(viaForm.baseUrl).toBe("https://form.example.com/v1");
      const viaToml = resolveCodexRelay(
        codexRelay({ codexConfig: CC_SWITCH_TOML.replace("/v1", "/api") }),
      );
      expect(entryOf(viaToml.threadConfig)?.base_url).toBe("https://toml.example.com/api");
      expect(viaToml.baseUrl).toBe("https://toml.example.com/api");
    });

    test("密钥优先级：env > 表单 apiKey > auth.json；空白视为没有", () => {
      const all = codexRelay({
        codexConfig: CC_SWITCH_TOML,
        codexAuth: { OPENAI_API_KEY: "sk-auth" },
        apiKey: "sk-form",
        env: { OPENAI_API_KEY: "sk-env", OTHER: "1" },
      });
      expect(resolveCodexRelay(all).apiKey).toBe("sk-env");
      expect(buildCodexLaunchOverride(all).envOverlay).toEqual({ OPENAI_API_KEY: "sk-env", OTHER: "1" });
      expect(resolveCodexRelay({ ...all, env: undefined }).apiKey).toBe("sk-form");
      expect(resolveCodexRelay({ ...all, env: { OPENAI_API_KEY: "  " }, apiKey: "  " }).apiKey).toBe("sk-auth");
      const none = resolveCodexRelay({ ...all, env: undefined, apiKey: undefined, codexAuth: { OPENAI_API_KEY: " " } });
      expect(none.apiKey).toBeUndefined();
      expect(entryOf(none.threadConfig)).not.toHaveProperty("env_key");
      expect(deriveCodexEnv({ ...all, env: undefined })).toEqual({ OPENAI_API_KEY: "sk-form" });
    });

    test("auth.json 的其它字段（如 ChatGPT tokens）不使用", () => {
      const resolved = resolveCodexRelay(
        codexRelay({ codexConfig: CC_SWITCH_TOML, codexAuth: { tokens: { access_token: "x" }, auth_mode: "chatgpt" } }),
      );
      expect(resolved.apiKey).toBeUndefined();
      expect(JSON.stringify(resolved)).not.toContain("access_token");
    });

    test("TOML 无 model_provider 且无 baseUrl：非中转，只透传其它键（含 mcp_servers），不生成 provider", () => {
      const resolved = resolveCodexRelay(
        codexRelay({
          codexConfig: `model = "gpt-5"
model_reasoning_effort = "low"
[mcp_servers.x]
command = "x"
[model_providers.unused]
name = "u"
`,
          codexAuth: { OPENAI_API_KEY: "sk-auth" },
        }),
      );
      expect(resolved.threadConfig).toEqual({
        model: "gpt-5",
        model_reasoning_effort: "low",
        mcp_servers: { x: { command: "x" } },
      });
      expect(resolved.baseUrl).toBeUndefined();
    });

    test("TOML 无 model_provider 但有表单 baseUrl：按表单中转，其它键保留", () => {
      const resolved = resolveCodexRelay(
        codexRelay({ codexConfig: 'model = "gpt-5"', baseUrl: "https://form.example.com", apiKey: "sk-form" }),
      );
      expect(resolved.threadConfig).toEqual({
        model: "gpt-5",
        model_provider: "agentdeck-relay",
        model_providers: {
          "agentdeck-relay": {
            name: "中转",
            wire_api: "responses",
            base_url: "https://form.example.com/v1",
            requires_openai_auth: false,
            env_key: "OPENAI_API_KEY",
          },
        },
      });
    });

    test("条目自带 env_key / http_headers 时保留，不覆盖 env_key", () => {
      const resolved = resolveCodexRelay(
        codexRelay({
          codexConfig: `model_provider = "p"
[model_providers.p]
base_url = "https://x.example.com/v1"
env_key = "MY_KEY"
http_headers = { "X-A" = "1" }
`,
          apiKey: "sk-form",
        }),
      );
      expect(entryOf(resolved.threadConfig)).toEqual({
        name: "中转",
        wire_api: "responses",
        base_url: "https://x.example.com/v1",
        env_key: "MY_KEY",
        http_headers: { "X-A": "1" },
        requires_openai_auth: false,
      });
    });

    test("没有 config.toml / baseUrl / 密钥：不设 threadConfig；日期类值转字符串", () => {
      expect(buildCodexLaunchOverride(codexRelay()).threadConfig).toBeUndefined();
      expect(resolveCodexRelay(codexRelay({ codexConfig: "when = 2024-01-02T03:04:05Z" })).threadConfig).toEqual({
        when: "2024-01-02T03:04:05.000Z",
      });
    });

    test("不修改入参 profile", () => {
      const profile = codexRelay({ codexConfig: CC_SWITCH_TOML, codexAuth: { OPENAI_API_KEY: "sk-xxx" } });
      const before = structuredClone(profile);
      buildCodexLaunchOverride(profile);
      expect(profile).toEqual(before);
    });
  });

  describe("thread/start、thread/resume 带上 config（假 app-server）", () => {
    const FAKE_SERVER = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "codex",
      "fixtures",
      "fake-app-server.mjs",
    );
    let tmpDir: string;
    let logFile: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "agentdeck-codex-relay-"));
      logFile = path.join(tmpDir, "fake.log");
    });
    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    const received = () =>
      existsSync(logFile)
        ? readFileSync(logFile, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
            .filter((entry) => entry.direction === "in")
            .map((entry) => entry.msg)
        : [];

    async function waitUntil(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
      const started = Date.now();
      while (!predicate()) {
        if (Date.now() - started > timeoutMs) throw new Error("等待超时");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    test("自定义 provider id 与 config 覆盖", async () => {
      const profile = relay({ extends: "codex" });
      const override = buildCodexLaunchOverride(profile);
      const client = new CodexAgentClient({
        logger: createSilentLogger(),
        env: process.env,
        providerId: "custom:relay",
        label: profile.label,
        launch: override,
        resolveLaunch: () => ({
          command: process.execPath,
          args: [FAKE_SERVER],
          envOverlay: { FAKE_CODEX_LOG: logFile },
          source: "env",
        }),
      });
      const session = await client.createSession({ cwd: tmpDir });
      try {
        await session.startTurn("hello");
        await waitUntil(() => received().some((m) => m.method === "thread/start"));
        const start = received().find((m) => m.method === "thread/start");
        expect(start?.params.config).toEqual(override.threadConfig);
        expect(session.provider).toBe("custom:relay");
        expect(session.describePersistence()?.provider).toBe("custom:relay");
      } finally {
        await session.close();
      }

      const resumed = await client.resumeSession(
        { provider: "custom:relay", sessionId: "thr_resume" },
        { cwd: tmpDir },
      );
      try {
        const resume = received().find((m) => m.method === "thread/resume");
        expect(resume?.params.config).toEqual(override.threadConfig);
        expect(resume?.params.threadId).toBe("thr_resume");
      } finally {
        await resumed.close();
      }
    });
  });
});
