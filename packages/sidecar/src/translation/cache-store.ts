// Derived from paseo-translate server/translation-cache-store.ts; modified for AgentDeck
// 翻译缓存（design.md 4.35）：键值 + 最近使用淘汰。传 file 时以 JSONL 持久化，启动读入内存，
// 新结果追加写入；追加远超上限时重写压缩。任何文件读写失败都退化为纯内存，不影响翻译本身。

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createSilentLogger, type Logger } from "../logger.js";

export const TRANSLATION_CACHE_FILE = "translation-cache.jsonl";
export const TRANSLATION_CACHE_CAPACITY = 10_000;

export interface TranslationCacheStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

export function createTranslationCacheStore(
  options: { file?: string; maxEntries?: number; logger?: Logger } = {},
): TranslationCacheStore {
  const maxEntries = options.maxEntries ?? TRANSLATION_CACHE_CAPACITY;
  const logger = options.logger ?? createSilentLogger();
  const entries = new Map<string, string>();
  const file = options.file;
  let persist = file !== undefined;
  let appends = 0;

  const disable = (error: unknown) => {
    persist = false;
    logger.warn("翻译缓存文件不可用，改为仅内存缓存：%s", String(error));
  };

  const rewrite = (target: string) => {
    const lines = [...entries].map(([k, v]) => JSON.stringify({ k, v }));
    writeFileSync(`${target}.tmp`, lines.length === 0 ? "" : `${lines.join("\n")}\n`, "utf8");
    renameSync(`${target}.tmp`, target);
  };

  if (file !== undefined) {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      let raw = "";
      try {
        raw = readFileSync(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      let lines = 0;
      for (const line of raw.split("\n")) {
        if (line.length === 0) {
          continue;
        }
        lines += 1;
        const record = parseRecord(line);
        if (record) {
          entries.delete(record.k);
          entries.set(record.k, record.v);
        }
      }
      evictOldest(entries, maxEntries);
      // 重复追加、崩溃留下的半行、超限淘汰的项都会在文件里留下多余行：加载时压缩一次
      if (lines > entries.size) {
        rewrite(file);
      }
    } catch (error) {
      disable(error);
    }
  }

  return {
    get(key) {
      const value = entries.get(key);
      if (value === undefined) {
        return undefined;
      }
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      evictOldest(entries, maxEntries);
      if (!persist || file === undefined) {
        return;
      }
      try {
        appendFileSync(file, `${JSON.stringify({ k: key, v: value })}\n`, "utf8");
        appends += 1;
        if (appends > maxEntries * 2) {
          rewrite(file);
          appends = 0;
        }
      } catch (error) {
        disable(error);
      }
    },
  };
}

function parseRecord(line: string): { k: string; v: string } | null {
  try {
    const parsed = JSON.parse(line) as { k?: unknown; v?: unknown };
    return typeof parsed.k === "string" && typeof parsed.v === "string"
      ? { k: parsed.k, v: parsed.v }
      : null;
  } catch {
    return null;
  }
}

function evictOldest(entries: Map<string, string>, maxEntries: number): void {
  while (entries.size > maxEntries) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    entries.delete(oldest);
  }
}
