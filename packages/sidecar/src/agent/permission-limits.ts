/**
 * 审批请求大小限制（design.md 4.31「超大审批内容截断」）。
 *
 * 背景：远程网关对下行帧有 16 MiB 上限，超限的 `agent.stream` 通知会被丢弃。Write / Edit 一个大文件、
 * 超长 Bash 命令等审批请求的 `input` / `detail` 可能很大，`permission_requested` 一旦发不出去，
 * 手机上就永远看不到这条审批。因此在 AgentManager 处理 provider 事件时先把过长的字符串字段截断，
 * 再进入快照 / 广播 / 落盘；provider 自己保留的原始 input 不受影响。
 */
import type { AgentPermissionRequest, AgentPermissionResponse } from "@agentdeck/protocol";

/** 单个字符串字段上限（UTF-8 字节） */
export const PERMISSION_FIELD_MAX_BYTES = 256 * 1024;
/** 一条审批里所有字符串合计的上限（UTF-8 字节），防止大量中等长度字段累加出超大事件 */
export const PERMISSION_TOTAL_MAX_BYTES = 2 * 1024 * 1024;
/** 总预算用尽后每个字符串仍至少保留的字节数 */
const MIN_FIELD_BYTES = 1024;
const MAX_DEPTH = 12;

/** 被截断的 input 顶层字段：发给 UI 的值与原始值，用于应答时还原未被用户改动的字段 */
export interface TruncatedInputField {
  key: string;
  sent: unknown;
  original: unknown;
}

export interface LimitedPermissionRequest {
  /** 截断后的请求；没有任何字段被截断时就是传入的同一个对象 */
  request: AgentPermissionRequest;
  /** input 顶层被截断的字段（用于 updatedInput 还原）；没有则为空数组 */
  truncatedInput: TruncatedInputField[];
}

interface LimitState {
  remaining: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 截到 maxBytes 个 UTF-8 字节以内，不把多字节字符截开 */
function truncateUtf8(text: string, maxBytes: number): { kept: string; removed: number } {
  const buffer = Buffer.from(text, "utf8");
  let end = Math.min(maxBytes, buffer.length);
  // buffer[end] 是续字节说明截在了字符中间，回退到该字符的起点
  while (end > 0 && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return { kept: buffer.subarray(0, end).toString("utf8"), removed: buffer.length - end };
}

function limitString(text: string, state: LimitState): string {
  const bytes = Buffer.byteLength(text, "utf8");
  const allowed = Math.min(PERMISSION_FIELD_MAX_BYTES, Math.max(state.remaining, MIN_FIELD_BYTES));
  if (bytes <= allowed) {
    state.remaining = Math.max(0, state.remaining - bytes);
    return text;
  }
  const { kept, removed } = truncateUtf8(text, allowed);
  state.remaining = Math.max(0, state.remaining - allowed);
  return `${kept}…已截断 ${removed} 字节`;
}

/** 递归限制所有字符串；有变化才复制，没有变化返回原引用 */
function limitValue(value: unknown, state: LimitState, depth: number): unknown {
  if (typeof value === "string") {
    return limitString(value, state);
  }
  if (depth >= MAX_DEPTH) {
    return value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const limited = limitValue(item, state, depth + 1);
      changed ||= limited !== item;
      return limited;
    });
    return changed ? next : value;
  }
  if (isRecord(value)) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const limited = limitValue(child, state, depth + 1);
      changed ||= limited !== child;
      next[key] = limited;
    }
    return changed ? next : value;
  }
  return value;
}

/**
 * 限制审批请求里 `input` / `detail`（以及 `title` / `description`）的字符串大小。
 * 未超限时 `request` 是原对象（同一引用），不复制。
 */
export function limitPermissionRequest(request: AgentPermissionRequest): LimitedPermissionRequest {
  const state: LimitState = { remaining: PERMISSION_TOTAL_MAX_BYTES };
  const input = request.input === undefined ? undefined : (limitValue(request.input, state, 0) as Record<string, unknown>);
  const detail = request.detail === undefined ? undefined : (limitValue(request.detail, state, 0) as typeof request.detail);
  const title = request.title === undefined ? undefined : limitString(request.title, state);
  const description = request.description === undefined ? undefined : limitString(request.description, state);
  if (input === request.input && detail === request.detail && title === request.title && description === request.description) {
    return { request, truncatedInput: [] };
  }
  const truncatedInput: TruncatedInputField[] = [];
  if (input && request.input) {
    for (const key of Object.keys(request.input)) {
      if (input[key] !== request.input[key]) {
        truncatedInput.push({ key, sent: input[key], original: request.input[key] });
      }
    }
  }
  return {
    request: {
      ...request,
      ...(input !== undefined ? { input } : {}),
      ...(detail !== undefined ? { detail } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
    },
    truncatedInput,
  };
}

/**
 * `permission_resolved` 事件里的应答：provider 收到还原后的原始 `updatedInput` 后会把它原样放进事件，
 * 广播 / 落盘前同样截断。没有 updatedInput 或未超限时返回同一个对象。
 */
export function limitPermissionResponse(response: AgentPermissionResponse): AgentPermissionResponse {
  if (response.behavior !== "allow" || !response.updatedInput) {
    return response;
  }
  const updatedInput = limitValue(response.updatedInput, { remaining: PERMISSION_TOTAL_MAX_BYTES }, 0) as Record<string, unknown>;
  return updatedInput === response.updatedInput ? response : { ...response, updatedInput };
}

/**
 * 应答 allow 时，UI 回传的 `updatedInput` 里若某个被截断的字段仍是当初发给 UI 的截断值（用户没改它），
 * 换回原始值，避免把「…已截断 N 字节」当成真实输入传给 provider；用户确实改过的字段保持不变。
 */
export function restoreTruncatedInput(
  updatedInput: Record<string, unknown> | undefined,
  truncated: readonly TruncatedInputField[],
): Record<string, unknown> | undefined {
  if (!updatedInput || truncated.length === 0) {
    return updatedInput;
  }
  let restored: Record<string, unknown> | undefined;
  for (const { key, sent, original } of truncated) {
    if (key in updatedInput && JSON.stringify(updatedInput[key]) === JSON.stringify(sent)) {
      restored ??= { ...updatedInput };
      restored[key] = original;
    }
  }
  return restored ?? updatedInput;
}
