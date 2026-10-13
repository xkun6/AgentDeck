import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { AgentSnapshot, AgentStatus, AgentStreamEnvelope } from "@agentdeck/protocol";

import { createSilentLogger, type Logger } from "../logger.js";

/** meta.json 的内容：快照中除 pendingPermissions / activeTurnId 外的全部字段（design.md 4.5） */
export type PersistedAgentMeta = Omit<AgentSnapshot, "pendingPermissions" | "activeTurnId">;

export const META_FILE = "meta.json";
export const TIMELINE_FILE = "timeline.jsonl";
export const META_DEBOUNCE_MS = 500;

/** Windows 下目标文件被杀毒 / 索引进程短暂占用时 rename 会报这些错误，重试即可 */
const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_MAX_ATTEMPTS = 6;
const RENAME_RETRY_BASE_MS = 20;

/** agentId 只允许安全字符（防止被篡改的目录名逃出 agents 目录） */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

const STATUSES: ReadonlySet<AgentStatus> = new Set([
  "starting",
  "idle",
  "running",
  "error",
  "closed",
  "dormant",
]);

export interface AgentStoreOptions {
  /** AGENTDECK_DATA_DIR */
  dataDir: string;
  logger?: Logger;
  /** meta 防抖窗口，默认 500ms */
  debounceMs?: number;
}

export interface LoadedTimeline {
  entries: AgentStreamEnvelope[];
  /** 文件中最大的 seq，无条目为 0 */
  lastSeq: number;
}

/**
 * 会话持久化（design.md 4.5）：`<dataDir>/agents/<agentId>/{meta.json,timeline.jsonl}`。
 *
 * - timeline 逐条追加（同一 agent 的待写行合批后一次 appendFile）；
 * - meta 以「写临时文件 + rename」原子更新，500ms 防抖，`flushMeta` / `flushAll` 强制落盘；
 * - 同一 agent 的所有写操作串在一条 Promise 链上，保证顺序；写失败只记日志，不抛给调用方；
 * - 读取时损坏的行 / 文件记日志后跳过。
 */
export class AgentStore {
  readonly agentsDir: string;

  private readonly logger: Logger;
  private readonly debounceMs: number;
  /** 每个 agent 的写入链 */
  private readonly chains = new Map<string, Promise<void>>();
  /** 待追加的 timeline 行 */
  private readonly pendingLines = new Map<string, string[]>();
  /** 已排进写入链、尚未执行的追加任务 */
  private readonly appendScheduled = new Set<string>();
  /** meta 的取值函数：写入时才取，保证落盘的是最新状态 */
  private readonly metaSources = new Map<string, () => PersistedAgentMeta>();
  private readonly metaTimers = new Map<string, NodeJS.Timeout>();
  private readonly ensuredDirs = new Set<string>();
  /** timeline 文件末尾是不完整的行（上次写入中途崩溃）：下次追加前先补换行 */
  private readonly needsNewline = new Set<string>();
  private readonly deleted = new Set<string>();

  constructor(options: AgentStoreOptions) {
    this.agentsDir = path.join(options.dataDir, "agents");
    this.logger = options.logger ?? createSilentLogger();
    this.debounceMs = options.debounceMs ?? META_DEBOUNCE_MS;
  }

  // -------------------------------------------------------------------------
  // 读取
  // -------------------------------------------------------------------------

  /** 扫描全部 meta.json；损坏或不合法的记日志后跳过，绝不抛错 */
  async loadAll(): Promise<PersistedAgentMeta[]> {
    let names: string[];
    try {
      const dirents = await readdir(this.agentsDir, { withFileTypes: true });
      names = dirents.filter((dirent) => dirent.isDirectory()).map((dirent) => dirent.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn("扫描会话目录 %s 失败：%s", this.agentsDir, String(error));
      }
      return [];
    }

    const metas: PersistedAgentMeta[] = [];
    for (const name of names) {
      if (!SAFE_ID.test(name)) {
        this.logger.warn("跳过非法的会话目录名：%s", name);
        continue;
      }
      const file = path.join(this.agentsDir, name, META_FILE);
      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch (error) {
        this.logger.warn("读取 %s 失败，跳过：%s", file, String(error));
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        this.logger.warn("%s 不是合法 JSON，跳过：%s", file, String(error));
        continue;
      }
      const meta = normalizeMeta(parsed, name);
      if (!meta) {
        this.logger.warn("%s 缺少必要字段或 id 与目录名不符，跳过", file);
        continue;
      }
      this.ensuredDirs.add(name);
      metas.push(meta);
    }
    return metas;
  }

