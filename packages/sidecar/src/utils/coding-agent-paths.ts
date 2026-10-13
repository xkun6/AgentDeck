// 「编程 Agent」页配置的 Claude Code / Codex 可执行文件路径（design.md 5.1）。
// 文件 `<AGENTDECK_DATA_DIR>/coding-agent-paths.json`，内容 `{ "claude"?: string, "codex"?: string }`，
// 由 Rust 命令 coding_agent_paths_set 原子写入；缺省或空字符串 = 自动查找。
// 每次解析可执行文件时都同步重读（文件很小），保存后无需重启 sidecar 即生效。
import { readFileSync } from "node:fs";
import path from "node:path";

export const CODING_AGENT_PATHS_FILE = "coding-agent-paths.json";
export const DATA_DIR_ENV = "AGENTDECK_DATA_DIR";

export type CodingAgentPathKey = "claude" | "codex";

/** 读取配置的路径（去首尾空白）；未设置数据目录、文件不存在 / 损坏、值缺省或为空时返回 null */
export function readConfiguredAgentPath(
  dataDir: string | undefined,
  key: CodingAgentPathKey,
  readFile: (filePath: string) => string = (filePath) => readFileSync(filePath, "utf8"),
): string | null {
  if (!dataDir) {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(readFile(path.join(dataDir, CODING_AGENT_PATHS_FILE)).replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
