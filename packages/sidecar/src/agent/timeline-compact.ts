/**
 * 时间线压缩（design.md 4.5「持久化」）。
 *
 * 背景：子代理（Agent 工具）每推进一次，带累计 actions 摘要的整条 tool_call 就再推送一次，
 * 同一 callId 可重复数百次，使 timeline.jsonl 膨胀到数十 MB，agent.timeline 单帧过大。
 * 规则：同一 callId 的 tool_call 只留首次出现（决定卡片位置）与最新一条（内容最新、seq 最大）。
 */
import type { AgentStreamEnvelope } from "@agentdeck/protocol";

/** 取条目的 tool_call callId；不是 tool_call 时返回 undefined */
export function toolCallId(entry: AgentStreamEnvelope): string | undefined {
  const event = entry.event;
  if (event.type === "timeline" && event.item.type === "tool_call") {
    return event.item.callId;
  }
  return undefined;
}

export function compactToolCallUpdates(entries: AgentStreamEnvelope[]): {
  entries: AgentStreamEnvelope[];
  dropped: number;
} {
  const lastIndex = new Map<string, number>();
  entries.forEach((entry, index) => {
    const callId = toolCallId(entry);
    if (callId !== undefined) {
      lastIndex.set(callId, index);
    }
  });

  const seen = new Set<string>();
  const kept: AgentStreamEnvelope[] = [];
  entries.forEach((entry, index) => {
    const callId = toolCallId(entry);
    if (callId !== undefined) {
      const first = !seen.has(callId);
      seen.add(callId);
      if (!first && lastIndex.get(callId) !== index) {
        return;
      }
    }
    kept.push(entry);
  });
  return { entries: kept, dropped: entries.length - kept.length };
}
