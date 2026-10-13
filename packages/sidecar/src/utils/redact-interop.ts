// 会话互通 token（design.md 4.26）脱敏：日志、诊断包、MCP 状态文本里不得出现。
const INTEROP_TOKEN_PATTERN = /adi_[0-9a-f]{16,}/g;

export const INTEROP_TOKEN_PREFIX = "adi_";

/** 把文本中的互通 token 替换为 `adi_***` */
export function redactInteropTokens(text: string): string {
  return text.replace(INTEROP_TOKEN_PATTERN, `${INTEROP_TOKEN_PREFIX}***`);
}
