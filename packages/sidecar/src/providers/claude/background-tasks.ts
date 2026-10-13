// Claude 后台任务登记表（AgentDeck 原创，design.md 4.15）：
// 解析 system 的 background_tasks_changed（存活集合对账）/ task_started / task_updated / task_progress / task_notification 与 Bash 工具结果里的输出路径，
// 只登记「后台 Shell」（local_bash 且 is_backgrounded 为 true，或之后 task_updated 转入后台）；子代理 / workflow / 其它类型不登记。
import { open, stat } from "node:fs/promises";

import type {
  AgentBackgroundTask,
  AgentBackgroundTaskOutput,
  AgentBackgroundTaskStatus,
} from "@agentdeck/protocol";

import type { ClaudeBackgroundTasksChangedMessage, ClaudeOutputMessage, ClaudeTaskSystemMessage } from "./stream-json-types.js";

/** 进度类变化推送的最小间隔 */
const PROGRESS_THROTTLE_MS = 1_000;
const OUTPUT_PATH_PATTERN = /Output is being written to:\s*(.+?\.output)/;
const EXIT_CODE_PATTERN = /exit code\s+(-?\d+)/i;
/** 暂存的 tool_use 条数上限（tool_use 先于 task_started 到达，只为关联命令文本） */
const MAX_PENDING_COMMANDS = 200;
const SHELL_TOOL_NAMES = new Set(["Bash", "PowerShell"]);
/** 会话 / 进程结束时仍在运行的任务的错误文案 */
export const SESSION_ENDED_MESSAGE = "会话已结束";
/** 任务不在 background_tasks_changed 存活集合里后，等多久仍无结束通知就对账为已结束 */
const RECONCILE_DELAY_MS = 2_000;
const RECONCILED_SUMMARY = "已结束（未收到完成通知）";
export const TASK_GONE_MESSAGE = "CLI 中已不存在该任务";

