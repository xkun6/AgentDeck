// Derived from paseo packages/server/src/server/agent/providers/claude/tool-call-mapper.ts (Apache-2.0); modified for AgentDeck
// 改动：ToolCallTimelineItem 来自 @agentdeck/protocol（error 为字符串）；去掉 speak 工具；PowerShell 视为 shell；
// 新增 outputCandidates：按顺序尝试多种输出形状（SDK 结构化 tool_use_result、文本等），取第一个能解析出结构化 detail 的。
import { z } from "zod";

import type { ToolCallDetail, ToolCallTimelineItem } from "@agentdeck/protocol";

import { deriveClaudeToolDetail } from "./tool-call-detail-parser.js";

export interface ClaudeToolCallMapperParams {
  callId?: string | null;
  name: string;
  input?: unknown;
  output?: unknown;
  /** 依次尝试的输出候选（优先于 output）；都解析不出结构化 detail 时退回 unknown */
  outputCandidates?: unknown[];
  metadata?: Record<string, unknown>;
}

const ClaudeToolCallStatusSchema = z.enum(["running", "completed", "failed", "canceled"]);
type ClaudeToolCallStatus = z.infer<typeof ClaudeToolCallStatusSchema>;

const ClaudeRawToolCallSchema = z
  .object({
    callId: z.string().optional().nullable(),
    name: z.string().min(1),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    status: ClaudeToolCallStatusSchema,
  })
  .passthrough();

type ClaudeToolKind = "shell" | "read" | "write" | "edit" | "search" | "fetch" | "unknown";

// AgentDeck：Windows 上 Claude Code 可能提供 PowerShell 工具代替 Bash
const SHELL_NAMES: ReadonlySet<string> = new Set([
  "Bash",
  "bash",
  "PowerShell",
  "shell",
  "exec_command",
]);
const READ_NAMES: ReadonlySet<string> = new Set(["Read", "read", "read_file", "view_file"]);
const WRITE_NAMES: ReadonlySet<string> = new Set(["Write", "write", "write_file", "create_file"]);
const EDIT_NAMES: ReadonlySet<string> = new Set([
  "Edit",
  "MultiEdit",
  "multi_edit",
  "edit",
  "apply_patch",
  "apply_diff",
  "str_replace_editor",
]);
const SEARCH_NAMES: ReadonlySet<string> = new Set([
  "WebSearch",
  "web_search",
  "search",
  "Grep",
  "grep",
  "Glob",
  "glob",
]);
const FETCH_NAMES: ReadonlySet<string> = new Set([
  "WebFetch",
  "web_fetch",
  "WebFetchTool",
  "web_fetch_tool",
  "webfetch",
]);

export function resolveClaudeToolKind(name: string): ClaudeToolKind {
  if (SHELL_NAMES.has(name)) return "shell";
  if (READ_NAMES.has(name)) return "read";
  if (WRITE_NAMES.has(name)) return "write";
  if (EDIT_NAMES.has(name)) return "edit";
  if (SEARCH_NAMES.has(name)) return "search";
  if (FETCH_NAMES.has(name)) return "fetch";
  return "unknown";
}

function resolveDetailName(toolKind: ClaudeToolKind, name: string): string {
  switch (toolKind) {
    case "shell":
      return "shell";
    case "read":
      return "read_file";
    case "write":
      return "write_file";
    case "edit":
      return "apply_patch";
    default:
      return name;
  }
}

function deriveDetail(
  detailName: string,
  input: unknown,
  output: unknown,
  outputCandidates: unknown[] | undefined,
): ToolCallDetail {
  if (!outputCandidates || outputCandidates.length === 0) {
    return deriveClaudeToolDetail(detailName, input, output);
  }
  let fallback: ToolCallDetail | null = null;
  for (const candidate of outputCandidates) {
    const detail = deriveClaudeToolDetail(detailName, input, candidate);
    if (detail.type !== "unknown") {
      return detail;
    }
    if (fallback === null && candidate !== null && candidate !== undefined) {
      fallback = detail;
    }
  }
  return fallback ?? deriveClaudeToolDetail(detailName, input, null);
}

function errorToText(error: unknown): string {
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message;
    }
  }
  return "工具调用失败";
}

function mapClaudeToolCall(
  params: ClaudeToolCallMapperParams,
  status: ClaudeToolCallStatus,
  error: unknown,
): ToolCallTimelineItem | null {
  const parsed = ClaudeRawToolCallSchema.safeParse({ ...params, status });
  if (!parsed.success) {
    return null;
  }
  const raw = parsed.data;
  const callId = typeof raw.callId === "string" && raw.callId.trim().length > 0 ? raw.callId : null;
  if (callId === null) {
    return null;
  }

  const name = raw.name.trim();
  const toolKind = resolveClaudeToolKind(name);
  const detail = deriveDetail(
    resolveDetailName(toolKind, name),
    raw.input ?? null,
    raw.output ?? null,
    params.outputCandidates,
  );

  return {
    type: "tool_call",
    callId,
    name,
    detail,
    status: raw.status,
    error: raw.status === "failed" ? errorToText(error) : null,
    ...(raw.metadata ? { metadata: raw.metadata } : {}),
  };
}

export function mapClaudeRunningToolCall(
  params: ClaudeToolCallMapperParams,
): ToolCallTimelineItem | null {
  return mapClaudeToolCall(params, "running", null);
}

export function mapClaudeCompletedToolCall(
  params: ClaudeToolCallMapperParams,
): ToolCallTimelineItem | null {
  return mapClaudeToolCall(params, "completed", null);
}

export function mapClaudeFailedToolCall(
  params: ClaudeToolCallMapperParams & { error: unknown },
): ToolCallTimelineItem | null {
  return mapClaudeToolCall(params, "failed", params.error);
}

export function mapClaudeCanceledToolCall(
  params: ClaudeToolCallMapperParams,
): ToolCallTimelineItem | null {
  return mapClaudeToolCall(params, "canceled", null);
}
