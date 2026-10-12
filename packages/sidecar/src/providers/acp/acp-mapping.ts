// Derived from paseo packages/server/src/server/agent/providers/acp-agent.ts (Apache-2.0); modified for AgentDeck
// ACP ↔ AgentDeck 协议的纯映射函数：工具调用快照合并与 detail 映射、plan→todo、权限选项、prompt 转换、usage。
// 改动：detail 收敛到 AgentDeck 精简 ToolCallDetail（去掉 icon / code 等字段），不支持 ACP terminal 能力。
import type {
  ContentBlock,
  ModelInfo,
  PermissionOption,
  PermissionOptionKind,
  Plan,
  PromptCapabilities,
  SessionMode,
  ToolCall,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus as AcpToolCallStatus,
  ToolCallUpdate,
  ToolKind,
  Usage,
  UsageUpdate,
} from "@agentclientprotocol/sdk";
import type {
  AgentMode,
  AgentModelDefinition,
  AgentPermissionAction,
  AgentPermissionResponse,
  AgentPromptInput,
  AgentTimelineItem,
  AgentUsage,
  ToolCallDetail,
  ToolCallStatus,
  ToolCallTimelineItem,
} from "@agentdeck/protocol";

/** 按 toolCallId 合并后的工具调用快照 */
export interface AcpToolSnapshot {
  toolCallId: string;
  title: string;
  kind: ToolKind | null;
  status: AcpToolCallStatus | null;
  content: ToolCallContent[] | null;
  locations: ToolCallLocation[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
}

/** tool_call / tool_call_update 合并：update 中出现的字段覆盖旧值（null 也算出现） */
export function mergeToolSnapshot(
  update: ToolCall | ToolCallUpdate,
  previous?: AcpToolSnapshot,
): AcpToolSnapshot {
  return {
    toolCallId: update.toolCallId,
    title: update.title ?? previous?.title ?? update.toolCallId,
    kind: update.kind ?? previous?.kind ?? null,
    status: update.status ?? previous?.status ?? null,
    content: update.content !== undefined ? update.content : (previous?.content ?? null),
    locations: update.locations !== undefined ? update.locations : (previous?.locations ?? null),
    rawInput: update.rawInput !== undefined ? update.rawInput : previous?.rawInput,
    rawOutput: update.rawOutput !== undefined ? update.rawOutput : previous?.rawOutput,
  };
}

export function mapToolStatus(status: AcpToolCallStatus | null | undefined): ToolCallStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "running";
  }
}

export function toolSnapshotToTimelineItem(
  snapshot: AcpToolSnapshot,
  statusOverride?: ToolCallStatus,
): ToolCallTimelineItem {
  const status = statusOverride ?? mapToolStatus(snapshot.status);
  return {
    type: "tool_call",
    callId: snapshot.toolCallId,
    name: snapshot.kind ?? snapshot.title,
    status,
    detail: mapToolDetail(snapshot),
    error: status === "failed" ? readErrorMessage(snapshot.rawOutput) : null,
    metadata: compact({ kind: snapshot.kind ?? undefined, title: snapshot.title }),
  };
}

export function mapToolDetail(snapshot: AcpToolSnapshot): ToolCallDetail {
  const firstLocation = snapshot.locations?.[0]?.path;
  const text = extractToolText(snapshot.content);
  const diff = extractDiff(snapshot.content);
  const rawInput = readRecord(snapshot.rawInput);
  const rawOutput = readRecord(snapshot.rawOutput);

  switch (snapshot.kind) {
    case "execute":
      return compact({
        type: "shell",
        command:
          buildShellCommand(rawInput) ?? readString(rawInput, ["cmd"]) ?? snapshot.title,
        cwd: readString(rawInput, ["cwd"]),
        output: text ?? readString(rawOutput, ["output", "stdout", "text"]),
        exitCode: readNumber(rawOutput, ["exitCode", "exit_code"]),
      });
    case "read":
      return compact({
        type: "read",
        filePath:
          firstLocation ?? readString(rawInput, ["path", "filePath", "file_path", "file"]) ??
          snapshot.title,
        content: text ?? readString(rawOutput, ["content", "text"]),
        offset: readNumber(rawInput, ["offset", "line"]),
        limit: readNumber(rawInput, ["limit"]),
      });
    case "edit":
    case "delete":
      return compact({
        type: "edit",
        filePath:
          diff?.path ??
          firstLocation ??
          readString(rawInput, ["path", "filePath", "file_path", "file"]) ??
          snapshot.title,
        oldString: diff ? (diff.oldText ?? undefined) : readString(rawInput, ["oldText", "oldString", "old_string"]),
        newString:
          snapshot.kind === "delete"
            ? ""
            : diff
              ? diff.newText
              : readString(rawInput, ["newText", "newString", "new_string"]),
        unifiedDiff: diff ? undefined : text,
      });
    case "search":
      return compact({
        type: "search",
        query: readString(rawInput, ["query", "pattern"]) ?? snapshot.title,
        toolName: "search" as const,
        content: text ?? readString(rawOutput, ["content", "text"]),
        filePaths: snapshot.locations?.map((location) => location.path),
      });
    case "fetch":
      return compact({
        type: "fetch",
        url: readString(rawInput, ["url"]) ?? snapshot.title,
        prompt: readString(rawInput, ["prompt"]),
        result: text ?? readString(rawOutput, ["result", "text", "content"]),
      });
    case "think":
    case "switch_mode":
      return compact({
        type: "plain_text",
        label: snapshot.title,
        text: text ?? stringifyUnknown(snapshot.kind === "think" ? snapshot.rawOutput : snapshot.rawInput),
      });
    default:
      if (text) {
        return { type: "plain_text", label: snapshot.title, text };
      }
      return { type: "unknown", input: snapshot.rawInput ?? null, output: snapshot.rawOutput ?? null };
  }
}

