// 全文搜索定位（design.md 4.19）：把 sidecar 的 seq 映射到时间线里的消息。
import type { ChatMessage } from "./chat-types";

/** 解析 URL 的 ?seq=；非正整数返回 null */
export function parseFocusSeq(raw: string | null | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const seq = Number(raw);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
}

/**
 * 包含该 seq 的消息：首个 seq 不大于目标的消息中最靠后的一条
 * （助手消息把一个回合内的思考 / 工具 / 文本合在一起，首个 seq 即回合开始处）。
 * 没有任何消息带 seq 或目标早于所有消息时返回 undefined。
 */
export function findMessageIdForSeq(messages: readonly ChatMessage[], seq: number): string | undefined {
  let found: { id: string; firstSeq: number } | undefined;
  for (const message of messages) {
    if (message.firstSeq === undefined || message.firstSeq > seq) continue;
    if (!found || message.firstSeq >= found.firstSeq) found = { id: message.id, firstSeq: message.firstSeq };
  }
  return found?.id;
}
