// Derived from paseo packages/server/src/server/agent/providers/codex/tool-call-mapper.ts (Apache-2.0); modified for AgentDeck
// 改动：
// - 类型改用 @agentdeck/protocol 的 ToolCallTimelineItem，error 统一转为字符串；
// - 去掉 speak；collabAgentToolCall / subAgentActivity 映射为 sub_agent（design.md 4.11）；
// - 兼容本机 codex 0.162 的 fileChange：kind 为对象 `{ type: "add" | "update" | "delete" }`；
//   单文件新增且内容不是 diff 时输出 write 详情；
// - commandExecution / fileChange 的 `declined` 状态归为 failed（paseo 的状态词表没有它）。
import type { ToolCallDetail, ToolCallTimelineItem } from "@agentdeck/protocol";
import { z } from "zod";

import {
  extractCodexShellOutput,
  normalizeToolCallStatus,
  truncateDiffText,
} from "../shared/index.js";
import { deriveCodexToolDetail, normalizeCodexFilePath } from "./tool-call-detail-parser.js";

interface CodexMapperOptions {
  cwd?: string | null;
}

type CodexToolCallStatus = ToolCallTimelineItem["status"];

const CodexCommandValueSchema = z.union([z.string(), z.array(z.string())]);

const DECLINED_ERROR = "用户拒绝了该操作";

interface CodexNormalizedToolCallEnvelope {
  callId: string;
  name: string;
  input?: unknown;
  output?: unknown;
  status: CodexToolCallStatus;
  error?: unknown;
  metadata?: Record<string, unknown>;
  cwd?: string | null;
  /** fileChange 的首个文件是新增且只有完整内容（非 diff） */
  addedFile?: { path: string; content: string };
}

type CodexToolKind = "shell" | "read" | "write" | "edit" | "search" | "unknown";

const CODEX_SHELL_NAMES: ReadonlySet<string> = new Set([
  "Bash",
  "shell",
  "bash",
  "exec",
  "exec_command",
  "command",
]);
const CODEX_READ_NAMES: ReadonlySet<string> = new Set(["read", "read_file"]);
const CODEX_WRITE_NAMES: ReadonlySet<string> = new Set(["write", "write_file", "create_file"]);
const CODEX_EDIT_NAMES: ReadonlySet<string> = new Set(["edit", "apply_patch", "apply_diff"]);
const CODEX_SEARCH_NAMES: ReadonlySet<string> = new Set(["search", "web_search"]);

