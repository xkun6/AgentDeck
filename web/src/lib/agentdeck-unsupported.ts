// AgentDeck 没有 Hermes 后端：派生自 Hermes 的旧调用方（REST / 网关 / 已删除的 Rust 命令）
// 在 P5 统一删除之前，统一用这里的错误快速失败，避免发出注定失败的请求。

export const AGENTDECK_UNSUPPORTED_MESSAGE = "AgentDeck 暂不支持该功能";

export function agentDeckUnsupportedError(): Error {
  return new Error(AGENTDECK_UNSUPPORTED_MESSAGE);
}

export function rejectUnsupported<T = never>(): Promise<T> {
  return Promise.reject(agentDeckUnsupportedError());
}
