/**
 * 时间线项大小限制（design.md 5.3「时间线大小限制」）。
 *
 * 背景：子代理大量读取截图时，base64 图片经 stream-json 流入 sidecar，未知工具的 `tool_use_result`
 * 会原样进入 `unknown` detail，写进内存、广播、`timeline.jsonl`，造成内存与磁盘膨胀。
 * 参照 paseo `limitAgentTimelineItemContent`（TOOL_CALL_CONTENT_MAX_LENGTH = 64 * 1024）。
 */
import type { AgentTimelineItem } from "@agentdeck/protocol";

/** 一个时间线项里所有字符串合计的字符预算（约 64 KB） */
export const TIMELINE_ITEM_TEXT_BUDGET = 64 * 1024;
/** 预算用尽后，每个字符串仍至少保留的字符数 */
const MIN_FIELD_CHARS = 1024;
const MAX_DEPTH = 12;
/** 判定「字符串字段像图片数据」的最小长度 */
const IMAGE_DATA_MIN_CHARS = 1024;

const DATA_IMAGE_PREFIX = /^data:image\/[a-z0-9.+-]+;base64,/i;
const IMAGE_MIME = /^image\//i;

/** 图片占位文本；`base64Chars` 为 base64 数据的字符数，按 ×3/4 估算原始大小 */
export function imagePlaceholder(base64Chars: number): string {
  const kb = Math.max(1, Math.ceil((base64Chars * 3) / 4 / 1024));
  return `[图片 约 ${kb} KB，已省略]`;
}

interface LimitState {
  remaining: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 对象（含一两层嵌套）里最长的字符串长度，用来估算图片数据大小 */
function longestString(value: unknown, depth = 0): number {
  if (typeof value === "string") return value.length;
  if (depth >= 3 || !isRecord(value)) return 0;
  let longest = 0;
  for (const child of Object.values(value)) {
    longest = Math.max(longest, longestString(child, depth + 1));
  }
  return longest;
}

function isImageBlock(value: Record<string, unknown>): boolean {
  if (value.type === "image") return true;
  const source = value.source;
  if (isRecord(source) && source.type === "base64") return true;
  for (const mimeKey of ["mimeType", "media_type", "mime_type"]) {
    const mime = value[mimeKey];
    if (typeof mime === "string" && IMAGE_MIME.test(mime)) {
      for (const dataKey of ["data", "base64"]) {
        const data = value[dataKey];
        if (typeof data === "string" && data.length >= IMAGE_DATA_MIN_CHARS) return true;
      }
    }
  }
  return false;
}

function limitString(text: string, state: LimitState): string {
  const allowed = Math.max(state.remaining, MIN_FIELD_CHARS);
  if (text.length <= allowed) {
    state.remaining = Math.max(0, state.remaining - text.length);
    return text;
  }
  let end = allowed;
  // 不要把代理对（emoji 等）从中间截开
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  state.remaining = Math.max(0, state.remaining - allowed);
  return `${text.slice(0, end)}…[已截断 ${text.length - end} 字符]`;
}

function limitValue(value: unknown, state: LimitState, depth: number): unknown {
  if (typeof value === "string") {
    if (value.length > IMAGE_DATA_MIN_CHARS && DATA_IMAGE_PREFIX.test(value.slice(0, 64))) {
      return imagePlaceholder(value.length - value.indexOf(",") - 1);
    }
    return limitString(value, state);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    return "[嵌套过深，已省略]";
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((child) => {
      const limited = limitValue(child, state, depth + 1);
      if (limited !== child) changed = true;
      return limited;
    });
    return changed ? next : value;
  }
  const record = value as Record<string, unknown>;
  if (isImageBlock(record)) {
    return { type: "text", text: imagePlaceholder(longestString(record)) };
  }
  let next: Record<string, unknown> | null = null;
  for (const [key, child] of Object.entries(record)) {
    const limited = limitValue(child, state, depth + 1);
    if (limited !== child) {
      next ??= { ...record };
      next[key] = limited;
    }
  }
  return next ?? value;
}

/**
 * 限制单个时间线项的大小：字符串合计超过预算时截断，图片内容替换为占位文本。
 * 未超限则原样返回同一引用。
 */
export function limitTimelineItem<T extends AgentTimelineItem>(
  item: T,
  budget: number = TIMELINE_ITEM_TEXT_BUDGET,
): T {
  return limitValue(item, { remaining: budget }, 0) as T;
}
