// 把 sidecar 的 ToolCallDetail / AgentPermissionRequest 转成聊天渲染层能直接展示的文本：
// - context：工具行标题（命令、文件路径、查询词…）
// - preview：简短摘要（diff 增删行数、退出码…）
// - output：展开后的正文（命令输出、diff、文件内容…）
import type {
  AgentPermissionRequest,
  ToolCallDetail,
  ToolCallStatus,
  ToolCallTimelineItem,
} from "@agentdeck/protocol";

export interface AgentToolDisplay {
  context?: string;
  preview?: string;
  output?: string;
}

const MAX_OUTPUT_CHARS = 20_000;

function clip(text: string | undefined): string | undefined {
  if (!text) return undefined;
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n…（已截断，共 ${text.length} 个字符）`;
}

function stringify(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value || undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 统计 unified diff 的增删行数（忽略 +++ / --- 文件头）。 */
export function diffStats(unifiedDiff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of unifiedDiff.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

function editDiff(detail: Extract<ToolCallDetail, { type: "edit" }>): string | undefined {
  if (detail.unifiedDiff) return detail.unifiedDiff;
  if (detail.oldString === undefined && detail.newString === undefined) return undefined;
  const removed = (detail.oldString ?? "").split(/\r?\n/).map((line) => `-${line}`);
  const added = (detail.newString ?? "").split(/\r?\n/).map((line) => `+${line}`);
  return [...(detail.oldString ? removed : []), ...(detail.newString ? added : [])].join("\n");
}

/** Agent 提问（design.md 4.13）：每题一行「问题 → 回答」；运行中尚未作答显示「等待回答」。 */
function describeQuestion(
  detail: Extract<ToolCallDetail, { type: "question" }>,
  status: ToolCallStatus | undefined,
): AgentToolDisplay {
  const first = detail.questions[0];
  if (!first) return {};
  const missing = status === undefined || status === "running" ? "等待回答" : "未回答";
  const lines = detail.questions.map(
    (question) => `${question.question} → ${detail.answers?.[question.question] ?? missing}`,
  );
  return {
    context: detail.questions.length > 1
      ? `${first.question}（共 ${detail.questions.length} 题）`
      : first.question,
    preview: first.header ?? first.question,
    output: clip(lines.join("\n")),
  };
}

export function describeToolDetail(
  detail: ToolCallDetail | undefined,
  status?: ToolCallStatus,
): AgentToolDisplay {
  if (!detail) return {};
  switch (detail.type) {
    case "shell": {
      const exit = typeof detail.exitCode === "number" && detail.exitCode !== 0
        ? `退出码 ${detail.exitCode}`
        : undefined;
      const output = detail.output
        ? exit ? `${detail.output}\n[${exit}]` : detail.output
        : exit ? `[${exit}]` : undefined;
      return {
        context: detail.command,
        preview: detail.cwd ? `在 ${detail.cwd} 中运行` : undefined,
        output: clip(output),
      };
    }
    case "read": {
      const range = detail.offset !== undefined || detail.limit !== undefined
        ? `（${detail.offset !== undefined ? `第 ${detail.offset} 行起` : ""}${detail.limit !== undefined ? `，最多 ${detail.limit} 行` : ""}）`
        : "";
      return { context: `${detail.filePath}${range}`, output: clip(detail.content) };
    }
    case "edit": {
      const diff = editDiff(detail);
      const stats = diff ? diffStats(diff) : undefined;
      return {
        context: detail.filePath,
        preview: stats ? `+${stats.added} −${stats.removed} 行` : undefined,
        output: clip(diff),
      };
    }
    case "write":
      return { context: detail.filePath, output: clip(detail.content) };
    case "search":
      return {
        context: detail.toolName ? `${detail.toolName}：${detail.query}` : detail.query,
        output: clip(detail.content ?? (detail.filePaths?.length ? detail.filePaths.join("\n") : undefined)),
      };
    case "fetch":
      return { context: detail.url, preview: detail.prompt, output: clip(detail.result) };
    case "plan":
      return { context: "计划", output: clip(detail.text) };
    case "sub_agent":
      return { context: detail.description, output: clip(detail.log || undefined) };
    case "plain_text":
      return { context: detail.label, output: clip(detail.text) };
    case "question":
      return describeQuestion(detail, status);
    case "unknown": {
      const input = stringify(detail.input);
      const output = stringify(detail.output);
      return {
        context: input && input.length <= 120 ? input.replace(/\s+/g, " ") : undefined,
        output: clip([input ? `输入：\n${input}` : "", output ? `输出：\n${output}` : ""].filter(Boolean).join("\n\n") || undefined),
      };
    }
    default:
      return {};
  }
}

function metadataFiles(metadata: Record<string, unknown> | undefined): string[] {
  const files = metadata?.files;
  if (!Array.isArray(files)) return [];
  return files
    .map((file) => {
      if (typeof file === "string") return file;
      if (file && typeof file === "object") {
        const record = file as Record<string, unknown>;
        const path = record.path ?? record.filePath;
        return typeof path === "string" ? path : "";
      }
      return "";
    })
    .filter(Boolean);
}

/**
 * 工具调用的展示文本（design.md 5.3）：
 * - ACP 的 name 是 kind，完整标题在 metadata.title，没有更具体的上下文时用它；
 * - Codex 多文件 fileChange 的 detail 只含第一个文件，完整列表在 metadata.files。
 */
export function describeToolCall(item: ToolCallTimelineItem): AgentToolDisplay {
  const display = describeToolDetail(item.detail, item.status);
  const title = typeof item.metadata?.title === "string" ? item.metadata.title : undefined;
  if (!display.context && title) display.context = title;
  const files = metadataFiles(item.metadata);
  if (files.length > 1) {
    display.context = `${files.length} 个文件：${files.join("、")}`;
    const list = files.map((file) => `- ${file}`).join("\n");
    display.output = clip(display.output ? `${list}\n\n${display.output}` : list);
  }
  return display;
}

/** 审批卡片的主文本：优先展示命令 / 文件路径，其次标题与工具名。 */
export function describePermissionCommand(request: AgentPermissionRequest): string {
  const display = describeToolDetail(request.detail);
  return display.context || request.title || request.name || "需要确认操作";
}
