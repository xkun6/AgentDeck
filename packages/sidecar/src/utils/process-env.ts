// 子进程环境变量：替代 paseo server/paseo-env.ts 的 createExternalCommandProcessEnv 精简实现。
// 复制基础 env 并叠加 overlay，然后剔除 sidecar 内部变量（AGENTDECK_*，含 WS 鉴权 token）与值为 undefined 的键，
// 避免把 token 等内部信息泄露给外部 Agent 进程。

export type ProcessEnvRecord = Record<string, string | undefined>;
export type ExternalProcessEnv = NodeJS.ProcessEnv & Record<string, string>;

const INTERNAL_ENV_PREFIX = "AGENTDECK_";

export function isInternalEnvKey(key: string): boolean {
  return key.toUpperCase().startsWith(INTERNAL_ENV_PREFIX);
}

export function createExternalProcessEnv(
  baseEnv: ProcessEnvRecord,
  ...overlays: ProcessEnvRecord[]
): ExternalProcessEnv {
  const sanitized: ProcessEnvRecord = Object.assign({}, baseEnv, ...overlays);
  for (const [key, value] of Object.entries(sanitized)) {
    if (value === undefined || isInternalEnvKey(key)) {
      delete sanitized[key];
    }
  }
  return sanitized as ExternalProcessEnv;
}

export function createExternalCommandProcessEnv(
  _command: string,
  baseEnv: ProcessEnvRecord,
  ...overlays: ProcessEnvRecord[]
): ExternalProcessEnv {
  return createExternalProcessEnv(baseEnv, ...overlays);
}
