// Derived from paseo packages/server/src/server/agent/providers/claude/subagents/observation.ts (Apache-2.0); modified for AgentDeck
// 改动：类型换成 AgentDeck 的 ProviderSubagentInputEvent；timestamp 为毫秒时间戳。
import type { AgentTimelineItem, ProviderSubagentStatus } from "@agentdeck/protocol";

import type { ProviderSubagentInputEvent } from "../../../agent/types.js";

/**
 * provider 观察到的关于某个子代理的一条事实。live source 把 CLI 的 task 协议翻译成观察，
 * Claude 专属的展示信息在越过这一层之前已经压缩成 subtitle。
 */
export type SubagentObservation =
  | {
      /** 子代理存在，以及它被派去做什么 */
      kind: "declared";
      id: string;
      /** 子代理类型（如 Explore），同一批并发子代理相同 */
      title?: string;
      /** 交给它的任务，区分兄弟子代理 */
      description?: string;
      toolCallId?: string;
      /** 派出它的上级 provider 子代理；缺省表示父会话的直接子代理 */
      parentSubagentId?: string;
      timestamp?: number;
    }
  | { kind: "status"; id: string; status: ProviderSubagentStatus; timestamp?: number }
  /** provider 给出的完整次级标签，前端原样显示 */
  | { kind: "subtitle"; id: string; subtitle: string; timestamp?: number }
  | { kind: "timeline"; id: string; item: AgentTimelineItem; timestamp?: number };

/**
 * 观察 → store 事件。纯函数、无状态：部分 upsert 之间的累积由 store 的 sticky 合并负责
 * （省略字段保留、显式 null 清空），所以 status 观察可以只带 status 而不抹掉 title。
 */
export function foldSubagentObservations(
  observations: readonly SubagentObservation[],
): ProviderSubagentInputEvent[] {
  const events: ProviderSubagentInputEvent[] = [];
  for (const observation of observations) {
    const timestamp = observation.timestamp !== undefined ? { timestamp: observation.timestamp } : {};
    switch (observation.kind) {
      case "timeline":
        events.push({ type: "timeline", id: observation.id, item: observation.item, ...timestamp });
        break;
      case "subtitle":
        events.push({ type: "upsert", id: observation.id, subtitle: observation.subtitle, ...timestamp });
        break;
      case "status":
        events.push({ type: "upsert", id: observation.id, status: observation.status, ...timestamp });
        break;
      case "declared":
        // 声明即运行中；终态由单独的 status 观察给出
        events.push({
          type: "upsert",
          id: observation.id,
          status: "running",
          ...(observation.title === undefined ? {} : { title: observation.title }),
          ...(observation.description === undefined ? {} : { description: observation.description }),
          ...(observation.toolCallId === undefined ? {} : { toolCallId: observation.toolCallId }),
          ...(observation.parentSubagentId === undefined
            ? {}
            : { parentSubagentId: observation.parentSubagentId }),
          ...timestamp,
        });
        break;
    }
  }
  return events;
}
