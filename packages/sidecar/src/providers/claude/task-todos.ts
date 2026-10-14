// Claude Code 新版 Task 工具（TaskCreate / TaskUpdate / TaskList）→ 待办（AgentDeck 原创，design.md 5.3）。
// 会话内维护一张任务表（id → subject / status，保持创建顺序），工具结果到达后更新，items() 即 `todo` 时间线项。

export interface TaskTodoItem {
  text: string;
  completed: boolean;
}

interface TaskEntry {
  subject: string;
  status: string;
}

const TASK_TODO_TOOL_NAMES = new Set(["TaskCreate", "TaskUpdate", "TaskList"]);
const CREATED_TEXT_PATTERN = /Task #(\S+) created/;
const LIST_LINE_PATTERN = /^#(\S+)\s+\[([^\]]+)\]\s*(.*)$/;

/** 以待办形式展示、不发 tool_call 的 Task 工具 */
export function isTaskTodoTool(name: string): boolean {
  return TASK_TODO_TOOL_NAMES.has(name);
}

export class ClaudeTaskTodos {
  private tasks = new Map<string, TaskEntry>();

  items(): TaskTodoItem[] {
    return [...this.tasks.values()].map((task) => ({
      text: task.subject,
      completed: task.status === "completed",
    }));
  }

  /** 应用一次成功的 Task 工具调用；任务表有变化返回 true */
  apply(name: string, input: unknown, resultText: string, structured: unknown): boolean {
    switch (name) {
      case "TaskCreate":
        return this.create(input, resultText, structured);
      case "TaskUpdate":
        return this.update(input);
      case "TaskList":
        return this.sync(resultText, structured);
      default:
        return false;
    }
  }

  private create(input: unknown, resultText: string, structured: unknown): boolean {
    const subject = readString(readRecord(input)?.subject);
    if (!subject) {
      return false;
    }
    const id =
      readId(readRecord(readRecord(structured)?.task)?.id) ??
      CREATED_TEXT_PATTERN.exec(resultText)?.[1] ??
      this.nextNumericId();
    const existing = this.tasks.get(id);
    if (existing && existing.subject === subject) {
      return false;
    }
    this.tasks.set(id, { subject, status: existing?.status ?? "pending" });
    return true;
  }

  private update(input: unknown): boolean {
    const record = readRecord(input);
    const id = readId(record?.taskId);
    const task = id === undefined ? undefined : this.tasks.get(id);
    if (!record || id === undefined || !task) {
      return false;
    }
    const status = readString(record.status);
    if (status === "deleted") {
      return this.tasks.delete(id);
    }
    const subject = readString(record.subject);
    let changed = false;
    if (status && status !== task.status) {
      task.status = status;
      changed = true;
    }
    if (subject && subject !== task.subject) {
      task.subject = subject;
      changed = true;
    }
    return changed;
  }

  /** TaskList：结构化 tasks 优先，其次解析文本行 `#1 [completed] subject`；解析不出任何内容时不动任务表 */
  private sync(resultText: string, structured: unknown): boolean {
    const rows = readListRows(structured) ?? readListTextRows(resultText);
    if (!rows) {
      return false;
    }
    const next = new Map<string, TaskEntry>();
    for (const row of rows) {
      if (row.status !== "deleted") {
        next.set(row.id, { subject: row.subject, status: row.status });
      }
    }
    const changed =
      next.size !== this.tasks.size ||
      [...next].some(([id, task], index) => {
        const current = [...this.tasks][index];
        return !current || current[0] !== id || current[1].subject !== task.subject || current[1].status !== task.status;
      });
    this.tasks = next;
    return changed;
  }

  /** 拿不到 id 时的临时编号：当前最大数字 id + 1（CLI 的 id 是从 1 起的自增数字） */
  private nextNumericId(): string {
    let max = 0;
    for (const id of this.tasks.keys()) {
      const value = Number(id);
      if (Number.isInteger(value) && value > max) {
        max = value;
      }
    }
    return String(max + 1);
  }
}

interface ListRow {
  id: string;
  subject: string;
  status: string;
}

function readListRows(structured: unknown): ListRow[] | null {
  const tasks = readRecord(structured)?.tasks;
  if (!Array.isArray(tasks)) {
    return null;
  }
  return tasks.flatMap((task) => {
    const record = readRecord(task);
    const id = readId(record?.id);
    const subject = readString(record?.subject);
    return id !== undefined && subject ? [{ id, subject, status: readString(record?.status) ?? "pending" }] : [];
  });
}

function readListTextRows(text: string): ListRow[] | null {
  const rows = text.split(/\r?\n/).flatMap((line) => {
    const match = LIST_LINE_PATTERN.exec(line.trim());
    return match?.[1] && match[2] && match[3] ? [{ id: match[1], status: match[2], subject: match[3] }] : [];
  });
  return rows.length > 0 ? rows : null;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return readString(value);
}