function resolveCodexToolKind(name: string): CodexToolKind {
  if (CODEX_SHELL_NAMES.has(name)) return "shell";
  if (CODEX_READ_NAMES.has(name)) return "read";
  if (CODEX_WRITE_NAMES.has(name)) return "write";
  if (CODEX_EDIT_NAMES.has(name)) return "edit";
  if (CODEX_SEARCH_NAMES.has(name)) return "search";
  return "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 协议的 error 是字符串：对象取 message，其余 JSON 化 */
export function toolErrorToString(error: unknown): string | null {
  if (error === undefined || error === null) {
    return null;
  }
  if (typeof error === "string") {
    return error;
  }
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function toToolCallTimelineItem(
  envelope: CodexNormalizedToolCallEnvelope,
  toolKind: CodexToolKind,
): ToolCallTimelineItem {
  const parsedDetail = deriveCodexToolDetail({
    name: envelope.name,
    input: envelope.input ?? null,
    output: envelope.output ?? null,
    cwd: envelope.cwd ?? null,
  });

  let detail: ToolCallDetail = parsedDetail;
  if (toolKind === "edit" && envelope.addedFile && !hasRenderableDiff(parsedDetail)) {
    detail = {
      type: "write",
      filePath: envelope.addedFile.path,
      content: envelope.addedFile.content,
    };
  } else if (
    toolKind === "edit" &&
    envelope.status !== "running" &&
    !hasRenderableEditDetail(parsedDetail)
  ) {
    detail = { type: "unknown", input: envelope.input ?? null, output: envelope.output ?? null };
  }

  const error =
    envelope.status === "failed"
      ? (toolErrorToString(envelope.error) ?? "工具调用失败")
      : null;

  return {
    type: "tool_call",
    callId: envelope.callId,
    name: envelope.name,
    status: envelope.status,
    error,
    detail,
    ...(envelope.metadata ? { metadata: envelope.metadata } : {}),
  };
}

// ---------------------------------------------------------------------------
// Thread-item parsing
// ---------------------------------------------------------------------------

const CodexCommandExecutionItemSchema = z
  .object({
    type: z.literal("commandExecution"),
    id: z.string().min(1),
    status: z.string().optional(),
    error: z.unknown().optional(),
    command: CodexCommandValueSchema.optional(),
    cwd: z.string().optional(),
    aggregatedOutput: z.string().nullable().optional(),
    exitCode: z.number().nullable().optional(),
  })
  .passthrough();

const CodexFileChangeItemSchema = z
  .object({
    type: z.literal("fileChange"),
    id: z.string().min(1),
    status: z.string().optional(),
    error: z.unknown().optional(),
    changes: z.unknown().optional(),
  })
  .passthrough();

const CodexMcpToolCallItemSchema = z
  .object({
    type: z.literal("mcpToolCall"),
    id: z.string().min(1),
    status: z.string().optional(),
    error: z.unknown().optional(),
    tool: z.string().min(1),
    server: z.string().optional(),
    arguments: z.unknown().optional(),
    result: z.unknown().optional(),
  })
  .passthrough();

const CodexWebSearchItemSchema = z
  .object({
    type: z.literal("webSearch"),
    id: z.string().min(1),
    status: z.string().optional(),
    error: z.unknown().optional(),
    query: z.string().optional(),
    action: z.unknown().optional(),
  })
  .passthrough();

const CodexCollabAgentToolCallItemSchema = z
  .object({
    type: z.literal("collabAgentToolCall"),
    id: z.string().min(1),
    status: z.string().optional(),
    error: z.unknown().optional(),
    prompt: z.string().nullable().optional(),
    tool: z.string().optional(),
    receiverThreadIds: z.array(z.string()).optional(),
    agentsStates: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const CodexSubAgentActivityItemSchema = z
  .object({
    type: z.literal("subAgentActivity"),
    id: z.string().min(1),
    kind: z.string(),
    agentThreadId: z.string().min(1),
    agentPath: z.string(),
  })
  .passthrough();

const CodexThreadItemSchema = z.discriminatedUnion("type", [
  CodexCommandExecutionItemSchema,
  CodexFileChangeItemSchema,
  CodexMcpToolCallItemSchema,
  CodexWebSearchItemSchema,
  CodexCollabAgentToolCallItemSchema,
  CodexSubAgentActivityItemSchema,
]);

function unwrapShellCommand(command: string): string {
  const trimmed = command.trim();
  const unix = trimmed.match(/^(?:(?:\/[^/\s]+)*\/)?(?:zsh|bash|sh)\s+-(?:lc|c)\s+([\s\S]+)$/);
  if (unix?.[1]) return stripMatchingEdgeQuotes(unix[1].trim());

  const windows = trimmed.match(
    /^(?:"[^"]*\\)?(?:pwsh|powershell|cmd)(?:\.exe)?"?(?:\s+-[A-Za-z]+(?:\s+[^-\s][^\s]*)?)*\s+(?:-Command|-c|\/c)\s+([\s\S]+)$/i,
  );
  return windows?.[1] ? stripMatchingEdgeQuotes(windows[1].trim()) : trimmed;
}

function stripMatchingEdgeQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function isWindowsShellCommand(command: string): boolean {
  const normalized = command.replace(/^["']|["']$/g, "");
  return /(?:^|\\)(?:pwsh|powershell|cmd)(?:\.exe)?$/i.test(normalized);
}

export function normalizeCommandExecutionCommand(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = unwrapShellCommand(value);
    return normalized.length > 0 ? normalized : undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (parts.length === 0) {
    return undefined;
  }
  if (parts.length >= 3 && (parts[1] === "-lc" || parts[1] === "-c")) {
    const unwrapped = parts[2]?.trim();
    return unwrapped && unwrapped.length > 0 ? unwrapped : undefined;
  }
  if (
    parts.length >= 3 &&
    isWindowsShellCommand(parts[0] ?? "") &&
    /^(-command|-c|\/c)$/i.test(parts[1] ?? "")
  ) {
    const unwrapped = parts.slice(2).join(" ").trim();
    return unwrapped.length > 0 ? stripMatchingEdgeQuotes(unwrapped) : undefined;
  }
  return parts.join(" ");
}

function looksLikeUnifiedDiff(text: string): boolean {
  const normalized = text.trimStart();
  if (!normalized) {
    return false;
  }
  return (
    normalized.startsWith("diff --git") ||
    normalized.startsWith("@@") ||
    normalized.startsWith("--- ") ||
    normalized.startsWith("+++ ")
  );
}

interface CodexApplyPatchDirective {
  kind: "add" | "update" | "delete";
  path: string;
}

function parseCodexApplyPatchDirective(line: string): CodexApplyPatchDirective | null {
  const trimmed = line.trim();
  if (trimmed.startsWith("*** Add File:")) {
    return { kind: "add", path: trimmed.replace("*** Add File:", "").trim() };
  }
  if (trimmed.startsWith("*** Update File:")) {
    return { kind: "update", path: trimmed.replace("*** Update File:", "").trim() };
  }
  if (trimmed.startsWith("*** Delete File:")) {
    return { kind: "delete", path: trimmed.replace("*** Delete File:", "").trim() };
  }
  return null;
}

function looksLikeCodexApplyPatch(text: string): boolean {
  const normalized = text.trimStart();
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith("*** Begin Patch")) {
    return true;
  }
  return text.split(/\r?\n/).some((line) => parseCodexApplyPatchDirective(line) !== null);
}

function normalizeDiffHeaderPath(rawPath: string): string {
  return rawPath.trim().replace(/^["']+|["']+$/g, "");
}

function codexApplyPatchToUnifiedDiff(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  let sawDiffContent = false;

  for (const line of lines) {
    const directive = parseCodexApplyPatchDirective(line);
    if (directive) {
      const path = normalizeDiffHeaderPath(directive.path);
      if (path.length > 0) {
        if (output.length > 0 && output[output.length - 1] !== "") {
          output.push("");
        }
        const left = directive.kind === "add" ? "/dev/null" : `a/${path}`;
        const right = directive.kind === "delete" ? "/dev/null" : `b/${path}`;
        output.push(`diff --git a/${path} b/${path}`);
        output.push(`--- ${left}`);
        output.push(`+++ ${right}`);
        sawDiffContent = true;
      }
      continue;
    }

    const trimmed = line.trim();
    if (
      trimmed === "*** Begin Patch" ||
      trimmed === "*** End Patch" ||
      trimmed === "*** End of File" ||
      trimmed.startsWith("*** Move to:")
    ) {
      continue;
    }

    if (
      line.startsWith("@@") ||
      line.startsWith("+") ||
      line.startsWith("-") ||
      line.startsWith(" ") ||
      line.startsWith("\\ No newline at end of file")
    ) {
      output.push(line);
      sawDiffContent = true;
    }
  }

  if (!sawDiffContent) {
    return text;
  }

  const normalized = output.join("\n").trim();
  return normalized.length > 0 ? normalized : text;
}

function contentToDeletionDiff(filePath: string, content: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const output: string[] = [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ /dev/null`,
  ];
  if (lines.length > 0) {
    output.push(`@@ -1,${lines.length} +0,0 @@`);
    for (const line of lines) {
      output.push(`-${line}`);
    }
  }
  return output.join("\n");
}

function classifyDiffLikeText(text: string): { isDiff: boolean; text: string } {
  if (looksLikeUnifiedDiff(text)) {
    return { isDiff: true, text };
  }
  if (looksLikeCodexApplyPatch(text)) {
    return { isDiff: true, text: codexApplyPatchToUnifiedDiff(text) };
  }
  return { isDiff: false, text };
}

function asEditTextFields(text: string | undefined): { unifiedDiff?: string; newString?: string } {
  if (typeof text !== "string" || text.length === 0) {
    return {};
  }
  const classified = classifyDiffLikeText(text);
  if (classified.isDiff) {
    return { unifiedDiff: truncateDiffText(classified.text) };
  }
  return { newString: text };
}

function asEditFileOutputFields(text: string | undefined): { patch?: string; content?: string } {
  if (typeof text !== "string" || text.length === 0) {
    return {};
  }
  const classified = classifyDiffLikeText(text);
  if (classified.isDiff) {
    return { patch: truncateDiffText(classified.text) };
  }
  return { content: text };
}

function pickFirstPatchLikeString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function hasRenderableEditDetail(detail: ToolCallDetail): boolean {
  if (detail.type !== "edit") {
    return true;
  }
  return (
    (typeof detail.unifiedDiff === "string" && detail.unifiedDiff.trim().length > 0) ||
    (typeof detail.newString === "string" && detail.newString.trim().length > 0) ||
    (typeof detail.oldString === "string" && detail.oldString.trim().length > 0)
  );
}

function hasRenderableDiff(detail: ToolCallDetail): boolean {
  return (
    detail.type === "edit" &&
    typeof detail.unifiedDiff === "string" &&
    detail.unifiedDiff.trim().length > 0
  );
}

/** 本机协议的状态是 inProgress / completed / failed / declined；declined 归为 failed */
function normalizeCodexItemStatus(
  rawStatus: string | undefined,
  error: unknown,
  output: unknown,
): { status: CodexToolCallStatus; error: unknown } {
  if (typeof rawStatus === "string" && rawStatus.trim().toLowerCase() === "declined") {
    return { status: "failed", error: error ?? DECLINED_ERROR };
  }
  return { status: normalizeToolCallStatus(rawStatus, error, output), error };
}

function readStatus(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value.status === "string" ? value.status : undefined;
}

function normalizeCollabAgentChildStatus(status: string): CodexToolCallStatus {
  const normalized = status.trim().toLowerCase();
  switch (normalized) {
    case "error":
    case "errored":
      return "running";
    case "shutdown":
      return "canceled";
    case "notfound":
      return "failed";
    default:
      return normalizeToolCallStatus(status, null, null);
  }
}

function resolveCollabAgentStatus(
  item: z.infer<typeof CodexCollabAgentToolCallItemSchema>,
): CodexToolCallStatus {
  if (item.error !== undefined && item.error !== null) {
    return "failed";
  }

  const parentStatus = normalizeToolCallStatus(item.status, null, null);
  if (parentStatus === "failed") {
    return "failed";
  }

  const childStatuses = Object.values(item.agentsStates ?? {})
    .map(readStatus)
    .filter((status): status is string => typeof status === "string" && status.trim().length > 0)
    .map(normalizeCollabAgentChildStatus);

  if (childStatuses.some((status) => status === "failed")) {
    return "failed";
  }
  if (childStatuses.some((status) => status === "canceled")) {
    return "canceled";
  }
  if (childStatuses.length > 0) {
    return childStatuses.every((status) => status === "completed") ? "completed" : "running";
  }

  return parentStatus;
}

function buildMcpToolName(server: string | undefined, tool: string): string {
  const trimmedTool = tool.trim();
  if (!trimmedTool) {
    return "tool";
  }
  const trimmedServer = typeof server === "string" ? server.trim() : "";
  return trimmedServer.length > 0 ? `${trimmedServer}.${trimmedTool}` : trimmedTool;
}

/** MCP 结果里的图片块替换为占位文本，避免把 base64 塞进时间线 */
function stripMcpToolResultImages(result: unknown): unknown {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    return result;
  }
  let replaced = false;
  const content = result.content.map((block) => {
    if (isRecord(block) && block.type === "image" && typeof block.data === "string") {
      replaced = true;
      return { type: "text", text: "[image]" };
    }
    return block;
  });
  return replaced ? { ...result, content } : result;
}

function toNullableObject(value: Record<string, unknown>): Record<string, unknown> | null {
  return Object.keys(value).length > 0 ? value : null;
}

function mapCommandExecutionItem(
  item: z.infer<typeof CodexCommandExecutionItemSchema>,
): CodexNormalizedToolCallEnvelope {
  const command = normalizeCommandExecutionCommand(item.command);
  const parsedOutput = extractCodexShellOutput(item.aggregatedOutput ?? undefined);
  const input = toNullableObject({
    ...(command !== undefined ? { command } : {}),
    ...(item.cwd !== undefined ? { cwd: item.cwd } : {}),
  });

  const hasExitCode = item.exitCode !== undefined && item.exitCode !== null;
  const output =
    parsedOutput !== undefined || hasExitCode
      ? {
          ...(command !== undefined ? { command } : {}),
          ...(parsedOutput !== undefined ? { output: parsedOutput } : {}),
          ...(hasExitCode ? { exitCode: item.exitCode } : {}),
        }
      : null;

  const { status, error } = normalizeCodexItemStatus(item.status, item.error ?? null, output);
  return {
    callId: item.id,
    name: "shell",
    input,
    output,
    status,
    error,
    cwd: item.cwd ?? null,
  };
}

interface CodexFileChangeEntry {
  path: string;
  kind?: string;
  diff?: string;
}

function parseFileChangePath(
  entry: Record<string, unknown>,
  options?: CodexMapperOptions,
  fallbackPath?: string,
): string | undefined {
  const candidates = [entry.path, entry.file_path, entry.filePath, fallbackPath];
  const rawPath = candidates
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  if (!rawPath) {
    return undefined;
  }
  return normalizeCodexFilePath(rawPath, options?.cwd);
}

function parseFileChangeKind(entry: Record<string, unknown>): string | undefined {
  if (typeof entry.kind === "string" && entry.kind) {
    return entry.kind;
  }
  // codex 0.162：kind 为 { type: "add" | "update" | "delete", move_path? }
  if (isRecord(entry.kind) && typeof entry.kind.type === "string") {
    return entry.kind.type;
  }
  return typeof entry.type === "string" && entry.type ? entry.type : undefined;
}

function parseFileChangeDiff(entry: Record<string, unknown>): string | undefined {
  return pickFirstPatchLikeString([
    entry.diff,
    entry.patch,
    entry.unified_diff,
    entry.unifiedDiff,
    entry.content,
    entry.newString,
  ]);
}

function toFileChangeEntry(
  entry: Record<string, unknown>,
  options?: CodexMapperOptions,
  fallbackPath?: string,
): CodexFileChangeEntry | null {
  const path = parseFileChangePath(entry, options, fallbackPath);
  if (!path) {
    return null;
  }
  const kind = parseFileChangeKind(entry);
  const diff = parseFileChangeDiff(entry);
  return {
    path,
    ...(kind !== undefined ? { kind } : {}),
    ...(diff !== undefined ? { diff } : {}),
  };
}

function parseFileChangeEntries(
  changes: unknown,
  options?: CodexMapperOptions,
): CodexFileChangeEntry[] {
  if (!changes) {
    return [];
  }

  if (Array.isArray(changes)) {
    return changes
      .map((entry) => (isRecord(entry) ? toFileChangeEntry(entry, options) : null))
      .filter((entry): entry is CodexFileChangeEntry => entry !== null);
  }

  if (!isRecord(changes)) {
    return [];
  }

  if (Array.isArray(changes.files)) {
    return parseFileChangeEntries(changes.files, options);
  }

  const singleEntry = toFileChangeEntry(changes, options);
  if (singleEntry) {
    return [singleEntry];
  }

  return Object.entries(changes)
    .map(([path, value]) => {
      if (isRecord(value)) {
        return toFileChangeEntry(value, options, path);
      }
      if (typeof value === "string") {
        const normalizedPath = normalizeCodexFilePath(path.trim(), options?.cwd);
        return normalizedPath ? { path: normalizedPath, diff: value } : null;
      }
      return null;
    })
    .filter((entry): entry is CodexFileChangeEntry => entry !== null);
}

function resolveFileChangeTextFields(file: CodexFileChangeEntry | undefined): {
  unifiedDiff?: string;
  newString?: string;
} {
  if (!file) {
    return {};
  }
  if (file.kind === "delete") {
    if (file.diff) {
      const classified = classifyDiffLikeText(file.diff);
      return {
        unifiedDiff: truncateDiffText(
          classified.isDiff ? classified.text : contentToDeletionDiff(file.path, file.diff),
        ),
      };
    }
    return { unifiedDiff: contentToDeletionDiff(file.path, "") };
  }
  return asEditTextFields(file.diff);
}

function mapFileChangeItem(
  item: z.infer<typeof CodexFileChangeItemSchema>,
  options?: CodexMapperOptions,
): CodexNormalizedToolCallEnvelope {
  const files = parseFileChangeEntries(item.changes, options);

  const fileSummaries = files.map((file) => ({
    path: file.path,
    ...(file.kind !== undefined ? { kind: file.kind } : {}),
  }));

  const output = toNullableObject(
    files.length > 0
      ? {
          files: files.map((file) => ({
            path: file.path,
            ...(file.kind !== undefined ? { kind: file.kind } : {}),
            ...(file.kind === "delete"
              ? { patch: resolveFileChangeTextFields(file).unifiedDiff }
              : asEditFileOutputFields(file.diff)),
          })),
        }
      : {},
  );

  const firstFile = files[0];
  const firstTextFields = resolveFileChangeTextFields(firstFile);
  const hasFirstTextFields = Object.keys(firstTextFields).length > 0;
  const input = toNullableObject({
    ...(files.length > 0 ? { files: fileSummaries } : {}),
    ...(firstFile?.path && hasFirstTextFields ? { path: firstFile.path } : {}),
    ...(firstTextFields.unifiedDiff ? { patch: firstTextFields.unifiedDiff } : {}),
    ...(firstTextFields.newString ? { content: firstTextFields.newString } : {}),
  });

  const { status, error } = normalizeCodexItemStatus(item.status, item.error ?? null, output);
  const addedFile =
    files.length === 1 &&
    firstFile?.kind === "add" &&
    firstTextFields.newString !== undefined &&
    firstTextFields.unifiedDiff === undefined
      ? { path: firstFile.path, content: firstTextFields.newString }
      : undefined;

  return {
    callId: item.id,
    name: "apply_patch",
    input,
    output,
    status,
    error,
    cwd: options?.cwd ?? null,
    ...(files.length > 1 ? { metadata: { files: fileSummaries } } : {}),
    ...(addedFile ? { addedFile } : {}),
  };
}

function mapMcpToolCallItem(
  item: z.infer<typeof CodexMcpToolCallItemSchema>,
  options?: CodexMapperOptions,
): CodexNormalizedToolCallEnvelope | null {
  const tool = item.tool.trim();
  if (!tool) {
    return null;
  }
  const output = stripMcpToolResultImages(item.result ?? null);
  const { status, error } = normalizeCodexItemStatus(item.status, item.error ?? null, output);
  return {
    callId: item.id,
    name: buildMcpToolName(item.server, tool),
    input: item.arguments ?? null,
    output,
    status,
    error,
    cwd: options?.cwd ?? null,
  };
}

/** 本机协议的 webSearch 没有顶层 query 时，从 action 里取 */
function readWebSearchQuery(item: z.infer<typeof CodexWebSearchItemSchema>): string | undefined {
  if (typeof item.query === "string" && item.query.length > 0) {
    return item.query;
  }
  const action = item.action;
  if (!isRecord(action)) {
    return undefined;
  }
  if (typeof action.query === "string" && action.query.length > 0) {
    return action.query;
  }
  if (Array.isArray(action.queries)) {
    const first = action.queries.find((q): q is string => typeof q === "string" && q.length > 0);
    if (first) return first;
  }
  return typeof action.url === "string" && action.url.length > 0 ? action.url : undefined;
}

function mapWebSearchItem(
  item: z.infer<typeof CodexWebSearchItemSchema>,
): CodexNormalizedToolCallEnvelope {
  const query = readWebSearchQuery(item);
  const output = item.action ?? null;
  const { status, error } = normalizeCodexItemStatus(
    item.status ?? "completed",
    item.error ?? null,
    output,
  );
  return {
    callId: item.id,
    name: "web_search",
    input: query !== undefined ? { query } : null,
    output,
    status,
    error,
    cwd: null,
  };
}

function mapCollabAgentToolCallItem(
  item: z.infer<typeof CodexCollabAgentToolCallItemSchema>,
): ToolCallTimelineItem {
  const status = resolveCollabAgentStatus(item);
  return {
    type: "tool_call",
    callId: item.id,
    name: "Sub-agent",
    status,
    error: status === "failed" ? (toolErrorToString(item.error) ?? "子 Agent 失败") : null,
    detail: {
      type: "sub_agent",
      subAgentType: "Sub-agent",
      ...(item.prompt ? { description: item.prompt } : {}),
      log: "",
      actions: [],
    },
  };
}

function mapSubAgentActivityItem(
  item: z.infer<typeof CodexSubAgentActivityItemSchema>,
): ToolCallTimelineItem {
  let nativeName = item.agentPath;
  if (nativeName === "/root") {
    nativeName = "";
  } else if (nativeName.startsWith("/root/")) {
    nativeName = nativeName.slice("/root/".length);
  } else if (/[\\/]/.test(nativeName)) {
    nativeName = nativeName.slice(
      Math.max(nativeName.lastIndexOf("/"), nativeName.lastIndexOf("\\")) + 1,
    );
  }
  const description = nativeName;
  const label =
    nativeName
      .split("/")
      .map((segment) => segment.replace(/[_-]+/g, " ").trim())
      .filter(Boolean)
      .map((segment) => segment[0]?.toUpperCase() + segment.slice(1))
      .join(" / ") || "Sub-agent";
  return {
    type: "tool_call",
    callId: item.id,
    name: "Sub-agent",
    status: item.kind === "interrupted" ? "canceled" : item.kind === "completed" ? "completed" : "running",
    error: null,
    detail: {
      type: "sub_agent",
      subAgentType: label,
      ...(description ? { description } : {}),
      log: "",
      actions: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** 把 codex ThreadItem 映射为 tool_call；非工具类 item（消息、推理等）返回 null */
export function mapCodexToolCallFromThreadItem(
  item: unknown,
  options?: CodexMapperOptions,
): ToolCallTimelineItem | null {
  const parsed = CodexThreadItemSchema.safeParse(item);
  if (!parsed.success) {
    return null;
  }
  const data = parsed.data;
  let envelope: CodexNormalizedToolCallEnvelope | null;
  switch (data.type) {
    case "collabAgentToolCall":
      return mapCollabAgentToolCallItem(data);
    case "subAgentActivity":
      return mapSubAgentActivityItem(data);
    case "commandExecution":
      envelope = mapCommandExecutionItem(data);
      break;
    case "fileChange":
      envelope = mapFileChangeItem(data, options);
      break;
    case "mcpToolCall":
      envelope = mapMcpToolCallItem(data, options);
      break;
    case "webSearch":
      envelope = mapWebSearchItem(data);
      break;
  }
  if (!envelope) {
    return null;
  }
  const name = envelope.name.trim();
  if (!envelope.callId || !name) {
    return null;
  }
  return toToolCallTimelineItem({ ...envelope, name }, resolveCodexToolKind(name));
}
