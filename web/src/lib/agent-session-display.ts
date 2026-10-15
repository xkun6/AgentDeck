// 会话列表（侧栏 / 历史页）对 AgentSnapshot 的展示规则。
import type { AgentSnapshot, AgentStatus, ProviderInfo } from "@agentdeck/protocol";
import type { ChatSessionRuntime } from "@/stores/chat";
import { isRuntimeRunning } from "@/lib/session-activity";

const PROVIDER_FALLBACK_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  mock: "Mock",
};

export function agentProviderLabel(provider: string, providers?: ProviderInfo[] | null): string {
  return providers?.find((item) => item.id === provider)?.label
    ?? PROVIDER_FALLBACK_LABELS[provider]
    ?? (provider.startsWith("acp:") ? provider.slice(4) : provider.startsWith("custom:") ? provider.slice(7) : provider);
}

function firstUserMessage(runtime: ChatSessionRuntime | undefined): string {
  for (const message of runtime?.messages ?? []) {
    if (message.role !== "user") continue;
    for (const part of message.parts) {
      if (part.type === "text" && part.text.trim()) return part.text.trim().replace(/\s+/g, " ");
    }
  }
  return "";
}

/** 用户自定义标题 → sidecar 记录的首条消息预览（preview）→ 本地首条用户消息 → 「<Agent> 会话」。 */
export function agentDisplayTitle(
  agent: AgentSnapshot,
  runtime: ChatSessionRuntime | undefined,
  providers?: ProviderInfo[] | null,
): string {
  return agent.title?.trim()
    || agent.preview?.trim()
    || firstUserMessage(runtime)
    || `${agentProviderLabel(agent.provider, providers)} 会话`;
}

export const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  starting: "启动中",
  idle: "空闲",
  running: "运行中",
  error: "出错",
  closed: "已关闭",
  dormant: "未加载",
};

/** 显示用「进行中」：主回合在跑，或仍有运行中的子代理 / 后台任务（backgroundActive，design.md 4.4）。不用于发送 / 忙碌判断 */
export function isAgentActive(agent: Pick<AgentSnapshot, "status" | "backgroundActive">): boolean {
  return agent.status === "running" || agent.backgroundActive === true;
}

/** 显示用状态文案：进行中（含 backgroundActive）统一显示「运行中」文案 */
export function agentStatusLabel(agent: Pick<AgentSnapshot, "status" | "backgroundActive">): string {
  return isAgentActive(agent) ? AGENT_STATUS_LABELS.running : AGENT_STATUS_LABELS[agent.status];
}

export function isAgentRunning(agent: AgentSnapshot, runtime: ChatSessionRuntime | undefined): boolean {
  return isAgentActive(agent) || agent.status === "starting" || (runtime ? isRuntimeRunning(runtime) : false);
}

export function formatAgentTime(ms: number, now: Date): string {
  const d = new Date(ms);
  if (d.toDateString() === now.toDateString()) {
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
