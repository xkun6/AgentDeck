import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { SidecarSettings, SidecarSettingsPatch } from "@agentdeck/protocol";
import { z } from "zod";

import { writeFileAtomic } from "../agent/agent-store.js";
import { createSilentLogger, type Logger } from "../logger.js";

export const SETTINGS_FILE = "sidecar-settings.json";

export const DEFAULT_SIDECAR_SETTINGS: SidecarSettings = {
  snapshots: { enabled: true, maxFiles: 20_000, maxFileBytes: 5 * 1024 * 1024 },
  interop: { enabled: true },
  remote: { enabled: false, port: 47_631 },
};

/** settings.set 的 patch 校验：未知字段、非法取值一律拒绝（-32602） */
export const settingsPatchSchema = z
  .object({
    snapshots: z
      .object({
        enabled: z.boolean(),
        maxFiles: z.number().int().min(1).max(10_000_000),
        maxFileBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      })
      .partial()
      .strict(),
    interop: z.object({ enabled: z.boolean() }).partial().strict(),
    remote: z
      .object({ enabled: z.boolean(), port: z.number().int().min(1024).max(65_535) })
      .partial()
      .strict(),
  })
  .partial()
  .strict();

function cloneSettings(settings: SidecarSettings): SidecarSettings {
  return {
    snapshots: { ...settings.snapshots },
    interop: { ...settings.interop },
    remote: { ...settings.remote },
  };
}

/** 文件内容与默认值逐字段合并；类型不对的字段回退默认值 */
function mergeWithDefaults(raw: unknown): SidecarSettings {
  const result = cloneSettings(DEFAULT_SIDECAR_SETTINGS);
  if (typeof raw !== "object" || raw === null) {
    return result;
  }
  for (const key of ["snapshots", "interop", "remote"] as const) {
    const section = (raw as Record<string, unknown>)[key];
    if (typeof section !== "object" || section === null) {
      continue;
    }
    for (const [field, value] of Object.entries(section)) {
      const one = settingsPatchSchema.safeParse({ [key]: { [field]: value } });
      if (one.success) {
        Object.assign(result[key], one.data[key]);
      }
    }
  }
  return result;
}

/**
 * sidecar 设置（design.md 4.24）：`<AGENTDECK_DATA_DIR>/sidecar-settings.json` 原子写入；
 * 未设置 dataDir 时只在内存。
 */
export class SettingsStore {
  private current: SidecarSettings = cloneSettings(DEFAULT_SIDECAR_SETTINGS);
  private readonly listeners = new Set<(settings: SidecarSettings) => void>();
  private readonly logger: Logger;
  private readonly file: string | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: { dataDir?: string; logger?: Logger } = {}) {
    this.logger = options.logger ?? createSilentLogger();
    this.file = options.dataDir ? path.join(options.dataDir, SETTINGS_FILE) : undefined;
  }

  async load(): Promise<void> {
    if (!this.file) {
      return;
    }
    try {
      const text = await readFile(this.file, "utf8");
      this.current = mergeWithDefaults(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn("读取 sidecar 设置失败，使用默认值：%s", String(error));
      }
    }
  }

  get(): SidecarSettings {
    return cloneSettings(this.current);
  }

  /** patch 已通过 settingsPatchSchema 校验；写盘失败时抛出且不改变内存状态 */
  async set(patch: SidecarSettingsPatch): Promise<SidecarSettings> {
    const next = cloneSettings(this.current);
    Object.assign(next.snapshots, patch.snapshots);
    Object.assign(next.interop, patch.interop);
    Object.assign(next.remote, patch.remote);
    if (this.file) {
      const file = this.file;
      const write = this.writeChain.then(async () => {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
      });
      this.writeChain = write.catch(() => undefined);
      await write;
    }
    this.current = next;
    const snapshot = this.get();
    for (const listener of this.listeners) {
      try {
        listener(cloneSettings(snapshot));
      } catch (error) {
        this.logger.error("settings.changed 监听器出错：%s", String(error));
      }
    }
    return snapshot;
  }

  subscribe(listener: (settings: SidecarSettings) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