  /** 读取 timeline.jsonl；损坏的行记日志后跳过 */
  async readTimeline(agentId: string): Promise<LoadedTimeline> {
    await this.drain(agentId);
    const file = this.timelinePath(agentId);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn("读取 %s 失败：%s", file, String(error));
      }
      return { entries: [], lastSeq: 0 };
    }
    if (raw.length > 0 && !raw.endsWith("\n")) {
      this.needsNewline.add(agentId);
    }

    const entries: AgentStreamEnvelope[] = [];
    let lastSeq = 0;
    let skipped = 0;
    for (const line of raw.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        skipped += 1;
        continue;
      }
      if (!isEnvelope(parsed) || parsed.seq <= lastSeq) {
        skipped += 1;
        continue;
      }
      lastSeq = parsed.seq;
      entries.push(parsed);
    }
    if (skipped > 0) {
      this.logger.warn("%s 中有 %d 行损坏或乱序，已跳过", file, skipped);
    }
    return { entries, lastSeq };
  }

  // -------------------------------------------------------------------------
  // 写入
  // -------------------------------------------------------------------------

  /** 追加一条 timeline（异步落盘，同一 agent 的多条合批写入） */
  appendEntry(agentId: string, envelope: AgentStreamEnvelope): void {
    if (this.deleted.has(agentId)) {
      return;
    }
    let lines = this.pendingLines.get(agentId);
    if (!lines) {
      lines = [];
      this.pendingLines.set(agentId, lines);
    }
    lines.push(`${JSON.stringify(envelope)}\n`);
    if (!this.appendScheduled.has(agentId)) {
      this.appendScheduled.add(agentId);
      this.enqueue(agentId, () => this.writePendingLines(agentId));
    }
  }

  /** 标记 meta 需要落盘（500ms 防抖）；`source` 在真正写入时才调用 */
  scheduleMeta(agentId: string, source: () => PersistedAgentMeta): void {
    if (this.deleted.has(agentId)) {
      return;
    }
    this.metaSources.set(agentId, source);
    if (this.metaTimers.has(agentId)) {
      return;
    }
    const timer = setTimeout(() => {
      this.metaTimers.delete(agentId);
      void this.flushMeta(agentId);
    }, this.debounceMs);
    timer.unref?.();
    this.metaTimers.set(agentId, timer);
  }

  /** 立即落盘 meta（若有待写）；resolve 时该 agent 之前的所有写入都已完成 */
  flushMeta(agentId: string, source?: () => PersistedAgentMeta): Promise<void> {
    if (this.deleted.has(agentId)) {
      return Promise.resolve();
    }
    if (source) {
      this.metaSources.set(agentId, source);
    }
    const timer = this.metaTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this.metaTimers.delete(agentId);
    }
    if (this.metaSources.has(agentId)) {
      this.enqueue(agentId, () => this.writeMeta(agentId));
    }
    return this.drain(agentId);
  }

  /** 强制落盘全部 agent 的 meta 与 timeline（turn 结束 / shutdown 时用） */
  async flushAll(): Promise<void> {
    const ids = new Set([...this.metaSources.keys(), ...this.chains.keys()]);
    await Promise.all(Array.from(ids, (agentId) => this.flushMeta(agentId)));
  }

  /** 删除 agent 的磁盘目录；之后对该 agent 的写入全部忽略。删除失败抛错 */
  async deleteAgent(agentId: string): Promise<void> {
    if (!SAFE_ID.test(agentId)) {
      throw new Error(`非法的 agentId：${agentId}`);
    }
    this.deleted.add(agentId);
    const timer = this.metaTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this.metaTimers.delete(agentId);
    }
    this.metaSources.delete(agentId);
    this.pendingLines.delete(agentId);
    await this.drain(agentId);
    this.chains.delete(agentId);
    this.ensuredDirs.delete(agentId);
    this.needsNewline.delete(agentId);
    try {
      // maxRetries 覆盖 Windows 上 EBUSY / EPERM / ENOTEMPTY 的短暂占用
      await rm(this.agentDir(agentId), {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    } catch (error) {
      this.deleted.delete(agentId);
      throw error;
    }
  }

  agentDir(agentId: string): string {
    return path.join(this.agentsDir, agentId);
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private metaPath(agentId: string): string {
    return path.join(this.agentDir(agentId), META_FILE);
  }

  private timelinePath(agentId: string): string {
    return path.join(this.agentDir(agentId), TIMELINE_FILE);
  }

  private enqueue(agentId: string, task: () => Promise<void>): void {
    const previous = this.chains.get(agentId) ?? Promise.resolve();
    const next = previous.then(task).catch((error: unknown) => {
      this.logger.error("写入 agent %s 的持久化数据失败：%s", agentId, String(error));
    });
    this.chains.set(agentId, next);
  }

  private async drain(agentId: string): Promise<void> {
    // 等待期间可能有新任务入链，循环直到链尾稳定
    for (;;) {
      const chain = this.chains.get(agentId);
      if (!chain) {
        return;
      }
      await chain;
      if (this.chains.get(agentId) === chain) {
        return;
      }
    }
  }

  private async ensureDir(agentId: string): Promise<void> {
    if (this.ensuredDirs.has(agentId)) {
      return;
    }
    await mkdir(this.agentDir(agentId), { recursive: true });
    this.ensuredDirs.add(agentId);
  }

  private async writePendingLines(agentId: string): Promise<void> {
    this.appendScheduled.delete(agentId);
    const lines = this.pendingLines.get(agentId);
    if (!lines || lines.length === 0 || this.deleted.has(agentId)) {
      return;
    }
    this.pendingLines.set(agentId, []);
    await this.ensureDir(agentId);
    const prefix = this.needsNewline.delete(agentId) ? "\n" : "";
    try {
      await appendFile(this.timelinePath(agentId), prefix + lines.join(""), "utf8");
    } catch (error) {
      if (prefix) {
        this.needsNewline.add(agentId);
      }
      throw error;
    }
  }

  private async writeMeta(agentId: string): Promise<void> {
    // 先把排队的 timeline 行写出去，尽量保证磁盘上 meta.lastSeq 不超前于 timeline
    await this.writePendingLines(agentId);
    const source = this.metaSources.get(agentId);
    if (!source || this.deleted.has(agentId)) {
      return;
    }
    this.metaSources.delete(agentId);
    const meta = source();
    await this.ensureDir(agentId);
    await writeFileAtomic(this.metaPath(agentId), `${JSON.stringify(meta, null, 2)}\n`);
  }
}

/** 写临时文件后 rename 覆盖目标；Windows 下目标被占用时退避重试 */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, data, "utf8");
  try {
    await renameWithRetry(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !RENAME_RETRY_CODES.has(code) || attempt >= RENAME_MAX_ATTEMPTS) {
        throw error;
      }
      await sleep(RENAME_RETRY_BASE_MS * 2 ** (attempt - 1));
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnvelope(value: unknown): value is AgentStreamEnvelope {
  return (
    isRecord(value) &&
    typeof value.agentId === "string" &&
    typeof value.seq === "number" &&
    Number.isInteger(value.seq) &&
    value.seq > 0 &&
    isRecord(value.event) &&
    typeof value.event.type === "string"
  );
}

/** 校验必要字段；不合法返回 null */
function normalizeMeta(value: unknown, dirName: string): PersistedAgentMeta | null {
  if (
    !isRecord(value) ||
    value.id !== dirName ||
    typeof value.provider !== "string" ||
    typeof value.cwd !== "string" ||
    typeof value.createdAt !== "number" ||
    typeof value.updatedAt !== "number"
  ) {
    return null;
  }
  const meta = { ...value } as unknown as PersistedAgentMeta;
  if (typeof value.status !== "string" || !STATUSES.has(value.status as AgentStatus)) {
    meta.status = "idle";
  }
  const lastSeq = value.lastSeq;
  meta.lastSeq = typeof lastSeq === "number" && Number.isInteger(lastSeq) && lastSeq > 0 ? lastSeq : 0;
  meta.resumable = false;
  if (typeof value.pinned !== "boolean") {
    delete meta.pinned;
  }
  if (typeof value.archived !== "boolean") {
    delete meta.archived;
  }
  if (!isRecord(value.persistence) || typeof value.persistence.sessionId !== "string") {
    meta.persistence = null;
  }
  return meta;
}
