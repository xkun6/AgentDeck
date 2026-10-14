import type { AgentStreamEnvelope } from "@agentdeck/protocol";

/**
 * 回合起点标记（design.md 4.31）：每个回合取最早的一条——有 `user_message`（非插话）取它，
 * 没有（CLI 自发轮次等）取 `turn_started`。user_message 排在同一回合的 turn_started 之前，
 * 所以扫描时记住「已有用户消息待配对」，其后的第一个 turn_started 不再算起点。
 */
export function turnStartFlags(entries: readonly AgentStreamEnvelope[]): boolean[] {
  const flags: boolean[] = [];
  let userMessagePending = false;
  for (const entry of entries) {
    const event = entry.event;
    if (event.type === "timeline" && event.item.type === "user_message" && !event.item.steer) {
      flags.push(true);
      userMessagePending = true;
    } else if (event.type === "turn_started") {
      flags.push(!userMessagePending);
      userMessagePending = false;
    } else {
      flags.push(false);
    }
  }
  return flags;
}

/**
 * 向前分页：从 `beforeSeq`（缺省 = 末尾之后）往前取至少 `limit` 条，再继续往前扩到最近的回合起点，
 * 保证页首是完整回合。`entries` 须按 seq 升序。
 */
export function pageTimeline(
  entries: readonly AgentStreamEnvelope[],
  page: { beforeSeq?: number; limit: number },
): { entries: AgentStreamEnvelope[]; hasOlder: boolean } {
  // entries 按 seq 升序，所以 seq < beforeSeq 的是一段前缀，下标与 flags 一一对应
  let end = entries.length;
  if (page.beforeSeq !== undefined) {
    end = 0;
    while (end < entries.length && entries[end]!.seq < page.beforeSeq) {
      end += 1;
    }
  }
  let start = Math.max(0, end - page.limit);
  if (start > 0) {
    const flags = turnStartFlags(entries);
    while (start > 0 && !flags[start]) {
      start -= 1;
    }
  }
  return { entries: entries.slice(start, end), hasOlder: start > 0 };
}
