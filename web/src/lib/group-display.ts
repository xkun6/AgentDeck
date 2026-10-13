// 并行协作组（design.md 4.27）在前端的展示与表单规则：状态文案、新建表单校验与入参构造。纯函数，便于 vitest 覆盖。
import type {
  AgentGroup,
  AgentGroupChairMode,
  AgentGroupStatus,
  AgentUIMessage,
  GroupCreateParams,
} from "@agentdeck/protocol";
import type { AgentSelection } from "@/lib/agent-selection";

export const GROUP_MEMBERS_MIN = 2;
export const GROUP_MEMBERS_MAX = 6;

export const GROUP_STATUS_LABELS: Record<AgentGroupStatus, string> = {
  running: "成员执行中",
  chairing: "汇总中",
  done: "已完成",
  failed: "汇总失败",
};

export const CHAIR_MODE_LABELS: Record<AgentGroupChairMode, string> = {
  synthesize: "综合",
  review: "评审",
};

export const NOT_GIT_REPO_MESSAGE = "当前工作目录不是 git 仓库，无法为每个成员创建独立 worktree";

export interface GroupFormState {
  prompt: string;
  cwd: string;
  members: AgentSelection[];
  /** 每个成员独立 worktree */
  perMemberWorktree: boolean;
  /** "none" = 不汇总 */
  chairMode: "none" | AgentGroupChairMode;
  chair: AgentSelection;
}

export interface GroupFormErrors {
  prompt?: string;
  cwd?: string;
  members?: string;
  worktree?: string;
  chair?: string;
}

export interface GroupFormContext {
  /** cwd 是否位于 git 仓库内（桌面端 git 桥不可用时为 false） */
  isGitRepo: boolean;
}

export function validateGroupForm(form: GroupFormState, context: GroupFormContext): GroupFormErrors {
  const errors: GroupFormErrors = {};
  if (!form.prompt.trim()) errors.prompt = "请输入要并行执行的任务";
  if (!form.cwd.trim()) errors.cwd = "请先选择工作目录";
  if (form.members.length < GROUP_MEMBERS_MIN || form.members.length > GROUP_MEMBERS_MAX) {
    errors.members = `成员数需为 ${GROUP_MEMBERS_MIN}–${GROUP_MEMBERS_MAX} 个`;
  } else if (form.members.some((member) => !member.provider)) {
    errors.members = "每个成员都需要选择一个可用的 Agent";
  }
  if (form.perMemberWorktree && !context.isGitRepo) errors.worktree = NOT_GIT_REPO_MESSAGE;
  if (form.chairMode !== "none" && !form.chair.provider) errors.chair = "请选择汇总 Agent";
  return errors;
}

/** 表单已通过 validateGroupForm 后构造 group.create 入参。 */
export function buildGroupCreateParams(form: GroupFormState): GroupCreateParams {
  return {
    prompt: form.prompt.trim(),
    cwd: form.cwd.trim(),
    members: form.members.map((member) => ({
      provider: member.provider!,
      ...(member.model ? { model: member.model } : {}),
      ...(member.modeId ? { modeId: member.modeId } : {}),
      ...(member.thinkingOptionId ? { thinkingOptionId: member.thinkingOptionId } : {}),
    })),
    worktree: form.perMemberWorktree ? "per-member" : "none",
    ...(form.chairMode !== "none"
      ? {
          chair: {
            provider: form.chair.provider!,
            ...(form.chair.model ? { model: form.chair.model } : {}),
            mode: form.chairMode,
          },
        }
      : {}),
  };
}

/** 会话里最后一条助手消息的文本（汇总结果区用）；没有则为空串。 */
export function lastAssistantMessageText(messages: AgentUIMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "assistant") continue;
    const text = message.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim();
    if (text) return text;
  }
  return "";
}

/** 协作组的成员会话 id（含汇总会话），用于侧栏判断归属。 */
export function groupAgentIds(group: AgentGroup): string[] {
  return [...group.members.map((member) => member.agentId), ...(group.chair?.agentId ? [group.chair.agentId] : [])];
}
