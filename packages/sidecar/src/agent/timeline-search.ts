import type {
  AgentSearchHit,
  AgentStreamEnvelope,
  ToolCallTimelineItem,
} from "@agentdeck/protocol";

/** snippet 在命中前后各保留的字数（UTF-16） */
const SNIPPET_CONTEXT = 60;
/** 每个会话最多返回的命中条数（design.md 4.19） */
export const SEARCH_MAX_HITS_PER_AGENT = 5;

type SearchRole = AgentSearchHit["role"];

/** 待搜索的会话（调用方已按 updatedAt 倒序排好） */
export interface SearchSource {
  agentId: string;
  /** 时间线条目流：内存时间线或逐行解析的 timeline.jsonl */
  entries: () => AsyncIterable<AgentStreamEnvelope> | Iterable<AgentStreamEnvelope>;
}

export interface SearchResult {
  hits: AgentSearchHit[];
  truncated: boolean;
}

/** 按顺序扫描各会话，凑够 limit 条命中即停止并置 truncated（design.md 4.19） */
export async function searchSources(
  sources: SearchSource[],
  query: string,
  limit: number,
  onSourceError?: (agentId: string, error: unknown) => void,
): Promise<SearchResult> {
  const needle = query.trim().toLocaleLowerCase();
  const hits: AgentSearchHit[] = [];
  if (!needle) {
    return { hits, truncated: false };
  }
  for (const source of sources) {
    try {
      hits.push(...(await searchEntries(source.agentId, source.entries(), needle)));
    } catch (error) {
      onSourceError?.(source.agentId, error);
    }
    if (hits.length >= limit) {
      return { hits: hits.slice(0, limit), truncated: true };
    }
  }
  return { hits, truncated: false };
}

interface Candidate {
  role: SearchRole;
  seq: number;
  timestamp: number;
  text: string;
  /** 仅用户消息：供撤回时剔除 */
  clientMessageId?: string;
}

/**
 * 在单个会话的时间线上搜索，返回至多 5 条命中（按 seq 升序）。
 * - assistant_message 按 messageId 拼接（无 messageId 时按连续顺序），reasoning 在同一回合内连续拼接，
 *   两者的 seq 取首段；tool_call 同 callId 取最后一次推送的内容、seq 取首次；
 * - 被撤回的用户消息（user_message_retracted，design.md 4.16）不参与；
 * - 坏行由上游读取方跳过。
 */
export async function searchEntries(
  agentId: string,
  entries: AsyncIterable<AgentStreamEnvelope> | Iterable<AgentStreamEnvelope>,
  needle: string,
): Promise<AgentSearchHit[]> {
  const candidates: Candidate[] = [];
  const assistantById = new Map<string, Candidate>();
  let assistantRun: Candidate | null = null;
  let reasoningRun: Candidate | null = null;
  const tools = new Map<string, Candidate>();
  let lastUser: { seq: number; clientMessageId?: string } | null = null;
  const retractedSeqs = new Set<number>();
  const retractedClientIds = new Set<string>();

  const closeAssistantRun = () => {
    assistantRun = null;
  };
  const closeReasoningRun = () => {
    reasoningRun = null;
  };
  const closeAllRuns = () => {
    assistantRun = null;
    reasoningRun = null;
    assistantById.clear();
  };

  for await (const envelope of entries) {
    const event = envelope.event;
    if (event.type === "turn_completed" || event.type === "turn_failed" || event.type === "turn_canceled") {
      closeAllRuns();
      continue;
    }
    if (event.type === "user_message_retracted") {
      if (event.clientMessageId !== undefined) {
        retractedClientIds.add(event.clientMessageId);
      } else if (lastUser) {
        retractedSeqs.add(lastUser.seq);
      }
      continue;
    }
    if (event.type !== "timeline") {
      continue;
    }
    const item = event.item;
    if (item.type !== "reasoning") {
      closeReasoningRun();
    }
    if (item.type !== "assistant_message") {
      closeAssistantRun();
    }
    switch (item.type) {
      case "user_message": {
        const candidate: Candidate = {
          role: "user",
          seq: envelope.seq,
          timestamp: envelope.timestamp,
          text: item.text,
          ...(item.clientMessageId !== undefined ? { clientMessageId: item.clientMessageId } : {}),
        };
        lastUser = {
          seq: envelope.seq,
          ...(item.clientMessageId !== undefined ? { clientMessageId: item.clientMessageId } : {}),
        };
        candidates.push(candidate);
        break;
      }
      case "assistant_message": {
        let target: Candidate | undefined | null =
          item.messageId !== undefined ? assistantById.get(item.messageId) : assistantRun;
        if (!target) {
          target = newCandidate("assistant", envelope);
          candidates.push(target);
          if (item.messageId !== undefined) {
            assistantById.set(item.messageId, target);
          }
        }
        target.text += item.text;
        assistantRun = target;
        break;
      }
      case "reasoning": {
        if (!reasoningRun) {
          reasoningRun = newCandidate("reasoning", envelope);
          candidates.push(reasoningRun);
        }
        reasoningRun.text += item.text;
        break;
      }
      case "tool_call": {
        const existing = tools.get(item.callId);
        if (existing) {
          existing.text = toolText(item);
        } else {
          const candidate: Candidate = {
            role: "tool",
            seq: envelope.seq,
            timestamp: envelope.timestamp,
            text: toolText(item),
          };
          tools.set(item.callId, candidate);
          candidates.push(candidate);
        }
        break;
      }
      default:
        break;
    }
  }

  const hits: AgentSearchHit[] = [];
  for (const candidate of candidates) {
    if (
      candidate.role === "user" &&
      (retractedSeqs.has(candidate.seq) ||
        (candidate.clientMessageId !== undefined && retractedClientIds.has(candidate.clientMessageId)))
    ) {
      continue;
    }
    const hit = matchCandidate(agentId, candidate, needle);
    if (hit) {
      hits.push(hit);
      if (hits.length >= SEARCH_MAX_HITS_PER_AGENT) {
        break;
      }
    }
  }
  return hits;
}

