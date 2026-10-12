// 自定义 provider 的日志 / 错误脱敏（design.md 4.7：日志与错误信息中不得出现 apiKey、env 与 settings.env 的值）。
import { format } from "node:util";

import type { AgentStreamEvent, ProviderProfile } from "@agentdeck/protocol";

import type { Logger } from "../../logger.js";
import { settingsEnvOf } from "./launch.js";

export const REDACTED = "***";
/** env 中过短的值（如 "1"、"true"）不当作机密替换，否则会把日志改得面目全非 */
const MIN_ENV_SECRET_LENGTH = 6;

/**
 * profile 中需要脱敏的值：apiKey、env 的值与 settings.env 的字符串值（长度足够的）；
 * `fileSettings` 为读到的 settingsFile 内容，其 env 值同样处理。
 */
export function collectSecrets(
  profile: Pick<ProviderProfile, "apiKey" | "env" | "settings">,
  fileSettings?: Record<string, unknown>,
): string[] {
  const secrets = new Set<string>();
  if (profile.apiKey) {
    secrets.add(profile.apiKey);
  }
  const envValues = [
    ...Object.values(profile.env ?? {}),
    ...Object.values(settingsEnvOf(profile.settings)),
    ...Object.values(settingsEnvOf(fileSettings)),
  ];
  for (const value of envValues) {
    if (value.length >= MIN_ENV_SECRET_LENGTH) {
      secrets.add(value);
    }
  }
  return sortSecrets(secrets);
}

/** 长的先替换，避免短值是长值的一部分时只替换掉一半 */
function sortSecrets(secrets: Iterable<string>): string[] {
  return Array.from(new Set(secrets)).sort((a, b) => b.length - a.length);
}

/**
 * 把新读到的机密并入已有列表（原地修改，保持长者优先）：settingsFile 每次启动时读取，
 * 其 env 值要追加到已交给 logger / 会话代理的同一个数组里。
 */
export function addSecrets(target: string[], more: readonly string[]): void {
  if (more.every((secret) => target.includes(secret))) {
    return;
  }
  const next = sortSecrets([...target, ...more]);
  target.splice(0, target.length, ...next);
}

export function redactText(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret && result.includes(secret)) {
      result = result.split(secret).join(REDACTED);
    }
  }
  return result;
}

export function redactError(error: unknown, secrets: readonly string[]): unknown {
  if (secrets.length === 0) {
    return error;
  }
  if (error instanceof Error) {
    const message = redactText(error.message, secrets);
    if (message !== error.message) {
      error.message = message;
    }
    if (error.stack) {
      error.stack = redactText(error.stack, secrets);
    }
    return error;
  }
  return typeof error === "string" ? redactText(error, secrets) : error;
}

/**
 * 包一层 logger：先按 util.format 拼好整行再脱敏。`secrets` 按引用持有（之后追加的机密同样生效），
 * `growable` 为 false 且当前没有机密时直接返回原 logger。
 */
export function createRedactingLogger(base: Logger, secrets: readonly string[], growable = false): Logger {
  if (secrets.length === 0 && !growable) {
    return base;
  }
  const wrap =
    (write: (message: string, ...args: unknown[]) => void) =>
    (message: string, ...args: unknown[]) =>
      write("%s", redactText(format(message, ...args), secrets));
  return {
    debug: wrap(base.debug.bind(base)),
    info: wrap(base.info.bind(base)),
    warn: wrap(base.warn.bind(base)),
    error: wrap(base.error.bind(base)),
    close: () => base.close(),
  };
}

/** 会话事件中会展示给用户 / 落盘的错误文本脱敏 */
export function redactEvent(event: AgentStreamEvent, secrets: readonly string[]): AgentStreamEvent {
  if (secrets.length === 0) {
    return event;
  }
  if (event.type === "turn_failed") {
    return { ...event, error: redactText(event.error, secrets) };
  }
  if (event.type === "timeline" && event.item.type === "error") {
    return { ...event, item: { ...event.item, message: redactText(event.item.message, secrets) } };
  }
  return event;
}
