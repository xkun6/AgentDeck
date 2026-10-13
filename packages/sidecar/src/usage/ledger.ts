import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentProviderId, AgentStreamEnvelope, UsageTurnRecord } from "@agentdeck/protocol";

import { createSilentLogger, type Logger } from "../logger.js";
import { UsageTurnTracker } from "./turn-tracker.js";

export const USAGE_DIR = "usage";
export const TURNS_FILE = "turns.jsonl";
export const BACKFILL_MARKER = "backfill-v1.done";

export interface UsageLedgerOptions {
  /** AGENTDECK_DATA_DIR；不传则只在内存中累计 */
  dataDir?: string;
  logger?: Logger;
}

/** 回填用：一个历史会话 */
export interface BackfillAgent {
  id: string;
  provider: AgentProviderId;
  /** meta 快照里的 model（时间线中没有 model_changed 时作为各回合的 model） */
  model: string | null;
}

export type BackfillTimelineReader = (agentId: string) => AsyncIterable<AgentStreamEnvelope>;

/**
 * 跨会话用量账本（design.md 4.20）：`<dataDir>/usage/turns.jsonl` 逐行追加 `UsageTurnRecord`，
 * 内存里保留全部记录供 `usage.summary` 聚合。与会话独立：删除会话不删账本。
 * 文件 IO 失败只记日志，不影响调用方。
 */
export class UsageLedger {
  private readonly dir: string | undefined;
  private readonly logger: Logger;
  private readonly records: UsageTurnRecord[] = [];
  private readonly keys = new Set<string>();
  private writeChain: Promise<void> = Promise.resolve();
  private dirEnsured = false;
  private backfillPending = false;

  constructor(options: UsageLedgerOptions = {}) {
    this.dir = options.dataDir ? path.join(options.dataDir, USAGE_DIR) : undefined;
    this.logger = options.logger ?? createSilentLogger();
  }

  /** 回填尚未完成（启用持久化且标记文件不存在时，从 load 起为 true 直到 backfill 结束） */
  get backfilling(): boolean {
    return this.backfillPending;
  }

  /** 读取已有账本（坏行跳过）并判断是否需要回填；读取失败只记日志 */
  async load(): Promise<void> {
    if (!this.dir) {
      return;
    }
    try {
      const raw = await readFile(path.join(this.dir, TURNS_FILE), "utf8");
      for (const line of raw.split("\n")) {
        if (line.trim() === "") {
          continue;
        }
        try {
          const parsed: unknown = JSON.parse(line);
          if (isRecord(parsed)) {
            this.add(parsed);
          }
        } catch {
          // 坏行跳过
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn("读取用量账本失败：%s", String(error));
      }
    }
    this.backfillPending = !(await this.markerExists());
  }

  list(): readonly UsageTurnRecord[] {
    return this.records;
  }

  /** 追加一条记录（同一 agentId + turnId + ts 的重复记录忽略） */
  record(record: UsageTurnRecord): void {
    if (!this.add(record)) {
      return;
    }
    if (!this.dir) {
      return;
    }
    const line = `${JSON.stringify(record)}\n`;
    this.writeChain = this.writeChain
      .then(async () => {
        await this.ensureDir();
        await appendFile(path.join(this.dir!, TURNS_FILE), line, "utf8");
      })
      .catch((error: unknown) => {
        this.logger.warn("写入用量账本失败：%s", String(error));
      });
  }

  /** 等待已排队的写入完成 */
  flush(): Promise<void> {
    return this.writeChain;
  }

  /**
   * 扫描全部会话时间线生成历史记录，完成后写标记文件（只执行一次）。
   * 标记已存在 / 未启用持久化时直接返回；任何失败只记日志（不写标记，下次启动重试）。
   */
  async backfill(agents: BackfillAgent[], readTimeline: BackfillTimelineReader): Promise<void> {
    if (!this.dir || !this.backfillPending) {
      return;
    }
    try {
      for (const agent of agents) {
        try {
          await this.backfillAgent(agent, readTimeline);
        } catch (error) {
          this.logger.warn("回填会话 %s 的用量失败：%s", agent.id, String(error));
        }
      }
      await this.flush();
      await this.ensureDir();
      await writeFile(path.join(this.dir, BACKFILL_MARKER), `${Date.now()}\n`, "utf8");
      this.logger.info("用量回填完成（共 %d 条记录）", this.records.length);
    } catch (error) {
      this.logger.warn("用量回填失败：%s", String(error));
    } finally {
      this.backfillPending = false;
    }
  }

  private async backfillAgent(agent: BackfillAgent, readTimeline: BackfillTimelineReader): Promise<void> {
    const entries: AgentStreamEnvelope[] = [];
    for await (const entry of readTimeline(agent.id)) {
      entries.push(entry);
    }
    // 时间线里有 model_changed 时，首次切换之前的模型未知（视为 provider 默认）；否则用快照里的 model
    let model: string | null = entries.some((entry) => entry.event.type === "model_changed")
      ? null
      : agent.model;
    const tracker = new UsageTurnTracker(agent.id, agent.provider);
    for (const entry of entries) {
      if (entry.event.type === "model_changed") {
        model = entry.event.modelId;
      }
      const record = tracker.observe(entry, model);
      if (record) {
        this.record(record);
      }
    }
  }

  private add(value: UsageTurnRecord): boolean {
    const key = `${value.agentId}\u0000${value.turnId}\u0000${value.ts}`;
    if (this.keys.has(key)) {
      return false;
    }
    this.keys.add(key);
    this.records.push(value);
    return true;
  }

  private async ensureDir(): Promise<void> {
    if (this.dirEnsured || !this.dir) {
      return;
    }
    await mkdir(this.dir, { recursive: true });
    this.dirEnsured = true;
  }

  private async markerExists(): Promise<boolean> {
    try {
      await readFile(path.join(this.dir!, BACKFILL_MARKER));
      return true;
    } catch {
      return false;
    }
  }
}

function isRecord(value: unknown): value is UsageTurnRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.ts === "number" &&
    typeof record.agentId === "string" &&
    typeof record.provider === "string" &&
    typeof record.turnId === "string" &&
    (record.outcome === "completed" || record.outcome === "failed" || record.outcome === "canceled")
  );
}
