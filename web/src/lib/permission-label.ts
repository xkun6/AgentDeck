// 待处理审批的标签文案：按审批类型区分「提问 / 计划 / 其它」（提示条、会话列表角标、看板与面板共用）。
import type { AgentPermissionRequest } from "@agentdeck/protocol";

type PermissionKind = AgentPermissionRequest["kind"];

/** 「待审批」类标签：question → 待回答，plan → 待确认计划，其余（含缺省）→ 待审批 */
export function pendingPermissionLabel(kind?: PermissionKind): string {
  if (kind === "question") return "待回答";
  if (kind === "plan") return "待确认计划";
  return "待审批";
}

/** 「等待审批」类标签（会话状态角标） */
export function waitingPermissionLabel(kind?: PermissionKind): string {
  if (kind === "question") return "等待回答";
  if (kind === "plan") return "等待确认计划";
  return "等待审批";
}