function newCandidate(role: SearchRole, envelope: AgentStreamEnvelope): Candidate {
  return { role, seq: envelope.seq, timestamp: envelope.timestamp, text: "" };
}

/** 工具名、标题、shell 命令、文件路径（以及搜索词）拼成可搜索文本 */
function toolText(item: ToolCallTimelineItem): string {
  const parts: string[] = [item.name];
  const title = item.metadata?.title;
  if (typeof title === "string") {
    parts.push(title);
  }
  const detail = item.detail;
  switch (detail.type) {
    case "shell":
      parts.push(detail.command);
      break;
    case "read":
    case "edit":
    case "write":
      parts.push(detail.filePath);
      break;
    case "search":
      parts.push(detail.query);
      break;
    default:
      break;
  }
  return parts.join(" ");
}

function matchCandidate(agentId: string, candidate: Candidate, needle: string): AgentSearchHit | null {
  const found = findCaseInsensitive(candidate.text, needle);
  if (!found) {
    return null;
  }
  const { text } = candidate;
  const start = Math.max(0, found.start - SNIPPET_CONTEXT);
  const end = Math.min(text.length, found.start + found.length + SNIPPET_CONTEXT);
  const before = flatten(text.slice(start, found.start));
  const match = flatten(text.slice(found.start, found.start + found.length));
  const after = flatten(text.slice(found.start + found.length, end));
  return {
    agentId,
    seq: candidate.seq,
    timestamp: candidate.timestamp,
    role: candidate.role,
    snippet: before + match + after,
    matchStart: before.length,
    matchLength: match.length,
  };
}

function flatten(text: string): string {
  return text.replace(/\r\n|[\r\n]/g, " ");
}

/**
 * 大小写不敏感的子串查找，返回在原文中的 UTF-16 区间。needle 已 toLocaleLowerCase。
 * 个别字符小写后长度会变化（如 İ），此时逐字符折叠并记录下标映射，避免位置错位。
 */
function findCaseInsensitive(text: string, needle: string): { start: number; length: number } | null {
  const lower = text.toLocaleLowerCase();
  if (lower.length === text.length) {
    const index = lower.indexOf(needle);
    return index < 0 ? null : { start: index, length: needle.length };
  }
  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const char of text) {
    const piece = char.toLocaleLowerCase();
    for (let i = 0; i < piece.length; i += 1) {
      starts.push(offset);
      ends.push(offset + char.length);
    }
    folded += piece;
    offset += char.length;
  }
  const index = folded.indexOf(needle);
  if (index < 0) {
    return null;
  }
  const start = starts[index]!;
  const end = ends[index + needle.length - 1]!;
  return { start, length: end - start };
}
