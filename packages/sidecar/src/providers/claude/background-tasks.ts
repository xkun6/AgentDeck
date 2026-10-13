// Claude 后台任务登记表（AgentDeck 原创，design.md 4.15）：
// 解析 system 的 task_started / task_updated / task_progress / task_notification 与 Bash 工具结果里的输出路径，
// 只登记「后台」任务（local_bash；local_agent / local_workflow / 其它仅在 is_backgrounded 为 true 时）。
import { open, stat } from "node:fs/promises";

import type {
  AgentBackgroundTask,
  AgentBackgroundTaskKind,
  AgentBackgroundTaskOutput,
  AgentBackgroundTaskStatus,
} from "@agentdeck/protocol";

import type { ClaudeOutputMessage, ClaudeTaskSystemMessage } from "./stream-json-types.js";

/** 进度类变化推送的最小间隔 */
const PROGRESS_THROTTLE_MS = 1_000;
const OUTPUT_PATH_PATTERN = /Output is being written to:\s*(.+?\.output)/;
/** 会话 / 进程结束时仍在运行的任务的错误文案 */
export const SESSION_ENDED_MESSAGE = "会话已结束";

interface TaskRecord {
  task: AgentBackgroundTask;
  toolUseId: string | undefined;
  backgrounded: boolean;
  /** CLI 为该任务报告过的输出文件路径（只读这个路径） */
  outputPath: string | undefined;
}

export interface ClaudeBackgroundTaskRegistryOptions {
  onChange: (tasks: AgentBackgroundTask[]) => void;
  now?: () => number;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function kindOf(taskType: string | undefined, subagentType: string | undefined): AgentBackgroundTaskKind | null {
  switch (taskType) {
    case "local_bash":
      return "command";
    case "local_agent":
      return "agent";
    case "local_workflow":
      return "workflow";
    case undefined:
      // 早于 task_type 的版本：有 subagent_type 才是子代理；否则无从判断，忽略
      return subagentType ? "agent" : null;
    default:
      return "other";
  }
}

/** pending / paused → running；killed → stopped；其余未知值返回 undefined（保持原状态） */
function mapStatus(value: unknown): AgentBackgroundTaskStatus | undefined {
  switch (value) {
    case "pending":
    case "running":
    case "paused":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "killed":
    case "stopped":
      return "stopped";
    default:
      return undefined;
  }
}

export class ClaudeBackgroundTaskRegistry {
  private readonly records = new Map<string, TaskRecord>();
  /** 先于 task_started 到达的输出路径：tool_use_id → path */
  private readonly pendingOutputPaths = new Map<string, string>();
  private readonly onChange: (tasks: AgentBackgroundTask[]) => void;
  private readonly now: () => number;
  private lastEmitAt = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: ClaudeBackgroundTaskRegistryOptions) {
    this.onChange = options.onChange;
    this.now = options.now ?? Date.now;
  }

  /** 已登记（后台）任务，按开始时间升序 */
  list(): AgentBackgroundTask[] {
    return [...this.records.values()]
      .filter((record) => record.backgrounded)
      .map((record) => ({ ...record.task, ...(record.task.usage ? { usage: { ...record.task.usage } } : {}) }));
  }

  has(taskId: string): boolean {
    return this.records.get(taskId)?.backgrounded === true;
  }

  getStatus(taskId: string): AgentBackgroundTaskStatus | undefined {
    const record = this.records.get(taskId);
    return record?.backgrounded ? record.task.status : undefined;
  }

  getOutputPath(taskId: string): string | undefined {
    const record = this.records.get(taskId);
    return record?.backgrounded ? record.outputPath : undefined;
  }

  /** system 消息：task_started / task_updated / task_progress / task_notification */
  observe(message: ClaudeOutputMessage): void {
    if (message.type !== "system") return;
    const msg = message as ClaudeTaskSystemMessage;
    const taskId = readString(msg.task_id);
    if (!taskId) return;
    switch (message.subtype) {
      case "task_started":
        this.onStarted(taskId, msg);
        return;
      case "task_updated":
        this.onUpdated(taskId, msg);
        return;
      case "task_progress":
        this.onProgress(taskId, msg);
        return;
      case "task_notification":
        this.onNotification(taskId, msg);
        return;
      default:
        return;
    }
  }

  /** 工具结果文本：后台 Bash 的结果里带输出文件路径，用 tool_use_id 关联到任务 */
  observeToolResult(toolUseId: string, text: string): void {
    const path = OUTPUT_PATH_PATTERN.exec(text)?.[1]?.trim();
    if (!path) return;
    for (const record of this.records.values()) {
      if (record.toolUseId === toolUseId && record.task.kind === "command") {
        this.setOutputPath(record, path);
        return;
      }
    }
    this.pendingOutputPaths.set(toolUseId, path);
  }

  /** 进程 / 会话结束：仍在运行的任务标为已停止 */
  markSessionEnded(): void {
    const endedAt = this.now();
    let changed = false;
    for (const record of this.records.values()) {
      if (record.task.status !== "running") continue;
      record.task.status = "stopped";
      record.task.error = SESSION_ENDED_MESSAGE;
      record.task.endedAt = endedAt;
      changed = changed || record.backgrounded;
    }
    if (changed) this.emit(true);
  }

  reset(): void {
    this.records.clear();
    this.pendingOutputPaths.clear();
    this.clearTimer();
  }

  // -------------------------------------------------------------------------

