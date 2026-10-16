// Derived from paseo packages/server/src/server/agent/providers/codex-app-server-agent.ts (Apache-2.0); modified for AgentDeck
// 移植 normalizeOpenAICompatibleBaseUrl 与 buildCodexCustomProviderConfig 的思路；
// AgentDeck 改动：由 ProviderProfile（baseUrl / apiKey / authMode / env / settings / codexConfig / codexAuth）推导，
// Claude 额外生成 --settings（整份设置深合并）与 --disallowedTools；
// Codex 额外支持粘贴的 config.toml / auth.json（只做会话级 config 覆盖，不写 ~/.codex，design.md 4.7）。
import type { ProviderProfile } from "@agentdeck/protocol";

import type { ClaudeLaunchOverride } from "../claude/claude-agent.js";
import type { CodexLaunchOverride } from "../codex/codex-agent.js";
import { isPlainObject, parseCodexConfigToml } from "./schema.js";

/** 从继承环境中剔除的凭据变量（design.md 4.7） */
export const CLAUDE_CREDENTIAL_ENV = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
] as const;
export const CODEX_CREDENTIAL_ENV = ["OPENAI_BASE_URL", "OPENAI_API_KEY"] as const;
/** claude.ai OAuth 令牌环境变量：中转时从继承环境中剔除（design.md 4.7） */
export const CLAUDE_OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

/**
 * 中转没有任何凭据时写入 ANTHROPIC_AUTH_TOKEN 的占位值：Claude Code 2.1.296 实测，中转地址 + 两个凭据都为空时，
 * 会把用户的 claude.ai OAuth 令牌（.credentials.json 或 CLAUDE_CODE_OAUTH_TOKEN）作为 Bearer 发给中转；
 * 设了 AUTH_TOKEN 后不再使用 OAuth。provider.test 不发送该占位值。
 */
export const RELAY_NO_KEY_PLACEHOLDER = "agentdeck-no-key";

/** 三方接口不支持 Anthropic 服务端 WebSearch：设置了 baseUrl 且未显式给出 disallowedTools 时默认禁用 */
export const DEFAULT_RELAY_DISALLOWED_TOOLS = ["WebSearch"] as const;

/** Codex 配置里的 model_providers 键：加前缀，避免与用户 config.toml 已有的同名条目（含其密钥）合并 */
export function codexModelProviderKey(profileId: string): string {
  return `agentdeck-${profileId}`;
}

/** 推导出的 Claude 子进程环境：baseUrl / apiKey 映射，最后叠加 profile.env */
export function deriveClaudeEnv(profile: ProviderProfile): Record<string, string> {
  const env: Record<string, string> = {};
  if (profile.baseUrl) {
    env.ANTHROPIC_BASE_URL = profile.baseUrl;
  }
  if (profile.apiKey) {
    if ((profile.authMode ?? "auth_token") === "api_key") {
      env.ANTHROPIC_API_KEY = profile.apiKey;
    } else {
      env.ANTHROPIC_AUTH_TOKEN = profile.apiKey;
    }
  }
  return { ...env, ...profile.env };
}

/**
 * 未显式给出时：设置了 baseUrl（表单，或合并后 settings.env 中的 ANTHROPIC_BASE_URL）默认禁用 WebSearch，否则不禁用
 */
export function resolveDisallowedTools(
  profile: ProviderProfile,
  settings?: Record<string, unknown>,
): string[] {
  if (profile.disallowedTools !== undefined) {
    return [...profile.disallowedTools];
  }
  const relayed = Boolean(profile.baseUrl) || Boolean(settingsEnvOf(settings).ANTHROPIC_BASE_URL);
  return relayed ? [...DEFAULT_RELAY_DISALLOWED_TOOLS] : [];
}

/** 深合并：普通对象按键递归合并，数组与标量整体替换（overlay 胜出）；不修改入参 */
export function deepMergeSettings(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const current = result[key];
    result[key] =
      isPlainObject(current) && isPlainObject(value)
        ? deepMergeSettings(current, value)
        : structuredClone(value);
  }
  return result;
}

