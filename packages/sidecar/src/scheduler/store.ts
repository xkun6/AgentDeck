import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Schedule, ScheduleRun } from "@agentdeck/protocol";

import { writeFileAtomic } from "../agent/agent-store.js";
import { createSilentLogger, type Logger } from "../logger.js";
import { scheduleDraftSchema } from "./schema.js";

export const SCHEDULES_FILE = "schedules.json";
export const SCHEDULE_RUNS_FILE = "schedule-runs.jsonl";
/** 运行记录文件超过该行数时，加载时只保留最后一部分 */
const RUNS_TRIM_LINES = 5_000;
const RUNS_KEEP_LINES = 2_000;
const MEMORY_RUNS_MAX = 2_000;

export interface ScheduleStoreOptions {
  /** AGENTDECK_DATA_DIR；不传则只在内存中保存 */
  dataDir?: string;
  logger?: Logger;
}

export interface ScheduleFileState {
  paused: boolean;
  schedules: Schedule[];
}

/**
 * 调度器存储（design.md 4.25）：`<dataDir>/schedules.json` 原子写入，
 * `<dataDir>/schedule-runs.jsonl` 逐行追加运行记录。文件损坏记日志后视为空。
 */
export class ScheduleStore {
  private readonly dir: string | undefined;
  private readonly logger: Logger;
  private writeChain: Promise<void> = Promise.resolve();
  private memoryRuns: ScheduleRun[] = [];
  private dirEnsured = false;

  constructor(options: ScheduleStoreOptions = {}) {
    this.dir = options.dataDir;
    this.logger = options.logger ?? createSilentLogger();
  }

  async load(): Promise<ScheduleFileState> {
    const empty: ScheduleFileState = { paused: false, schedules: [] };
    if (!this.dir) {
      return empty;
    }
    const file = path.join(this.dir, SCHEDULES_FILE);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn("读取 %s 失败，按空处理：%s", file, String(error));
      }
      return empty;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      this.logger.warn("%s 不是合法 JSON，按空处理（原文件备份为 .bad）：%s", file, String(error));
      await rename(file, `${file}.bad`).catch(() => undefined);
      return empty;
    }
    if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { schedules?: unknown }).schedules)) {
      this.logger.warn("%s 结构不合法，按空处理", file);
      return empty;
    }
    const record = raw as { paused?: unknown; schedules: unknown[] };
    const schedules: Schedule[] = [];
    for (const item of record.schedules) {
      const parsed = scheduleDraftSchema.safeParse(item);
      const meta = item as { id?: unknown; createdAt?: unknown; updatedAt?: unknown };
      if (!parsed.success || typeof meta.id !== "string" || !meta.id) {
        this.logger.warn("跳过不合法的调度项：%s", JSON.stringify(item).slice(0, 200));
        continue;
      }
      const createdAt = typeof meta.createdAt === "number" ? meta.createdAt : Date.now();
      const updatedAt = typeof meta.updatedAt === "number" ? meta.updatedAt : createdAt;
      const draft = parsed.data;
      const base = { id: meta.id, createdAt, updatedAt };
      if (draft.kind === "cron") {
        schedules.push({ ...draft, ...base, id: meta.id });
      } else if (draft.kind === "heartbeat") {
        schedules.push({ ...draft, ...base, id: meta.id, runs: draft.runs ?? 0 });
      } else {
        schedules.push({
          ...draft,
          ...base,
          id: meta.id,
          iterations: draft.iterations ?? 0,
          state: draft.state ?? "stopped",
        });
      }
    }
    return { paused: record.paused === true, schedules };
  }

  /** 串行写入；失败只记日志 */
  save(state: ScheduleFileState): Promise<void> {
    if (!this.dir) {
      return Promise.resolve();
    }
    const dir = this.dir;
    const data = `${JSON.stringify({ version: 1, paused: state.paused, schedules: state.schedules }, null, 2)}\n`;
    this.writeChain = this.writeChain
      .then(async () => {
        await this.ensureDir(dir);
        await writeFileAtomic(path.join(dir, SCHEDULES_FILE), data);
      })
      .catch((error: unknown) => {
        this.logger.error("写入 %s 失败：%s", SCHEDULES_FILE, String(error));
      });
    return this.writeChain;
  }

  appendRun(run: ScheduleRun): Promise<void> {
    if (!this.dir) {
      this.memoryRuns.push(run);
      if (this.memoryRuns.length > MEMORY_RUNS_MAX) {
        this.memoryRuns = this.memoryRuns.slice(-MEMORY_RUNS_MAX);
      }
      return Promise.resolve();
    }
    const dir = this.dir;
    const line = `${JSON.stringify(run)}\n`;
    this.writeChain = this.writeChain
      .then(async () => {
        await this.ensureDir(dir);
        await appendFile(path.join(dir, SCHEDULE_RUNS_FILE), line, "utf8");
      })
      .catch((error: unknown) => {
        this.logger.error("追加 %s 失败：%s", SCHEDULE_RUNS_FILE, String(error));
      });
    return this.writeChain;
  }

  /** 按时间倒序；损坏的行跳过 */
  async readRuns(scheduleId: string | undefined, limit: number): Promise<ScheduleRun[]> {
    await this.writeChain;
    let runs: ScheduleRun[];
    if (!this.dir) {
      runs = this.memoryRuns;
    } else {
      runs = [];
      let text = "";
      try {
        text = await readFile(path.join(this.dir, SCHEDULE_RUNS_FILE), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          this.logger.warn("读取运行记录失败：%s", String(error));
        }
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) {
          continue;
        }
        try {
          const run = JSON.parse(line) as ScheduleRun;
          if (typeof run.scheduleId === "string" && typeof run.ts === "number") {
            runs.push(run);
          }
        } catch {
          // 损坏的行直接跳过
        }
      }
    }
    const filtered = scheduleId ? runs.filter((run) => run.scheduleId === scheduleId) : runs;
    return filtered.slice(-limit).reverse();
  }

  /** 启动时裁剪过长的运行记录文件 */
  async trimRuns(): Promise<void> {
    if (!this.dir) {
      return;
    }
    const file = path.join(this.dir, SCHEDULE_RUNS_FILE);
    try {
      const lines = (await readFile(file, "utf8")).split("\n").filter((line) => line.trim());
      if (lines.length > RUNS_TRIM_LINES) {
        await writeFile(file, `${lines.slice(-RUNS_KEEP_LINES).join("\n")}\n`, "utf8");
      }
    } catch {
      // 文件不存在或不可读：忽略
    }
  }

  flush(): Promise<void> {
    return this.writeChain;
  }

  private async ensureDir(dir: string): Promise<void> {
    if (!this.dirEnsured) {
      await mkdir(dir, { recursive: true });
      this.dirEnsured = true;
    }
  }
}
