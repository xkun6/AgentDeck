// 会话互通工具（design.md 4.26）：时间线里 agentdeck MCP 工具调用的识别与结果解析。
// 工具名由各 CLI 加前缀：Claude `mcp__agentdeck__delegate`，Codex `agentdeck.delegate`。
import type { ToolCallTimelineItem } from "@agentdeck/protocol";

export type InteropToolName = "delegate" | "send_to_agent" | "wait_agent" | "cancel_agent" | "read_agent";

const INTEROP_TOOL_PATTERN = /(?:^|__)agentdeck(?:__|\.)(delegate|send_to_agent|wait_agent|cancel_agent|read_agent)$/;

export const INTEROP_TOOL_LABELS: Record<InteropToolName, string> = {
  delegate: "委派",
  send_to_agent: "发送给",
  wait_agent: "等待",
  cancel_agent: "中断",
  read_agent: "读取",
};

/** 工具结果中卡片关心的字段（delegate / send_to_agent / wait_agent 返回 JSON） */
export interface InteropCallResult {
  agentId?: string;
  status?: string;
  reply?: string;
  error?: string;
  note?: string;
}

/** 渲染委派卡片所需的信息，挂在工具 part / ChatToolItem 的 `delegate` 字段上 */
export interface InteropCallInfo {
  tool: InteropToolName;
  /** 目标会话 id：delegate 取结果里的 agentId，其余取入参 */
  agentId?: string;
  /** 入参摘录：prompt / message / provider / title */
  provider?: string;
  title?: string;
  request?: string;
  result?: InteropCallResult;
  /** 结果不是 JSON（工具错误文本等）时的原文 */
  errorText?: string;
}

export function interopToolName(name: string): InteropToolName | null {
  const match = INTEROP_TOOL_PATTERN.exec(name);
  return match ? (match[1] as InteropToolName) : null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** 工具输出可能是字符串（Claude）、`{ content: [{ type: "text", text }] }`（Codex）或内容块数组 */
function outputText(output: unknown): string | undefined {
  if (typeof output === "string") return output;
  const blocks = Array.isArray(output) ? output : Array.isArray(asRecord(output)?.content) ? (asRecord(output)!.content as unknown[]) : null;
  if (!blocks) return undefined;
  const text = blocks
    .map((block) => str(asRecord(block)?.text) ?? "")
    .filter(Boolean)
    .join("");
  return text || undefined;
}

function parseResult(text: string | undefined): InteropCallResult | undefined {
  if (!text) return undefined;
  try {
    const parsed = asRecord(JSON.parse(text));
    if (!parsed) return undefined;
    const agentId = str(parsed.agentId);
    const status = str(parsed.status);
    const reply = str(parsed.reply);
    const error = str(parsed.error);
    const note = str(parsed.note);
    return {
      ...(agentId ? { agentId } : {}),
      ...(status ? { status } : {}),
      ...(reply ? { reply } : {}),
      ...(error ? { error } : {}),
      ...(note ? { note } : {}),
    };
  } catch {
    return undefined;
  }
}

/** 是 agentdeck 互通工具调用时返回卡片信息，否则 undefined */
export function describeInteropCall(item: ToolCallTimelineItem): InteropCallInfo | undefined {
  const tool = interopToolName(item.name);
  if (!tool || item.detail.type !== "unknown") return undefined;
  const input = asRecord(item.detail.input) ?? {};
  const text = outputText(item.detail.output);
  const result = tool === "read_agent" ? undefined : parseResult(text);
  const failed = item.status === "failed" || Boolean(item.error);
  const errorText = failed || (!result && item.status === "completed" && tool !== "read_agent") ? (item.error ?? text) : undefined;
  const agentId = tool === "delegate" ? result?.agentId : (str(input.agentId) ?? result?.agentId);
  const provider = str(input.provider);
  const title = str(input.title);
  const request = str(input.prompt) ?? str(input.message);
  return {
    tool,
    ...(agentId ? { agentId } : {}),
    ...(provider ? { provider } : {}),
    ...(title ? { title } : {}),
    ...(request ? { request } : {}),
    ...(result ? { result } : {}),
    ...(errorText ? { errorText } : {}),
  };
}
