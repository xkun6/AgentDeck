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

/** 一页累计序列化字节上限（约 4 MiB）：远低于远程网关 16 MiB 的单帧上限，留足 JSON-RPC 外壳与余量 */
export const TIMELINE_PAGE_MAX_BYTES = 4 * 1024 * 1024;

function entryBytes(entry: AgentStreamEnvelope): number {
  return Buffer.byteLength(JSON.stringify(entry), "utf8");
}

/**
 * 向前分页：从 `beforeSeq`（缺省 = 末尾之后）往前取至少 `limit` 条，再继续往前扩到最近的回合起点，
 * 保证页首是完整回合。`entries` 须按 seq 升序。
 *
 * 为凑完整回合的回溯有硬上限：条数不超过 `limit` 的 2 倍、累计序列化字节不超过 `maxBytes`
 * （默认 {@link TIMELINE_PAGE_MAX_BYTES}）。超出时从回合中间截断（页首不是回合起点），`hasOlder` 仍为 true，
 * 调用方继续用 `beforeSeq` 向前翻即可。即使最近的一条本身就超过 `maxBytes` 也至少返回这一条，保证分页能前进。
 */
export function pageTimeline(
  entries: readonly AgentStreamEnvelope[],
  page: { beforeSeq?: number; limit: number },
  maxBytes: number = TIMELINE_PAGE_MAX_BYTES,
): { entries: AgentStreamEnvelope[]; hasOlder: boolean } {
  // entries 按 seq 升序，所以 seq < beforeSeq 的是一段前缀，下标与 flags 一一对应
  let end = entries.length;
  if (page.beforeSeq !== undefined) {
    end = 0;
    while (end < entries.length && entries[end]!.seq < page.beforeSeq) {
      end += 1;
    }
  }
  const maxCount = page.limit * 2;
  const baseStart = Math.max(0, end - page.limit);
  // 1) 基础窗口（最近 limit 条）也受字节上限约束；至少保留最近一条
  let start = end;
  let bytes = 0;
  while (start > baseStart) {
    const size = entryBytes(entries[start - 1]!);
    if (start < end && bytes + size > maxBytes) {
      return { entries: entries.slice(start, end), hasOlder: start > 0 };
    }
    bytes += size;
    start -= 1;
  }
  // 2) 补齐到回合起点，但不超过条数 / 字节硬上限（超出就停在回合中间）
  if (start > 0) {
    const flags = turnStartFlags(entries);
    while (start > 0 && !flags[start]) {
      const size = entryBytes(entries[start - 1]!);
      if (end - (start - 1) > maxCount || bytes + size > maxBytes) {
        break;
      }
      bytes += size;
      start -= 1;
    }
  }
  return { entries: entries.slice(start, end), hasOlder: start > 0 };
}
