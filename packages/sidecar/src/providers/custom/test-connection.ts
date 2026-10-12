// provider.test（design.md 4.7）：只请求模型列表接口，不发起对话、不计费。
import type { ProviderProfile, ProviderTestResult } from "@agentdeck/protocol";

import { findExecutable } from "../../utils/executable-resolution/executable-resolution.js";
import {
  deriveCodexEnv,
  mergeClaudeSettings,
  normalizeOpenAiBaseUrl,
  RELAY_NO_KEY_PLACEHOLDER,
  settingsEnvOf,
} from "./launch.js";
import { collectSecrets, redactText } from "./redact.js";
import { readClaudeSettingsFile } from "./settings-file.js";

export const PROVIDER_TEST_TIMEOUT_MS = 10_000;
const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com";
const ANTHROPIC_VERSION = "2023-06-01";
const ERROR_BODY_MAX_CHARS = 200;

export interface ProviderTestDeps {
  fetch?: typeof fetch;
  timeoutMs?: number;
  findExecutable?: (name: string) => Promise<string | null>;
  now?: () => number;
}

export interface ProviderTestRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * claude / codex 的模型列表请求（URL 与请求头按 4.7 规则）。
 * claude 取合并后 settings.env 中的值：表单未填 baseUrl / apiKey 时回退到 settingsFile（`fileSettings`）/ 内联设置里的
 * ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY，鉴权头按实际取到的凭据类型决定。
 * 只使用 profile 自己提供的凭据（不读取用户 ~/.claude 与进程环境）；没有凭据（含中转占位值）就不带鉴权头。
 */
export function buildProviderTestRequest(
  profile: ProviderProfile,
  fileSettings?: Record<string, unknown>,
): ProviderTestRequest | null {
  if (profile.extends === "claude") {
    const env = settingsEnvOf(mergeClaudeSettings(profile, fileSettings));
    const base = (env.ANTHROPIC_BASE_URL || ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, "");
    const headers: Record<string, string> = { "anthropic-version": ANTHROPIC_VERSION };
    if (env.ANTHROPIC_AUTH_TOKEN && env.ANTHROPIC_AUTH_TOKEN !== RELAY_NO_KEY_PLACEHOLDER) {
      headers.authorization = `Bearer ${env.ANTHROPIC_AUTH_TOKEN}`;
    } else if (env.ANTHROPIC_API_KEY) {
      headers["x-api-key"] = env.ANTHROPIC_API_KEY;
    }
    return { url: `${base}/v1/models`, headers };
  }
  if (profile.extends === "codex") {
    const env = deriveCodexEnv(profile);
    const base = normalizeOpenAiBaseUrl(profile.baseUrl || env.OPENAI_BASE_URL || OPENAI_DEFAULT_BASE_URL);
    const headers: Record<string, string> = {};
    if (env.OPENAI_API_KEY) {
      headers.authorization = `Bearer ${env.OPENAI_API_KEY}`;
    }
    return { url: `${base}/models`, headers };
  }
  return null;
}

export async function testProviderProfile(
  profile: ProviderProfile,
  deps: ProviderTestDeps = {},
): Promise<ProviderTestResult> {
  let secrets = collectSecrets(profile);
  const now = deps.now ?? Date.now;

  if (profile.extends === "acp") {
    const command = profile.command?.[0];
    if (!command) {
      return { ok: false, error: "未填写启动命令" };
    }
    const started = now();
    const found = await (deps.findExecutable ?? ((name: string) => findExecutable(name)))(command);
    const latencyMs = now() - started;
    return found
      ? { ok: true, latencyMs }
      : { ok: false, latencyMs, error: redactText(`未找到命令「${command}」，请确认已安装并在 PATH 中`, secrets) };
  }

  let fileSettings: Record<string, unknown> | undefined;
  if (profile.extends === "claude" && profile.settingsFile) {
    try {
      fileSettings = await readClaudeSettingsFile(profile.settingsFile);
    } catch (error) {
      return { ok: false, error: redactText((error as Error).message, secrets) };
    }
    secrets = collectSecrets(profile, fileSettings);
  }

  const request = buildProviderTestRequest(profile, fileSettings);
  if (!request) {
    return { ok: false, error: "不支持测试该类型的 provider" };
  }
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? PROVIDER_TEST_TIMEOUT_MS;
  const started = now();
  let response: Response;
  try {
    response = await doFetch(request.url, {
      method: "GET",
      headers: request.headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return {
      ok: false,
      latencyMs: now() - started,
      error: redactText(describeFetchError(error, request.url, timeoutMs), secrets),
    };
  }
  const latencyMs = now() - started;
  let text = "";
  try {
    text = await response.text();
  } catch {
    // 读响应体失败不影响结论
  }
  if (!response.ok) {
    const detail = extractErrorMessage(text);
    return {
      ok: false,
      status: response.status,
      latencyMs,
      error: redactText(
        `接口返回 HTTP ${response.status}${detail ? `：${detail}` : ""}${statusHint(response.status)}`,
        secrets,
      ),
    };
  }
  const models = parseModels(text);
  return {
    ok: true,
    status: response.status,
    latencyMs,
    ...(models ? { models } : {}),
  };
}

function statusHint(status: number): string {
  if (status === 401 || status === 403) return "（请检查密钥与鉴权方式）";
  if (status === 404) return "（请检查接口地址）";
  return "";
}

/** 从 `{ data: [{ id, display_name? }] }` 解析模型列表；解析不出返回 undefined */
export function parseModels(text: string): { id: string; label: string }[] | undefined {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    return undefined;
  }
  const models: { id: string; label: string }[] = [];
  for (const entry of data) {
    const record = entry as { id?: unknown; display_name?: unknown } | null;
    if (typeof record?.id !== "string" || !record.id) continue;
    const label =
      typeof record.display_name === "string" && record.display_name ? record.display_name : record.id;
    models.push({ id: record.id, label });
  }
  return models;
}

function extractErrorMessage(text: string): string {
  let message = "";
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown } | null;
    const error = body?.error;
    if (typeof error === "string") {
      message = error;
    } else if (error && typeof (error as { message?: unknown }).message === "string") {
      message = (error as { message: string }).message;
    } else if (typeof body?.message === "string") {
      message = body.message;
    }
  } catch {
    message = text;
  }
  message = message.replace(/\s+/g, " ").trim();
  return message.length > ERROR_BODY_MAX_CHARS ? `${message.slice(0, ERROR_BODY_MAX_CHARS)}…` : message;
}

function describeFetchError(error: unknown, url: string, timeoutMs: number): string {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return `连接超时（${Math.round(timeoutMs / 1000)} 秒内无响应）：${originOf(url)}`;
  }
  const cause = (error as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  const code = typeof cause?.code === "string" ? cause.code : null;
  if (cause?.message === "bad port") {
    return `无法连接到 ${originOf(url)}：该端口被禁止访问（不安全端口），请换用其它端口`;
  }
  const reason =
    code === "ECONNREFUSED"
      ? "连接被拒绝"
      : code === "ENOTFOUND"
        ? "域名无法解析"
        : code === "ECONNRESET"
          ? "连接被重置"
          : code?.startsWith("CERT_") || code?.includes("SSL") || code?.includes("TLS")
            ? `证书 / TLS 错误（${code}）`
            : code
              ? `网络错误（${code}）`
              : "网络错误";
  return `无法连接到 ${originOf(url)}：${reason}`;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
