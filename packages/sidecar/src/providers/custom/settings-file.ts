// Claude 中转的 settingsFile 读取（design.md 4.7）：每次启动 / 恢复会话与 isAvailable 时读取，允许 UTF-8 BOM。
// 错误信息只含路径与原因，不含文件内容。
import { readFile } from "node:fs/promises";

import { isPlainObject } from "./schema.js";

export async function readClaudeSettingsFile(file: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`设置文件不存在：${file}`);
    }
    if (code === "EISDIR") {
      throw new Error(`设置文件路径是一个目录：${file}`);
    }
    throw new Error(`无法读取设置文件「${file}」：${code ?? (error as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`设置文件「${file}」不是合法的 JSON`);
  }
  if (!isPlainObject(data)) {
    throw new Error(`设置文件「${file}」的内容必须是 JSON 对象`);
  }
  return data;
}
