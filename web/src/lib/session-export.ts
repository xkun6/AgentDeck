// 会话导出（design.md 4.17）：前端把 agent.timeline 的全部条目生成 JSON / Markdown，
// Rust 的 export_session_file 只负责保存对话框与写文件。
import type {
  AgentSnapshot,
  AgentStreamEnvelope,
  AgentTimelineItem,
  ToolCallStatus,
  ToolCallTimelineItem,
} from "@agentdeck/protocol";

const FILE_NAME_TITLE_CHARS = 40;
const FALLBACK_FILE_TITLE = "会话";

/** 导出文件里的快照：去掉 persistence / pendingPermissions / activeTurnId。 */
export function exportableAgent(agent: AgentSnapshot): Omit<
  AgentSnapshot,
  "persistence" | "pendingPermissions" | "activeTurnId"
> {
  const { persistence: _persistence, pendingPermissions: _pending, activeTurnId: _active, ...rest } = agent;
  return rest;
}

export function buildSessionJson(
  agent: AgentSnapshot,
  entries: AgentStreamEnvelope[],
  exportedAt: number = Date.now(),
): string {
  return JSON.stringify(
    {
      format: "agentdeck.session",
      version: 1,
      exportedAt,
      agent: exportableAgent(agent),
      entries,
    },
    null,
    2,
  );
}

/** 默认文件名：`<标题前 40 字，去掉非法字符>-<yyyyMMdd-HHmm>`（不含扩展名）。 */
export function sessionExportFileName(title: string, now: Date = new Date()): string {
  const cleaned = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const clipped = Array.from(cleaned).slice(0, FILE_NAME_TITLE_CHARS).join("").replace(/[. ]+$/, "");
  return `${clipped || FALLBACK_FILE_TITLE}-${formatCompactTime(now)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatCompactTime(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

type Block =
  | { kind: "user"; text: string; clientMessageId?: string }
  | { kind: "assistant"; text: string; messageId?: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; item: ToolCallTimelineItem }
  | { kind: "note"; text: string };

const TOOL_STATUS_LABELS: Record<ToolCallStatus, string> = {
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  canceled: "已取消",
};

/** 行内代码：压成单行；文本含反引号时用更长的围栏。 */
function inlineCode(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  let fence = "`";
  while (flat.includes(fence)) fence += "`";
  return flat.startsWith("`") || flat.endsWith("`") ? `${fence} ${flat} ${fence}` : `${fence}${flat}${fence}`;
}

function toolLine(item: ToolCallTimelineItem): string {
  const parts = [`- 工具 ${inlineCode(item.name)}`, TOOL_STATUS_LABELS[item.status] ?? item.status];
  if (item.detail.type === "shell" && item.detail.command.trim()) {
    parts.push(inlineCode(item.detail.command));
  }
  return parts.join(" · ");
}

