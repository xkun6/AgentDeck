import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import type { AgentGroup } from "@agentdeck/protocol";

import { writeFileAtomic } from "../agent/agent-store.js";
import { createSilentLogger, type Logger } from "../logger.js";
import { storedGroupSchema } from "./schema.js";

export const GROUPS_DIR = "groups";

export interface GroupStoreOptions {
  /** AGENTDECK_DATA_DIR；不传则只在内存中保存（不落盘） */
  dataDir?: string;
  logger?: Logger;
}

/** 协作组存储（design.md 4.27）：`<dataDir>/groups/<id>.json` 原子写入；坏文件记日志后跳过 */
export class GroupStore {
  private readonly dir: string | undefined;
  private readonly logger: Logger;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: GroupStoreOptions = {}) {
    this.dir = options.dataDir ? path.join(options.dataDir, GROUPS_DIR) : undefined;
    this.logger = options.logger ?? createSilentLogger();
  }

  async loadAll(): Promise<AgentGroup[]> {
    if (!this.dir) {
      return [];
    }
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn("读取 %s 失败：%s", this.dir, String(error));
      }
      return [];
    }
    const groups: AgentGroup[] = [];
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      const file = path.join(this.dir, name);
      try {
        const parsed = storedGroupSchema.parse(JSON.parse(await readFile(file, "utf8")));
        groups.push(parsed as AgentGroup);
      } catch (error) {
        this.logger.warn("跳过损坏的协作组文件 %s：%s", file, String(error));
      }
    }
    return groups;
  }

  /** 串行写入；失败只记日志 */
  save(group: AgentGroup): Promise<void> {
    if (!this.dir) {
      return Promise.resolve();
    }
    const dir = this.dir;
    const data = `${JSON.stringify(group, null, 2)}\n`;
    this.writeChain = this.writeChain
      .then(async () => {
        await mkdir(dir, { recursive: true });
        await writeFileAtomic(path.join(dir, `${group.id}.json`), data);
      })
      .catch((error: unknown) => {
        this.logger.error("写入协作组 %s 失败：%s", group.id, String(error));
      });
    return this.writeChain;
  }

  remove(id: string): Promise<void> {
    if (!this.dir) {
      return Promise.resolve();
    }
    const dir = this.dir;
    this.writeChain = this.writeChain
      .then(() => rm(path.join(dir, `${id}.json`), { force: true }))
      .catch((error: unknown) => {
        this.logger.error("删除协作组文件 %s 失败：%s", id, String(error));
      });
    return this.writeChain;
  }

  flush(): Promise<void> {
    return this.writeChain;
  }
}
