// Derived from paseo packages/server/src/server/agent/providers/codex-app-server-agent.ts (Apache-2.0); modified for AgentDeck
// 移植 normalizeOpenAICompatibleBaseUrl 与 buildCodexCustomProviderConfig 的思路；
// AgentDeck 改动：由 ProviderProfile（baseUrl / apiKey / authMode / env）推导，Claude 额外生成 --settings 与 --disallowedTools（design.md 4.7）。
import type { ProviderProfile } from "@agentdeck/protocol";

import type { ClaudeLaunchOverride } from "../claude/claude-agent.js";
import type { CodexLaunchOverride } from "../codex/codex-agent.js";

/** 从继承环境中剔除的凭据变量（design.md 4.7） */
export const CLAUDE_CREDENTIAL_ENV = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
] as const;
export const CODEX_CREDENTIAL_ENV = ["OPENAI_BASE_URL", "OPENAI_API_KEY"] as const;

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

/** 未显式给出时：设置了 baseUrl 默认禁用 WebSearch，否则不禁用 */
export function resolveDisallowedTools(profile: ProviderProfile): string[] {
  if (profile.disallowedTools !== undefined) {
    return [...profile.disallowedTools];
  }
  return profile.baseUrl ? [...DEFAULT_RELAY_DISALLOWED_TOOLS] : [];
}

/**
 * Claude 中转的启动覆盖：
 * - 进程环境：剔除继承的 ANTHROPIC_* 凭据变量，再叠加推导值与 profile.env；
 * - `--settings <json>`：以 flag 级设置注入同一组 env（flag 设置优先于用户 ~/.claude/settings.json 的 env），
 *   并把未选用的另一个凭据变量置空，避免用户设置里的密钥一并发给中转；
 * - `--disallowedTools a,b`；
 * - command[1..] 作为附加参数放在最前（command[0] 由调用方用于定位可执行文件）。
 * 参数经 shell:false 直接传给真实 exe，内联 JSON 不经过 cmd.exe（design.md 5.2）。
 */
export function buildClaudeLaunchOverride(profile: ProviderProfile): Required<ClaudeLaunchOverride> {
  const envOverlay = deriveClaudeEnv(profile);
  const settingsEnv: Record<string, string> = {};
  if (profile.apiKey) {
    const unused =
      (profile.authMode ?? "auth_token") === "api_key" ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY";
    settingsEnv[unused] = "";
  }
  Object.assign(settingsEnv, envOverlay);

  const extraArgs = [...(profile.command?.slice(1) ?? [])];
  if (Object.keys(settingsEnv).length > 0) {
    extraArgs.push("--settings", JSON.stringify({ env: settingsEnv }));
  }
  const disallowed = resolveDisallowedTools(profile);
  if (disallowed.length > 0) {
    extraArgs.push("--disallowedTools", disallowed.join(","));
  }
  return { stripEnv: [...CLAUDE_CREDENTIAL_ENV], envOverlay, extraArgs };
}

/** OpenAI 兼容地址：去掉末尾斜杠，不以 /v1 结尾则补 /v1 */
export function normalizeOpenAiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/** 推导出的 Codex 子进程环境：apiKey → OPENAI_API_KEY，最后叠加 profile.env */
export function deriveCodexEnv(profile: ProviderProfile): Record<string, string> {
  return { ...(profile.apiKey ? { OPENAI_API_KEY: profile.apiKey } : {}), ...profile.env };
}

/**
 * Codex 中转的启动覆盖：剔除继承的 OPENAI_* 凭据变量，叠加 OPENAI_API_KEY 与 profile.env；
 * baseUrl 存在时生成 thread/start、thread/resume 的 `config` 覆盖：
 * `model_provider = "agentdeck-<id>"`、`model_providers.agentdeck-<id> = { name, base_url, wire_api: "responses", env_key?, requires_openai_auth? }`。
 */
export function buildCodexLaunchOverride(profile: ProviderProfile): CodexLaunchOverride {
  const envOverlay = deriveCodexEnv(profile);
  const override: CodexLaunchOverride = { stripEnv: [...CODEX_CREDENTIAL_ENV], envOverlay };
  if (profile.baseUrl) {
    const key = codexModelProviderKey(profile.id);
    const providerConfig: Record<string, unknown> = {
      name: profile.label,
      base_url: normalizeOpenAiBaseUrl(profile.baseUrl),
      wire_api: "responses",
    };
    if (envOverlay.OPENAI_API_KEY?.trim()) {
      providerConfig.env_key = "OPENAI_API_KEY";
      providerConfig.requires_openai_auth = false;
    }
    override.threadConfig = { model_provider: key, model_providers: { [key]: providerConfig } };
  }
  return override;
}