/** 把时间线条目归并成按时间排序的块；被撤回的用户消息（4.16）与其后的 turn_canceled 不输出。 */
function collectBlocks(entries: AgentStreamEnvelope[]): Block[] {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  const blocks: Block[] = [];
  const retractedTurns = new Set<string>();
  const assistantByMessageId = new Map<string, Extract<Block, { kind: "assistant" }>>();
  const toolByCallId = new Map<string, Extract<Block, { kind: "tool" }>>();

  const appendTimelineItem = (item: AgentTimelineItem): void => {
    const last = blocks[blocks.length - 1];
    switch (item.type) {
      case "user_message": {
        assistantByMessageId.clear();
        blocks.push({
          kind: "user",
          text: item.text,
          ...(item.clientMessageId ? { clientMessageId: item.clientMessageId } : {}),
        });
        return;
      }
      case "assistant_message": {
        if (!item.text) return;
        const existing = item.messageId ? assistantByMessageId.get(item.messageId) : undefined;
        if (existing) {
          existing.text += item.text;
        } else if (!item.messageId && last?.kind === "assistant") {
          last.text += item.text;
        } else {
          const block: Extract<Block, { kind: "assistant" }> = {
            kind: "assistant",
            text: item.text,
            ...(item.messageId ? { messageId: item.messageId } : {}),
          };
          if (item.messageId) assistantByMessageId.set(item.messageId, block);
          blocks.push(block);
        }
        return;
      }
      case "reasoning": {
        if (!item.text) return;
        if (last?.kind === "reasoning") last.text += item.text;
        else blocks.push({ kind: "reasoning", text: item.text });
        return;
      }
      case "tool_call": {
        const existing = toolByCallId.get(item.callId);
        if (existing) {
          existing.item = item;
        } else {
          const block: Extract<Block, { kind: "tool" }> = { kind: "tool", item };
          toolByCallId.set(item.callId, block);
          blocks.push(block);
        }
        return;
      }
      case "error":
        blocks.push({ kind: "note", text: `错误：${item.message}` });
        return;
      case "compaction":
        if (item.status === "running") return;
        blocks.push({
          kind: "note",
          text: item.status === "failed" ? `上下文压缩失败${item.error ? `：${item.error}` : ""}` : "上下文已压缩",
        });
        return;
      default:
        return;
    }
  };

  for (const envelope of sorted) {
    const { event } = envelope;
    switch (event.type) {
      case "timeline":
        appendTimelineItem(event.item);
        break;
      case "turn_failed":
        blocks.push({ kind: "note", text: `错误：${event.error || "Agent 执行失败"}` });
        break;
      case "turn_canceled":
        if (!retractedTurns.has(event.turnId)) blocks.push({ kind: "note", text: "已中断本轮" });
        break;
      case "user_message_retracted": {
        retractedTurns.add(event.turnId);
        let index = -1;
        if (event.clientMessageId) {
          index = blocks.findIndex(
            (block) => block.kind === "user" && block.clientMessageId === event.clientMessageId,
          );
        }
        if (index < 0) {
          for (let i = blocks.length - 1; i >= 0; i -= 1) {
            if (blocks[i]!.kind === "user") {
              index = i;
              break;
            }
          }
        }
        if (index >= 0) blocks.splice(index, 1);
        break;
      }
      default:
        break;
    }
  }
  return blocks;
}

function renderBlock(block: Block): string {
  switch (block.kind) {
    case "user":
      return `### 用户\n\n${block.text.trim() ? block.text.trimEnd() : "[图片]"}`;
    case "assistant":
      return `### 助手\n\n${block.text.trimEnd()}`;
    case "reasoning":
      return `<details><summary>思考</summary>\n\n${block.text.trim()}\n\n</details>`;
    case "tool":
      return toolLine(block.item);
    case "note":
      return `> ${block.text.replace(/\n/g, "\n> ")}`;
  }
}

export interface SessionMarkdownOptions {
  /** 一级标题（会话标题） */
  title: string;
  /** Agent 的展示名（如 Claude Code）；缺省用 provider id */
  providerLabel?: string;
}

export function buildSessionMarkdown(
  agent: AgentSnapshot,
  entries: AgentStreamEnvelope[],
  options: SessionMarkdownOptions,
): string {
  const usage = agent.totalUsage ?? (agent.lastUsage
    ? { inputTokens: agent.lastUsage.inputTokens ?? 0, outputTokens: agent.lastUsage.outputTokens ?? 0 }
    : undefined);
  const meta = [
    `- Agent：${options.providerLabel ?? agent.provider}`,
    `- 模型：${agent.model || "默认"}`,
    `- 模式：${agent.modeId || "默认"}`,
    `- 工作目录：${inlineCode(agent.cwd)}`,
    `- 创建时间：${formatDateTime(agent.createdAt)}`,
    `- 更新时间：${formatDateTime(agent.updatedAt)}`,
    ...(usage ? [`- 累计 tokens：输入 ${usage.inputTokens} / 输出 ${usage.outputTokens}`] : []),
  ];

  const sections: string[] = [`# ${options.title.replace(/\s+/g, " ").trim() || FALLBACK_FILE_TITLE}`, meta.join("\n")];
  const blocks = collectBlocks(entries);
  let previous: Block | undefined;
  for (const block of blocks) {
    const text = renderBlock(block);
    // 连续的工具行合并成一个列表，其余块之间空一行
    if (block.kind === "tool" && previous?.kind === "tool") {
      sections[sections.length - 1] += `\n${text}`;
    } else {
      sections.push(text);
    }
    previous = block;
  }
  return `${sections.join("\n\n")}\n`;
}
