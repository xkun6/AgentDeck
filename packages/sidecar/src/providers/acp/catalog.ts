// ACP agent 命令目录：内置条目（design.md 5.1）+ 用户自定义 `<dataDir>/acp-agents.json`。
import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { Logger } from "../../logger.js";

export const ACP_ID_PREFIX = "acp:";
export const CUSTOM_ACP_AGENTS_FILE = "acp-agents.json";

export interface AcpAgentEntry {
  /** provider id，形如 `acp:<name>` */
  id: string;
  label: string;
  /** 启动命令：command[0] 为可执行文件，其余为参数 */
  command: string[];
  /** 叠加到子进程环境的变量 */
  env?: Record<string, string>;
  builtin: boolean;
}

export const BUILTIN_ACP_AGENTS: readonly AcpAgentEntry[] = [
  {
    id: "acp:gemini",
    label: "Gemini CLI",
    command: ["npx", "-y", "@google/gemini-cli", "--acp"],
    builtin: true,
  },
  {
    id: "acp:qwen",
    label: "Qwen Code",
    command: ["npx", "-y", "@qwen-code/qwen-code", "--acp"],
    builtin: true,
  },
  { id: "acp:kimi", label: "Kimi CLI", command: ["kimi", "acp"], builtin: true },
  { id: "acp:hermes", label: "Hermes Agent", command: ["hermes", "acp"], builtin: true },
];

const CustomEntrySchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  command: z.array(z.string().min(1)).min(1),
  env: z.record(z.string(), z.string()).optional(),
});

/** 给 id 补 `acp:` 前缀；补完后名字部分为空则返回 null */
export function normalizeAcpId(rawId: string): string | null {
  const id = rawId.trim();
  const withPrefix = id.startsWith(ACP_ID_PREFIX) ? id : `${ACP_ID_PREFIX}${id}`;
  return withPrefix.length > ACP_ID_PREFIX.length ? withPrefix : null;
}

/** 解析 acp-agents.json 内容；非法项记日志并忽略 */
export function parseCustomAcpAgents(text: string, source: string, logger: Logger): AcpAgentEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    logger.error("解析 %s 失败（不是合法 JSON）：%s", source, String(error));
    return [];
  }
  if (!Array.isArray(data)) {
    logger.error("%s 顶层必须是数组，已忽略整个文件", source);
    return [];
  }

  const entries: AcpAgentEntry[] = [];
  data.forEach((raw, index) => {
    const parsed = CustomEntrySchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn(
        "%s 第 %d 项校验失败，已忽略：%s",
        source,
        index,
        parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      );
      return;
    }
    const id = normalizeAcpId(parsed.data.id);
    if (!id) {
      logger.warn("%s 第 %d 项 id 为空，已忽略", source, index);
      return;
    }
    entries.push({
      id,
      label: parsed.data.label,
      command: parsed.data.command,
      ...(parsed.data.env ? { env: parsed.data.env } : {}),
      builtin: false,
    });
  });
  return entries;
}

/** 读取 `<dataDir>/acp-agents.json`；dataDir 未设置或文件不存在时返回空数组 */
export async function loadCustomAcpAgents(
  dataDir: string | undefined,
  logger: Logger,
): Promise<AcpAgentEntry[]> {
  if (!dataDir) {
    return [];
  }
  const file = path.join(dataDir, CUSTOM_ACP_AGENTS_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.error("读取 %s 失败：%s", file, String(error));
    }
    return [];
  }
  return parseCustomAcpAgents(text, file, logger);
}

/** 合并内置与自定义条目：同 id 时自定义覆盖内置（保留内置位置），新条目追加在后 */
export function mergeAcpAgents(
  builtin: readonly AcpAgentEntry[],
  custom: readonly AcpAgentEntry[],
  logger: Logger,
): AcpAgentEntry[] {
  const merged = new Map<string, AcpAgentEntry>();
  for (const entry of builtin) {
    merged.set(entry.id, entry);
  }
  const seenCustom = new Set<string>();
  for (const entry of custom) {
    if (seenCustom.has(entry.id)) {
      logger.warn("acp-agents.json 中 id 重复：%s，后者覆盖前者", entry.id);
    } else if (merged.has(entry.id)) {
      logger.info("自定义 ACP agent %s 覆盖内置条目", entry.id);
    }
    seenCustom.add(entry.id);
    merged.set(entry.id, entry);
  }
  return Array.from(merged.values());
}

export async function resolveAcpAgentEntries(
  dataDir: string | undefined,
  logger: Logger,
): Promise<AcpAgentEntry[]> {
  return mergeAcpAgents(BUILTIN_ACP_AGENTS, await loadCustomAcpAgents(dataDir, logger), logger);
}
