// Claude can_use_tool 的 permission_suggestions → 「始终允许」两档动作（AgentDeck 原创，design.md 5.3）。
// - allow_session「本会话始终允许」：建议的 destination 全部改写成 "session"（只在内存里生效，不写盘）；
// - allow_project「永久允许」：规则 / 目录类改写成 "localSettings"（写 `<cwd>/.claude/settings.local.json`，
//   不进版本库）；setMode 类保持 "session"，bypassPermissions 不放进永久档。
// 只处理 addRules(allow) / setMode / addDirectories；replaceRules / removeRules 等不属于「允许」语义，丢弃。
import type { AgentPermissionAction } from "@agentdeck/protocol";

import type { ClaudePermissionRule, ClaudePermissionUpdate } from "./stream-json-types.js";

export const ALLOW_SESSION_ACTION_ID = "allow_session";
export const ALLOW_PROJECT_ACTION_ID = "allow_project";

const MODE_LABELS: Record<string, string> = {
  default: "逐项审批",
  acceptEdits: "自动接受编辑",
  auto: "自动模式",
  plan: "计划模式",
  bypassPermissions: "跳过所有审批",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRules(raw: unknown): ClaudePermissionRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: ClaudePermissionRule[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.toolName !== "string" || !item.toolName) continue;
    rules.push({
      toolName: item.toolName,
      ...(typeof item.ruleContent === "string" && item.ruleContent ? { ruleContent: item.ruleContent } : {}),
    });
  }
  return rules;
}

/** 宽松解析 CLI 的 permission_suggestions：只保留 addRules(allow) / setMode / addDirectories，形状不对的跳过 */
export function parsePermissionSuggestions(raw: unknown): ClaudePermissionUpdate[] {
  if (!Array.isArray(raw)) return [];
  const updates: ClaudePermissionUpdate[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    if (item.type === "addRules" && item.behavior === "allow") {
      const rules = parseRules(item.rules);
      if (rules.length > 0) {
        updates.push({ type: "addRules", rules, behavior: "allow", destination: "session" });
      }
    } else if (item.type === "setMode" && typeof item.mode === "string" && item.mode) {
      updates.push({ type: "setMode", mode: item.mode, destination: "session" });
    } else if (item.type === "addDirectories" && Array.isArray(item.directories)) {
      const directories = item.directories.filter((dir): dir is string => typeof dir === "string" && dir.length > 0);
      if (directories.length > 0) {
        updates.push({ type: "addDirectories", directories, destination: "session" });
      }
    }
  }
  return updates;
}

/** 本会话档：全部落到 session */
export function sessionUpdates(suggestions: readonly ClaudePermissionUpdate[]): ClaudePermissionUpdate[] {
  return suggestions.map((update) => ({ ...update, destination: "session" }));
}

/**
 * 永久档：规则 / 目录写入 localSettings，setMode 保持 session，bypassPermissions 排除。
 * 没有任何可持久化的规则 / 目录时返回空数组（仅有 setMode 的建议不提供「永久」）。
 */
export function projectUpdates(suggestions: readonly ClaudePermissionUpdate[]): ClaudePermissionUpdate[] {
  const updates: ClaudePermissionUpdate[] = [];
  let persistent = false;
  for (const update of suggestions) {
    if (update.type === "setMode") {
      if (update.mode !== "bypassPermissions") {
        updates.push({ ...update, destination: "session" });
      }
      continue;
    }
    persistent = true;
    updates.push({ ...update, destination: "localSettings" });
  }
  return persistent ? updates : [];
}

/** 规则的简短描述，如 `Bash(git status)`；目录 `目录 /a`；模式 `切换为「自动接受编辑」` */
export function describePermissionUpdates(updates: readonly ClaudePermissionUpdate[]): string {
  const parts: string[] = [];
  for (const update of updates) {
    if (update.type === "addRules") {
      for (const rule of update.rules) {
        parts.push(rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName);
      }
    } else if (update.type === "addDirectories") {
      parts.push(`目录 ${update.directories.join("、")}`);
    } else if (update.type === "setMode") {
      parts.push(`切换为「${MODE_LABELS[update.mode] ?? update.mode}」模式`);
    }
  }
  return parts.join("；");
}

/** 回传的更新里最后一条 setMode 的目标模式（用于同步本地 mode 状态） */
export function modeFromUpdates(updates: readonly ClaudePermissionUpdate[]): string | null {
  let mode: string | null = null;
  for (const update of updates) {
    if (update.type === "setMode") mode = update.mode;
  }
  return mode;
}

/** 按建议生成要追加的「始终允许」动作；没有建议时为空 */
export function alwaysAllowActions(suggestions: readonly ClaudePermissionUpdate[]): AgentPermissionAction[] {
  const actions: AgentPermissionAction[] = [];
  const session = sessionUpdates(suggestions);
  if (session.length > 0) {
    actions.push({
      id: ALLOW_SESSION_ACTION_ID,
      label: "本会话始终允许",
      behavior: "allow",
      persist: "session",
      description: `仅本会话有效，不写入文件：${describePermissionUpdates(session)}`,
    });
  }
  const project = projectUpdates(suggestions);
  if (project.length > 0) {
    actions.push({
      id: ALLOW_PROJECT_ACTION_ID,
      label: "永久允许",
      behavior: "allow",
      persist: "permanent",
      description: `写入项目的 .claude/settings.local.json：${describePermissionUpdates(project)}`,
    });
  }
  return actions;
}

/** 点了某个「始终允许」动作时要回传的 updatedPermissions；不是这两个动作返回 null */
export function updatesForAction(
  actionId: string | undefined,
  suggestions: readonly ClaudePermissionUpdate[],
): ClaudePermissionUpdate[] | null {
  if (actionId === ALLOW_SESSION_ACTION_ID) {
    const updates = sessionUpdates(suggestions);
    return updates.length > 0 ? updates : null;
  }
  if (actionId === ALLOW_PROJECT_ACTION_ID) {
    const updates = projectUpdates(suggestions);
    return updates.length > 0 ? updates : null;
  }
  return null;
}