/** settings.env 中的字符串值（非对象 / 非字符串值忽略） */
export function settingsEnvOf(settings: Record<string, unknown> | undefined): Record<string, string> {
  const env = settings?.env;
  if (!isPlainObject(env)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

/**
 * 表单推导出的 `--settings` env：填了 apiKey 时未选用的另一个凭据变量置空，再叠加推导值与 profile.env。
 * 未填 apiKey / baseUrl 时不写对应变量，让 settings 中的值生效（中转的凭据隔离由 isolateRelayCredentials 统一处理）。
 */
function derivedSettingsEnv(profile: ProviderProfile): Record<string, string> {
  const env: Record<string, string> = {};
  if (profile.apiKey) {
    const unused =
      (profile.authMode ?? "auth_token") === "api_key" ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY";
    env[unused] = "";
  }
  return { ...env, ...deriveClaudeEnv(profile) };
}

/**
 * 合并出传给 `--settings` 的整份设置（design.md 4.7）：
 * profile.settings → 推导 env（含置空的另一个凭据）→ profile.env，最后做中转凭据隔离。
 */
export function mergeClaudeSettings(profile: ProviderProfile): Record<string, unknown> {
  let merged: Record<string, unknown> = {};
  if (profile.settings) merged = deepMergeSettings(merged, profile.settings);
  const env = derivedSettingsEnv(profile);
  if (Object.keys(env).length > 0) merged = deepMergeSettings(merged, { env });
  return isolateRelayCredentials(merged);
}

/**
 * 中转只发送该 profile 自己提供的凭据：合并后有效 ANTHROPIC_BASE_URL 非空即为中转，此时两个凭据变量都显式写入，
 * 未提供（缺省或空白）的置 ""，压住用户 settings 里的密钥；两个都没提供时 AUTH_TOKEN 写占位值，压住用户 OAuth 令牌。
 * 非中转（只换模型 / 设置、不换端点）原样返回。
 */
function isolateRelayCredentials(merged: Record<string, unknown>): Record<string, unknown> {
  const env = settingsEnvOf(merged);
  if (!env.ANTHROPIC_BASE_URL?.trim()) {
    return merged;
  }
  const provided = (key: string): string => (env[key]?.trim() ? env[key]! : "");
  const authToken = provided("ANTHROPIC_AUTH_TOKEN");
  const apiKey = provided("ANTHROPIC_API_KEY");
  return deepMergeSettings(merged, {
    env: {
      ANTHROPIC_AUTH_TOKEN: authToken || (apiKey ? "" : RELAY_NO_KEY_PLACEHOLDER),
      ANTHROPIC_API_KEY: apiKey,
    },
  });
}

/**
 * Claude 中转的启动覆盖：
 * - 进程环境：剔除继承的 ANTHROPIC_* 凭据变量（中转时还剔除 CLAUDE_CODE_OAUTH_TOKEN），再叠加推导值与 profile.env；
 * - `--settings <json>`：内联 settings 与推导 env 合并成一份 flag 级设置（flag 设置优先于用户
 *   ~/.claude/settings.json）；中转时两个凭据变量都显式写入（未提供的置空，都没有时写占位值），
 *   避免用户设置里的密钥或 OAuth 登录令牌一并发给中转；
 * - `--disallowedTools a,b`；
 * - command[1..] 作为附加参数放在最前（command[0] 由调用方用于定位可执行文件）。
 * 参数经 shell:false 直接传给真实 exe，内联 JSON 不经过 cmd.exe（design.md 5.2）。
 */
export function buildClaudeLaunchOverride(
  profile: ProviderProfile,
): Required<Pick<ClaudeLaunchOverride, "stripEnv" | "envOverlay" | "extraArgs">> {
  const envOverlay = deriveClaudeEnv(profile);
  const settings = mergeClaudeSettings(profile);

  const extraArgs = [...(profile.command?.slice(1) ?? [])];
  if (Object.keys(settings).length > 0) {
    extraArgs.push("--settings", JSON.stringify(settings));
  }
  const disallowed = resolveDisallowedTools(profile, settings);
  if (disallowed.length > 0) {
    extraArgs.push("--disallowedTools", disallowed.join(","));
  }
  // 中转时一并剔除继承的 OAuth 令牌（与占位值双重保护）；非中转可能正依赖它登录，保留（design.md 4.7）
  const relay = Boolean(settingsEnvOf(settings).ANTHROPIC_BASE_URL?.trim());
  const stripEnv = relay ? [...CLAUDE_CREDENTIAL_ENV, CLAUDE_OAUTH_TOKEN_ENV] : [...CLAUDE_CREDENTIAL_ENV];
  return { stripEnv, envOverlay, extraArgs };
}

/** OpenAI 兼容地址：去掉末尾斜杠，不以 /v1 结尾则补 /v1 */
export function normalizeOpenAiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/** 非空白字符串才算有值（空白视为未填） */
function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Codex 中转解析结果（启动与 provider.test 共用） */
export interface CodexRelayResolution {
  /** 合并进 thread/start、thread/resume 的 `config` 覆盖；没有任何配置时缺省 */
  threadConfig?: Record<string, unknown>;
  /** 生效密钥：profile.env.OPENAI_API_KEY > 表单 apiKey > codexAuth.OPENAI_API_KEY（空白视为没有） */
  apiKey?: string;
  /** 生效的中转地址：表单 baseUrl（补 /v1）> config.toml 中生效条目的 base_url（原样）；非中转或都没有时缺省 */
  baseUrl?: string;
}

/**
 * 解析 Codex 中转配置（design.md 4.7「Codex 中转的 config.toml / auth.json」）：
 * 1. 以解析后的 config.toml 为底，删除 `model_providers`（只保留 `agentdeck-<id>` 一项，避免与用户同名 provider 合并）；
 * 2. 生效条目 = `model_provider` 指向的条目（浅拷贝）；表单 baseUrl 存在时 `base_url` 以表单为准；
 *    存在条目或表单 baseUrl 即为中转：键名统一为 `agentdeck-<id>`，缺省补 name / wire_api；
 * 3. 密钥优先级 env > 表单 apiKey > auth.json（只读 OPENAI_API_KEY）；
 * 4. 中转凭据隔离：条目强制 `requires_openai_auth = false`，有密钥且条目无 `env_key` 时写 `env_key = "OPENAI_API_KEY"`。
 * 非中转时 config.toml 中的其它键原样透传（沿用用户登录）。config.toml 须已通过 schema 校验。
 */
export function resolveCodexRelay(profile: ProviderProfile): CodexRelayResolution {
  const config = profile.codexConfig !== undefined ? parseCodexConfigToml(profile.codexConfig) : {};
  const providers = config.model_providers;
  delete config.model_providers;
  const selected = typeof config.model_provider === "string" ? config.model_provider : undefined;
  const picked = selected !== undefined && isPlainObject(providers) ? providers[selected] : undefined;
  const entry = isPlainObject(picked) ? { ...picked } : undefined;

  const apiKey =
    nonBlank(profile.env?.OPENAI_API_KEY) ??
    nonBlank(profile.apiKey) ??
    nonBlank(profile.codexAuth?.OPENAI_API_KEY);

  const resolution: CodexRelayResolution = {};
  if (apiKey !== undefined) {
    resolution.apiKey = apiKey;
  }

  if (entry === undefined && !profile.baseUrl) {
    if (Object.keys(config).length > 0) {
      resolution.threadConfig = config;
    }
    return resolution;
  }

  const baseUrl = profile.baseUrl ? normalizeOpenAiBaseUrl(profile.baseUrl) : nonBlank(entry?.base_url);
  if (baseUrl !== undefined) {
    resolution.baseUrl = baseUrl;
  }
  const key = codexModelProviderKey(profile.id);
  const providerConfig: Record<string, unknown> = {
    name: profile.label,
    wire_api: "responses",
    ...entry,
    ...(profile.baseUrl ? { base_url: baseUrl } : {}),
    requires_openai_auth: false,
  };
  if (apiKey !== undefined && providerConfig.env_key === undefined) {
    providerConfig.env_key = "OPENAI_API_KEY";
  }
  resolution.threadConfig = { ...config, model_provider: key, model_providers: { [key]: providerConfig } };
  return resolution;
}

/** 推导出的 Codex 子进程环境：生效密钥（env > apiKey > auth.json）→ OPENAI_API_KEY，其余为 profile.env */
export function deriveCodexEnv(profile: ProviderProfile): Record<string, string> {
  const { apiKey } = resolveCodexRelay(profile);
  return { ...profile.env, ...(apiKey !== undefined ? { OPENAI_API_KEY: apiKey } : {}) };
}

/**
 * Codex 中转的启动覆盖：剔除继承的 OPENAI_* 凭据变量，叠加 OPENAI_API_KEY 与 profile.env；
 * config.toml / baseUrl 合成 thread/start、thread/resume 的 `config` 覆盖（见 resolveCodexRelay）：
 * 中转时 `model_provider = "agentdeck-<id>"`、`model_providers.agentdeck-<id> = { name, base_url, wire_api, env_key?, requires_openai_auth: false, ... }`。
 */
export function buildCodexLaunchOverride(profile: ProviderProfile): CodexLaunchOverride {
  const { threadConfig, apiKey } = resolveCodexRelay(profile);
  const override: CodexLaunchOverride = {
    stripEnv: [...CODEX_CREDENTIAL_ENV],
    envOverlay: { ...profile.env, ...(apiKey !== undefined ? { OPENAI_API_KEY: apiKey } : {}) },
  };
  if (threadConfig) {
    override.threadConfig = threadConfig;
  }
  return override;
}
