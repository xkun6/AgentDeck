// `<AGENTDECK_DATA_DIR>/providers.json` 的读取与原子写入（design.md 4.7）。
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { ProviderConfigFile, ProviderProfile } from "@agentdeck/protocol";

import { writeFileAtomic } from "../../agent/agent-store.js";
import type { Logger } from "../../logger.js";
import { formatIssues, providerProfileSchema, toProviderProfile } from "./schema.js";

export const PROVIDERS_CONFIG_FILE = "providers.json";
export const PROVIDERS_CONFIG_VERSION = 1;

export function providersConfigPath(dataDir: string): string {
  return path.join(dataDir, PROVIDERS_CONFIG_FILE);
}

/**
 * 读取 providers.json；文件不存在返回空表。损坏（非 JSON / 结构不对）时记日志并返回空表，不抛错；
 * 单项校验失败、id 重复或与内置冲突的项记日志后跳过（日志只含路径与说明，不含字段值）。
 */
export async function loadProviderProfiles(
  file: string,
  logger: Logger,
  reservedIds: ReadonlySet<string> = new Set(),
): Promise<ProviderProfile[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.error("读取 %s 失败：%s", file, (error as Error).message);
    }
    return [];
  }

  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    logger.error("%s 不是合法 JSON，已忽略整个文件（保存新配置时会被覆盖）", file);
    return [];
  }
  const record = data as Partial<ProviderConfigFile> | null;
  if (typeof record !== "object" || record === null || !Array.isArray(record.providers)) {
    logger.error("%s 缺少 providers 数组，已忽略整个文件", file);
    return [];
  }
  if (record.version !== PROVIDERS_CONFIG_VERSION) {
    logger.warn("%s 的 version 为 %s，按 version 1 读取", file, String(record.version));
  }

  const profiles: ProviderProfile[] = [];
  const seen = new Set<string>();
  record.providers.forEach((raw, index) => {
    const parsed = providerProfileSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn(
        "%s 第 %d 项校验失败，已忽略：%s",
        file,
        index,
        formatIssues(parsed.error.issues)
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("; "),
      );
      return;
    }
    const profile = toProviderProfile(parsed.data);
    // 旧版的 settingsFile（外部 settings.json 路径）已移除：zod 对象默认剥离未知键，该项照常加载，这里只记一条告警
    if (typeof raw === "object" && raw !== null && "settingsFile" in raw) {
      logger.warn(
        "%s 第 %d 项（%s）含已不再支持的 settingsFile 字段，已忽略；请把原 settings.json 的内容粘贴到该中转的「设置 JSON」",
        file,
        index,
        profile.id,
      );
    }
    if (reservedIds.has(profile.id)) {
      logger.warn("%s 第 %d 项 id「%s」与内置 provider 冲突，已忽略", file, index, profile.id);
      return;
    }
    if (seen.has(profile.id)) {
      logger.warn("%s 第 %d 项 id「%s」重复，已忽略", file, index, profile.id);
      return;
    }
    seen.add(profile.id);
    profiles.push(profile);
  });
  return profiles;
}

/** 原子写入（临时文件 + rename）；文件含明文 apiKey */
export async function saveProviderProfiles(
  file: string,
  profiles: readonly ProviderProfile[],
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const content: ProviderConfigFile = {
    version: PROVIDERS_CONFIG_VERSION,
    providers: profiles.map((profile) => structuredClone(profile)),
  };
  await writeFileAtomic(file, `${JSON.stringify(content, null, 2)}\n`);
}