  private onStarted(taskId: string, msg: ClaudeTaskSystemMessage): void {
    const toolUseId = readString(msg.tool_use_id);
    const description = readString(msg.description) ?? "";
    const existing = this.records.get(taskId);
    if (existing) {
      // 同一 task 再次公告（恢复等）：只补描述与 tool_use_id
      if (description) existing.task.description = description;
      existing.toolUseId = toolUseId ?? existing.toolUseId;
      if (existing.backgrounded) this.emit(true);
      return;
    }
    const kind = kindOf(readString(msg.task_type), readString(msg.subagent_type));
    if (!kind) return;
    const record: TaskRecord = {
      task: { taskId, kind, description, status: "running", startedAt: this.now() },
      toolUseId,
      // 后台命令不论 is_backgrounded 都登记；其它类型要显式转入后台
      backgrounded: kind === "command" || msg.is_backgrounded === true,
      outputPath: undefined,
    };
    this.records.set(taskId, record);
    const pending = toolUseId ? this.pendingOutputPaths.get(toolUseId) : undefined;
    if (toolUseId && pending && kind === "command") {
      this.pendingOutputPaths.delete(toolUseId);
      record.outputPath = pending;
      record.task.hasOutput = true;
    }
    if (record.backgrounded) this.emit(true);
  }

  private onUpdated(taskId: string, msg: ClaudeTaskSystemMessage): void {
    const record = this.records.get(taskId);
    const patch = msg.patch;
    if (!record || !patch) return;
    if (patch.is_backgrounded === true) record.backgrounded = true;
    const description = readString(patch.description);
    if (description) record.task.description = description;
    const status = mapStatus(patch.status);
    if (status) this.applyStatus(record, status, readNumber(patch.end_time));
    const error = readString(patch.error);
    if (error) record.task.error = error;
    if (record.backgrounded) this.emit(true);
  }

  private onProgress(taskId: string, msg: ClaudeTaskSystemMessage): void {
    const record = this.records.get(taskId);
    if (!record) return;
    mergeUsage(record, msg.usage);
    const lastTool = readString(msg.last_tool_name);
    if (lastTool) record.task.lastToolName = lastTool;
    const summary = readString(msg.summary);
    if (summary) record.task.summary = summary;
    if (record.backgrounded) this.emit(false);
  }

  private onNotification(taskId: string, msg: ClaudeTaskSystemMessage): void {
    const record = this.records.get(taskId);
    if (!record) return;
    const status = mapStatus(msg.status);
    if (status) this.applyStatus(record, status, undefined);
    const summary = readString(msg.summary);
    if (summary) record.task.summary = summary;
    const outputFile = readString(msg.output_file);
    // 子代理 / workflow 的 output_file 是 JSONL transcript，不作为「输出」展示
    if (outputFile && record.task.kind === "command" && !record.outputPath) {
      this.setOutputPath(record, outputFile, false);
    }
    mergeUsage(record, msg.usage);
    if (record.backgrounded) this.emit(true);
  }

  private applyStatus(record: TaskRecord, status: AgentBackgroundTaskStatus, endTime: number | undefined): void {
    record.task.status = status;
    if (status === "running") {
      delete record.task.endedAt;
    } else {
      record.task.endedAt = endTime ?? record.task.endedAt ?? this.now();
    }
  }

  private setOutputPath(record: TaskRecord, path: string, emit = true): void {
    record.outputPath = path;
    record.task.hasOutput = true;
    if (emit && record.backgrounded) this.emit(true);
  }

  /** immediate：登记 / 状态变化立即推；进度类变化节流到约 1 秒一次（尾部补发最新整表） */
  private emit(immediate: boolean): void {
    const now = this.now();
    if (immediate || now - this.lastEmitAt >= PROGRESS_THROTTLE_MS) {
      this.flush(now);
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush(this.now());
    }, PROGRESS_THROTTLE_MS - (now - this.lastEmitAt));
    this.timer.unref?.();
  }

  private flush(now: number): void {
    this.clearTimer();
    this.lastEmitAt = now;
    this.onChange(this.list());
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

function mergeUsage(record: TaskRecord, usage: ClaudeTaskSystemMessage["usage"]): void {
  if (!usage) return;
  const totalTokens = readNumber(usage.total_tokens);
  const toolUses = readNumber(usage.tool_uses);
  const durationMs = readNumber(usage.duration_ms);
  record.task.usage = {
    ...record.task.usage,
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(toolUses !== undefined ? { toolUses } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

/** 读文件尾部：超过 maxBytes 时只取最后 maxBytes 字节，并丢弃不完整的首行；文件不存在返回空 */
export async function readFileTail(path: string, maxBytes: number): Promise<AgentBackgroundTaskOutput> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { text: "", truncated: false, size: 0 };
    }
    throw error;
  }
  const length = Math.min(size, maxBytes);
  if (length === 0) {
    return { text: "", truncated: false, size };
  }
  const handle = await open(path, "r");
  let buffer: Buffer;
  try {
    buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    buffer = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const truncated = size > maxBytes;
  let start = 0;
  if (truncated) {
    const newline = buffer.indexOf(0x0a);
    if (newline >= 0) {
      start = newline + 1;
    } else {
      // 整段没有换行：只跳过被截断的 UTF-8 续字节
      while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
    }
  }
  return { text: buffer.subarray(start).toString("utf8"), truncated, size };
}
