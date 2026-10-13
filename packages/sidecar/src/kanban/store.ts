import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import path from "node:path";

import type { Board } from "@agentdeck/protocol";
import { z } from "zod";

import { writeFileAtomic } from "../agent/agent-store.js";
import { createSilentLogger, type Logger } from "../logger.js";

export const BOARDS_DIR = "boards";

/**
 * 项目路径规范化（与前端 `web/src/lib/board-path.ts` 的 boardPathKey 等价）：
 * 去首尾空白、分隔符统一为 `/`、去尾部分隔符；Windows 路径（盘符或 UNC）大小写不敏感，统一转小写。
 */
export function normalizeProjectPath(input: string): string {
  const trimmed = input.trim();
  const windows = /^[a-zA-Z]:[\\/]/.test(trimmed) || /^[a-zA-Z]:$/.test(trimmed) || trimmed.startsWith("\\\\");
  let result = trimmed.replace(/\\/g, "/");
  while (result.length > 1 && result.endsWith("/")) {
    result = result.slice(0, -1);
  }
  return windows ? result.toLowerCase() : result;
}

/** 看板文件名主干：sha1(规范化路径) 前 16 位 */
export function boardKey(projectPath: string): string {
  return createHash("sha1").update(normalizeProjectPath(projectPath)).digest("hex").slice(0, 16);
}

const assigneeSchema = z.object({
  provider: z.string().min(1),
  model: z.string().nullable().optional(),
  modeId: z.string().nullable().optional(),
});

const taskSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  description: z.string().default(""),
  status: z.enum(["todo", "running", "review", "done", "blocked"]),
  assignee: assigneeSchema.optional(),
  dependsOn: z.array(z.string()).optional(),
  agentId: z.string().optional(),
  worktree: z.object({ path: z.string(), branch: z.string() }).optional(),
  attempts: z.number().default(0),
  maxAttempts: z.number().default(2),
  blockedReason: z.string().optional(),
  order: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const boardSchema = z.object({
  projectPath: z.string().min(1),
  settings: z.object({
    worktreePerTask: z.boolean(),
    autoDispatch: z.boolean(),
    maxConcurrent: z.number().int().min(1),
    defaultAssignee: assigneeSchema,
  }),
  tasks: z.array(z.unknown()),
});

export interface BoardStoreOptions {
  /** AGENTDECK_DATA_DIR；不传则只在内存中保存 */
  dataDir?: string;
  logger?: Logger;
}

/** 看板存储（design.md 4.28）：`<dataDir>/boards/<boardKey>.json` 原子写入，坏文件备份为 `.bad` 后视为空 */
export class BoardStore {
  private readonly dir: string | undefined;
  private readonly logger: Logger;
  private writeChain: Promise<void> = Promise.resolve();
  private dirEnsured = false;

  constructor(options: BoardStoreOptions = {}) {
    this.dir = options.dataDir ? path.join(options.dataDir, BOARDS_DIR) : undefined;
    this.logger = options.logger ?? createSilentLogger();
  }

  /** 读单个看板；不存在 / 损坏返回 null */
  async load(projectPath: string): Promise<Board | null> {
    if (!this.dir) {
      return null;
    }
    return this.loadFile(path.join(this.dir, `${boardKey(projectPath)}.json`));
  }

  /** 读取目录下全部看板（启动时用） */
  async loadAll(): Promise<Board[]> {
    if (!this.dir) {
      return [];
    }
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const boards: Board[] = [];
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      const board = await this.loadFile(path.join(this.dir, name));
      if (board) {
        boards.push(board);
      }
    }
    return boards;
  }

  /** 串行写入；失败只记日志 */
  save(board: Board): Promise<void> {
    if (!this.dir) {
      return Promise.resolve();
    }
    const dir = this.dir;
    const file = path.join(dir, `${boardKey(board.projectPath)}.json`);
    const data = `${JSON.stringify({ version: 1, ...board }, null, 2)}\n`;
    this.writeChain = this.writeChain
      .then(async () => {
        if (!this.dirEnsured) {
          await mkdir(dir, { recursive: true });
          this.dirEnsured = true;
        }
        await writeFileAtomic(file, data);
      })
      .catch((error: unknown) => {
        this.logger.error("写入看板 %s 失败：%s", file, String(error));
      });
    return this.writeChain;
  }

  flush(): Promise<void> {
    return this.writeChain;
  }

  private async loadFile(file: string): Promise<Board | null> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn("读取 %s 失败，按空处理：%s", file, String(error));
      }
      return null;
    }
    let parsed: z.ZodSafeParseResult<z.output<typeof boardSchema>> | null = null;
    try {
      parsed = boardSchema.safeParse(JSON.parse(text));
    } catch (error) {
      this.logger.warn("%s 不是合法 JSON：%s", file, String(error));
    }
    if (!parsed?.success) {
      this.logger.warn("%s 损坏，按空处理（原文件备份为 .bad）", file);
      await rename(file, `${file}.bad`).catch(() => undefined);
      return null;
    }
    const tasks: Board["tasks"] = [];
    for (const item of parsed.data.tasks) {
      const task = taskSchema.safeParse(item);
      if (task.success) {
        tasks.push(task.data as Board["tasks"][number]);
      } else {
        this.logger.warn("跳过不合法的看板任务：%s", JSON.stringify(item).slice(0, 200));
      }
    }
    return { projectPath: parsed.data.projectPath, settings: parsed.data.settings, tasks };
  }
}
