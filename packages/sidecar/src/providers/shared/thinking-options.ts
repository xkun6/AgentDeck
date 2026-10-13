// 思考强度档位的通用工具（design.md 4.10）：中文标签与「下一轮生效」提示，各 provider 共用。
import type { AgentThinkingOption } from "@agentdeck/protocol";

/** 运行中切换思考强度时返回给前端的提示 */
export const THINKING_APPLIES_NEXT_TURN_NOTICE = "思考强度将在下一轮生效";

const THINKING_LABELS: Record<string, string> = {
  off: "关闭思考",
  none: "不思考",
  minimal: "极少",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最高",
  ultra: "极致",
};

/** 已知档位 id 给中文标签，未知 id 用 fallback（agent 给的名称）或原样显示 */
export function thinkingOptionLabel(id: string, fallback?: string): string {
  return THINKING_LABELS[id.toLowerCase()] ?? (fallback?.trim() || id);
}

export function makeThinkingOption(
  id: string,
  options: { name?: string; description?: string | null } = {},
): AgentThinkingOption {
  const description = options.description?.trim();
  return {
    id,
    label: thinkingOptionLabel(id, options.name),
    ...(description ? { description } : {}),
  };
}

/** 档位 id 列表 → 选项（去重，保持顺序） */
export function thinkingOptionsFromIds(ids: readonly string[]): AgentThinkingOption[] {
  return Array.from(new Set(ids), (id) => makeThinkingOption(id));
}

/** null / 空串 / `default` 表示跟随 CLI 设置 */
export function normalizeThinkingOptionId(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed && trimmed !== "default" ? trimmed : null;
}