export function planToTodo(plan: Plan): AgentTimelineItem {
  return {
    type: "todo",
    items: plan.entries.map((entry) => ({
      text: entry.content,
      completed: entry.status === "completed",
    })),
  };
}

/** 消息 chunk 只取文本内容 */
export function textFromContentBlock(content: ContentBlock): string | undefined {
  return content.type === "text" && content.text ? content.text : undefined;
}

// ---------------------------------------------------------------------------
// 权限
// ---------------------------------------------------------------------------

export function permissionBehavior(kind: PermissionOptionKind): "allow" | "deny" {
  return kind === "allow_once" || kind === "allow_always" ? "allow" : "deny";
}

export function permissionActions(options: PermissionOption[]): AgentPermissionAction[] {
  return options.map((option) => ({
    id: option.optionId,
    label: option.name,
    behavior: permissionBehavior(option.kind),
  }));
}

/**
 * 选出要回给 agent 的选项：
 * - 带 selectedActionId：按 optionId 精确匹配（找不到返回 undefined，由调用方报错）；
 * - 否则 allow 依次找 allow_once → allow_always，deny 依次找 reject_once → reject_always；
 * - 都没有返回 null（回 cancelled）。
 */
export function selectPermissionOption(
  options: PermissionOption[],
  response: AgentPermissionResponse,
): PermissionOption | null | undefined {
  if (response.selectedActionId !== undefined) {
    return options.find((option) => option.optionId === response.selectedActionId);
  }
  const order: PermissionOptionKind[] =
    response.behavior === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of order) {
    const match = options.find((option) => option.kind === kind);
    if (match) {
      return match;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// prompt / 目录 / usage
// ---------------------------------------------------------------------------

/** AgentDeck prompt → ACP ContentBlock[]；agent 未声明 image 能力时丢弃图片并回调 onDroppedImage */
export function toAcpPrompt(
  prompt: AgentPromptInput,
  capabilities: PromptCapabilities | null | undefined,
  onDroppedImage?: () => void,
): ContentBlock[] {
  if (typeof prompt === "string") {
    return [{ type: "text", text: prompt }];
  }
  const blocks: ContentBlock[] = [];
  for (const part of prompt) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
    } else if (capabilities?.image) {
      blocks.push({ type: "image", data: part.data, mimeType: part.mimeType });
    } else {
      onDroppedImage?.();
    }
  }
  return blocks;
}

export function toModelDefinitions(
  provider: string,
  models: ModelInfo[] | undefined,
  currentModelId: string | null,
): AgentModelDefinition[] {
  return (models ?? []).map((model) =>
    compact({
      provider,
      id: model.modelId,
      label: model.name,
      description: model.description ?? undefined,
      isDefault: model.modelId === currentModelId ? true : undefined,
    }),
  );
}

export function toAgentModes(modes: SessionMode[] | undefined): AgentMode[] {
  return (modes ?? []).map((mode) =>
    compact({ id: mode.id, label: mode.name, description: mode.description ?? undefined }),
  );
}

export function fromAcpUsage(usage: Usage): AgentUsage {
  return compact({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedReadTokens ?? undefined,
  });
}

export function fromAcpUsageUpdate(update: UsageUpdate): AgentUsage {
  return compact({
    contextWindowMaxTokens: update.size,
    contextWindowUsedTokens: update.used,
    totalCostUsd:
      update.cost && update.cost.currency.toUpperCase() === "USD" ? update.cost.amount : undefined,
  });
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function extractToolText(content: ToolCallContent[] | null | undefined): string | undefined {
  if (!content) {
    return undefined;
  }
  const parts: string[] = [];
  for (const item of content) {
    if (item.type === "content") {
      const text = contentBlockToText(item.content);
      if (text) {
        parts.push(text);
      }
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function extractDiff(
  content: ToolCallContent[] | null | undefined,
): Extract<ToolCallContent, { type: "diff" }> | undefined {
  return content?.find(
    (item): item is Extract<ToolCallContent, { type: "diff" }> => item.type === "diff",
  );
}

function contentBlockToText(content: ContentBlock): string {
  switch (content.type) {
    case "text":
      return content.text;
    case "resource_link":
      return content.title ?? content.uri;
    case "resource":
      return "text" in content.resource
        ? content.resource.text
        : `[resource:${content.resource.mimeType ?? "binary"}]`;
    case "image":
      return "[image]";
    case "audio":
      return "[audio]";
    default:
      return "";
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function readNumber(record: Record<string, unknown> | null, keys: string[]): number | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function buildShellCommand(record: Record<string, unknown> | null): string | undefined {
  if (!record) {
    return undefined;
  }
  const raw = record["command"];
  if (Array.isArray(raw)) {
    const parts = raw.filter((value): value is string => typeof value === "string");
    return parts.length > 0 ? parts.join(" ") : undefined;
  }
  const command = readString(record, ["command"]);
  if (!command) {
    return undefined;
  }
  const args = Array.isArray(record["args"])
    ? record["args"].filter((value): value is string => typeof value === "string")
    : [];
  return args.length > 0 ? `${command} ${args.join(" ")}` : command;
}

function readErrorMessage(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  return readString(readRecord(value), ["message", "error"]) ?? "工具调用失败";
}

function stringifyUnknown(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 去掉值为 undefined 的键，保持事件 JSON 干净 */
function compact<T extends object>(value: T): T {
  for (const key of Object.keys(value) as Array<keyof T>) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }
  return value;
}