interface TaskRecord {
  task: AgentBackgroundTask;
  toolUseId: string | undefined;
  /** 已转入后台（只有后台任务才对外可见） */
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

/** 只有后台 Shell 命令才登记：local_bash；没有 task_type（旧 CLI）时以对应 tool_use 是 Bash / PowerShell 为准 */
function isShellTask(taskType: string | undefined, subagentType: string | undefined, hasShellToolUse: boolean): boolean {
  if (taskType !== undefined) return taskType === "local_bash";
  return !subagentType && hasShellToolUse;
}

/** 从 task_notification 的 summary 解析退出码（形如 `... completed (exit code 0)`），解析不到返回 undefined */
export function parseExitCode(summary: string | undefined): number | undefined {
  const match = summary ? EXIT_CODE_PATTERN.exec(summary) : null;
  return match ? Number(match[1]) : undefined;
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
  /** Shell 工具调用的命令文本：tool_use_id → command（主线程与子代理的都收，按插入顺序淘汰旧的） */
  private readonly shellCommands = new Map<string, string>();
  private readonly onChange: (tasks: AgentBackgroundTask[]) => void;
  private readonly now: () => number;
  private lastEmitAt = 0;
  private timer: NodeJS.Timeout | null = null;
  /** background_tasks_changed 的最新存活集合（REPLACE 语义）；从未收到过为 null */
  private aliveTaskIds: Set<string> | null = null;
  /** 不在存活集合里的 running 任务的对账定时器：taskId → timer */
  private readonly reconcileTimers = new Map<string, NodeJS.Timeout>();

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
    if (message.subtype === "background_tasks_changed") {
      this.onBackgroundTasksChanged(message as ClaudeBackgroundTasksChangedMessage);
      return;
    }
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

  /** assistant 的 tool_use 块：Bash / PowerShell 的 input.command 按 tool_use_id 暂存，task_started 时关联（先后顺序都支持） */
  observeToolUse(toolUseId: string, name: string, input: unknown): void {
    if (!SHELL_TOOL_NAMES.has(name) || !input || typeof input !== "object") return;
    const command = readString((input as Record<string, unknown>).command);
    if (!command) return;
    this.shellCommands.delete(toolUseId);
    this.shellCommands.set(toolUseId, command);
    if (this.shellCommands.size > MAX_PENDING_COMMANDS) {
      const oldest = this.shellCommands.keys().next().value;
      if (oldest !== undefined) this.shellCommands.delete(oldest);
    }
    for (const record of this.records.values()) {
      if (record.toolUseId === toolUseId && record.task.command !== command) {
        record.task.command = command;
        if (record.backgrounded) this.emit(true);
      }
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

  /** 最新存活集合是否含该任务；从未收到过集合返回 undefined */
  isAlive(taskId: string): boolean | undefined {
    return this.aliveTaskIds ? this.aliveTaskIds.has(taskId) : undefined;
  }

  /** stop_task 失败且 CLI 里已无该任务：本地标为已停止并推送 */
  markGone(taskId: string): void {
    const record = this.records.get(taskId);
    if (!record || record.task.status !== "running") return;
    this.cancelReconcile(taskId);
    record.task.status = "stopped";
    record.task.error = TASK_GONE_MESSAGE;
    record.task.endedAt = this.now();
    if (record.backgrounded) this.emit(true);
  }

  /** 进程 / 会话结束：仍在运行的任务标为已停止 */
  markSessionEnded(): void {
    this.clearReconcileTimers();
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
    this.shellCommands.clear();
    this.aliveTaskIds = null;
    this.clearReconcileTimers();
    this.clearTimer();
  }

  // -------------------------------------------------------------------------

  /** 电平信号：当前存活的全部后台任务（REPLACE）。running 但不在集合里的任务 2 秒后对账为已结束 */
  private onBackgroundTasksChanged(msg: ClaudeBackgroundTasksChangedMessage): void {
    const alive = new Set<string>();
    for (const entry of Array.isArray(msg.tasks) ? msg.tasks : []) {
      const id = readString(entry?.task_id);
      if (id) alive.add(id);
    }
    this.aliveTaskIds = alive;
    for (const [taskId, record] of this.records) {
      if (!record.backgrounded || record.task.status !== "running") continue;
      if (alive.has(taskId)) this.cancelReconcile(taskId);
      else this.scheduleReconcile(taskId);
    }
  }

  private scheduleReconcile(taskId: string): void {
    if (this.reconcileTimers.has(taskId)) return;
    const timer = setTimeout(() => {
      this.reconcileTimers.delete(taskId);
      const record = this.records.get(taskId);
      if (!record || record.task.status !== "running" || this.aliveTaskIds?.has(taskId) !== false) return;
      record.task.status = "completed";
      record.task.endedAt = this.now();
      record.task.summary = RECONCILED_SUMMARY;
      if (record.backgrounded) this.emit(true);
    }, RECONCILE_DELAY_MS);
    timer.unref?.();
    this.reconcileTimers.set(taskId, timer);
  }

  private cancelReconcile(taskId: string): void {
    const timer = this.reconcileTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.reconcileTimers.delete(taskId);
    }
  }

  private clearReconcileTimers(): void {
    for (const timer of this.reconcileTimers.values()) clearTimeout(timer);
    this.reconcileTimers.clear();
  }

  private onStarted(taskId: string, msg: ClaudeTaskSystemMessage): void {
    const toolUseId = readString(msg.tool_use_id);
    const description = readString(msg.description) ?? "";
    const existing = this.records.get(taskId);
    if (existing) {
      // 同一 task 再次公告（恢复等）：只补描述与 tool_use_id
      if (description) existing.task.description = description;
      existing.toolUseId = toolUseId ?? existing.toolUseId;
      if (msg.is_backgrounded === true) existing.backgrounded = true;
      if (existing.backgrounded) this.emit(true);
      return;
    }
    const command = toolUseId ? this.shellCommands.get(toolUseId) : undefined;
    if (!isShellTask(readString(msg.task_type), readString(msg.subagent_type), command !== undefined)) return;
    const record: TaskRecord = {
      task: {
        taskId,
        kind: "command",
        description,
        status: "running",
        startedAt: this.now(),
        ...(command ? { command } : {}),
      },
      toolUseId,
      // CLI 对前台 Bash 也发 task_started（is_backgrounded: false）：转入后台才对外可见
      backgrounded: msg.is_backgrounded === true,
      outputPath: undefined,
    };
    this.records.set(taskId, record);
    const pending = toolUseId ? this.pendingOutputPaths.get(toolUseId) : undefined;
    if (toolUseId && pending) {
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
    else this.dropIfForegroundEnded(record);
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
    if (summary) {
      record.task.summary = summary;
      const exitCode = parseExitCode(summary);
      if (exitCode !== undefined) record.task.exitCode = exitCode;
    }
    const outputFile = readString(msg.output_file);
    if (outputFile && !record.outputPath) {
      this.setOutputPath(record, outputFile, false);
    }
    mergeUsage(record, msg.usage);
    if (record.backgrounded) this.emit(true);
    else this.dropIfForegroundEnded(record);
  }

  private applyStatus(record: TaskRecord, status: AgentBackgroundTaskStatus, endTime: number | undefined): void {
    record.task.status = status;
    if (status === "running") {
      delete record.task.endedAt;
    } else {
      record.task.endedAt = endTime ?? record.task.endedAt ?? this.now();
    }
  }

  /** 未转入后台就结束的前台命令不会再出现，释放记录 */
  private dropIfForegroundEnded(record: TaskRecord): void {
    if (!record.backgrounded && record.task.status !== "running") {
      this.records.delete(record.task.taskId);
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
