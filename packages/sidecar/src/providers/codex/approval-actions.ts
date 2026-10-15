// Codex 审批请求的 actions 生成（AgentDeck 原创，design.md 5.3）。
// 字段以本机 codex-cli 0.162.1 的协议为准：
// - item/commandExecution/requestApproval 的 decision：accept / acceptForSession /
//   { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } } /
//   { applyNetworkPolicyAmendment: { network_policy_amendment: { host, action } } } / decline / cancel；
//   params 的 availableDecisions（实验 API）列出可呈现的决定，缺省时按旧行为处理；
// - item/fileChange/requestApproval 的 decision：accept / acceptForSession / decline / cancel；
// - 旧版 execCommandApproval / applyPatchApproval 的 ReviewDecision：approved / approved_for_session / denied / abort。
// 每个 action 的 id 对应一个 decision 值，应答时按 selectedActionId 取回。
import type { AgentPermissionAction } from "@agentdeck/protocol";

export const ALLOW_SESSION_ID = "allow_session";
export const ALLOW_PROJECT_ID = "allow_project";

export interface CodexApprovalActions {
  actions: AgentPermissionAction[];
  /** actionId → 要回给 Codex 的 decision 值；旧版的 decline 为 undefined（denied 要带理由，应答时构造） */
  decisions: Map<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0)
    ? (value as string[])
    : null;
}

function execPolicyAction(prefix: string[]): AgentPermissionAction {
  return {
    id: ALLOW_PROJECT_ID,
    label: "永久允许",
    behavior: "allow",
    persist: "permanent",
    description: `以后允许以 \`${prefix.join(" ")}\` 开头的命令（写入 Codex 执行策略）`,
  };
}

function networkAction(host: string, action: unknown): AgentPermissionAction | null {
  if (action === "allow") {
    return {
      id: `network_allow:${host}`,
      label: `始终允许访问 ${host}`,
      behavior: "allow",
      persist: "permanent",
      description: `写入 Codex 网络策略：以后允许访问 ${host}`,
    };
  }
  if (action === "deny") {
    return {
      id: `network_deny:${host}`,
      label: `始终禁止访问 ${host}`,
      behavior: "deny",
      description: `写入 Codex 网络策略：以后禁止访问 ${host}`,
    };
  }
  return null;
}

/** 展示顺序：先「允许一次 / 拒绝」，再各种「始终」，最后「拒绝并中断」 */
const RANK: Record<string, number> = { accept: 0, decline: 1, session: 2, execpolicy: 3, network: 4, cancel: 5 };

interface Entry {
  rank: number;
  action: AgentPermissionAction;
  decision: unknown;
}

/**
 * 命令审批：有 availableDecisions 时只呈现其中列出的决定，没有则 accept / acceptForSession / decline / cancel，
 * 且 params 带 proposedExecpolicyAmendment 时补一项「永久允许」。
 */
export function commandApprovalActions(params: Record<string, unknown> | null): CodexApprovalActions {
  const proposed = stringArray(params?.proposedExecpolicyAmendment ?? params?.proposed_execpolicy_amendment);
  const fallback: unknown[] = [
    "accept",
    "acceptForSession",
    ...(proposed ? [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: proposed } }] : []),
    "decline",
    "cancel",
  ];
  return fromDecisions(listedDecisions(params), fallback, "命令");
}

/** 文件改动审批：accept / acceptForSession / decline / cancel（availableDecisions 若出现同样只呈现其中列出的） */
export function fileChangeApprovalActions(params: Record<string, unknown> | null): CodexApprovalActions {
  return fromDecisions(listedDecisions(params), ["accept", "acceptForSession", "decline", "cancel"], "文件改动");
}

function listedDecisions(params: Record<string, unknown> | null): unknown[] | null {
  const listed = params?.availableDecisions ?? params?.available_decisions;
  return Array.isArray(listed) && listed.length > 0 ? listed : null;
}

/** 列出的决定一个都认不出时退回默认集合，保证卡片总有按钮 */
function fromDecisions(listed: unknown[] | null, fallback: unknown[], subject: "命令" | "文件改动") {
  const toEntries = (decisions: unknown[]) => decisions.flatMap((decision) => entryFor(decision, subject) ?? []);
  const entries = listed ? toEntries(listed) : [];
  return assemble(entries.length > 0 ? entries : toEntries(fallback));
}

/** 旧版 execCommandApproval / applyPatchApproval：approved / approved_for_session / denied / abort */
export function legacyApprovalActions(subject: "命令" | "文件改动"): CodexApprovalActions {
  return assemble(
    (["accept", "acceptForSession", "decline", "cancel"] as const).flatMap((decision) => {
      const entry = entryFor(decision, subject);
      if (!entry) return [];
      // decline 没有固定的决定值（denied 要带理由），留空由应答时构造
      const legacy: Record<string, unknown> = {
        accept: "approved",
        acceptForSession: "approved_for_session",
        decline: undefined,
        cancel: "abort",
      };
      return [{ ...entry, decision: legacy[decision] }];
    }),
  );
}

function entryFor(decision: unknown, subject: "命令" | "文件改动"): Entry | null {
  if (decision === "accept") {
    return { rank: RANK.accept!, action: { id: "accept", label: "允许", behavior: "allow" }, decision };
  }
  if (decision === "decline") {
    return { rank: RANK.decline!, action: { id: "decline", label: "拒绝", behavior: "deny" }, decision };
  }
  if (decision === "cancel") {
    return {
      rank: RANK.cancel!,
      action: { id: "cancel", label: "拒绝并中断本轮", behavior: "deny" },
      decision,
    };
  }
  if (decision === "acceptForSession") {
    return {
      rank: RANK.session!,
      action: {
        id: ALLOW_SESSION_ID,
        label: "本会话始终允许",
        behavior: "allow",
        persist: "session",
        description: subject === "命令" ? "本会话内同类命令不再询问" : "本会话内对这些文件的修改不再询问",
      },
      decision,
    };
  }
  if (!isRecord(decision)) return null;
  const amendment = decision.acceptWithExecpolicyAmendment;
  if (isRecord(amendment)) {
    const prefix = stringArray(amendment.execpolicy_amendment);
    return prefix
      ? { rank: RANK.execpolicy!, action: execPolicyAction(prefix), decision }
      : null;
  }
  const network = decision.applyNetworkPolicyAmendment;
  if (isRecord(network) && isRecord(network.network_policy_amendment)) {
    const { host, action } = network.network_policy_amendment;
    if (typeof host !== "string" || !host) return null;
    const mapped = networkAction(host, action);
    return mapped ? { rank: RANK.network!, action: mapped, decision } : null;
  }
  return null;
}

function assemble(entries: Entry[]): CodexApprovalActions {
  const seen = new Set<string>();
  const unique = entries.filter((entry) => {
    if (seen.has(entry.action.id)) return false;
    seen.add(entry.action.id);
    return true;
  });
  // 有「始终允许」变体时，accept 的标签要明确是「一次」
  const hasPersistent = unique.some((entry) => entry.action.behavior === "allow" && entry.action.persist);
  const sorted = unique
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.rank - b.entry.rank || a.index - b.index)
    .map(({ entry }) => entry);
  const decisions = new Map<string, unknown>();
  const actions = sorted.map((entry) => {
    decisions.set(entry.action.id, entry.decision);
    return entry.action.id === "accept" && hasPersistent
      ? { ...entry.action, label: "允许一次" }
      : { ...entry.action };
  });
  return { actions, decisions };
}
