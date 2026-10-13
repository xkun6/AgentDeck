// 看板按项目路径索引（design.md 4.28）。规则与 sidecar `kanban/store.ts` 的 normalizeProjectPath 等价：
// 去首尾空白、分隔符统一为 `/`、去尾部分隔符；Windows 路径（盘符或 UNC）大小写不敏感，统一转小写。
export function boardPathKey(input: string): string {
  const trimmed = input.trim();
  const windows = /^[a-zA-Z]:[\\/]/.test(trimmed) || /^[a-zA-Z]:$/.test(trimmed) || trimmed.startsWith("\\\\");
  let result = trimmed.replace(/\\/g, "/");
  while (result.length > 1 && result.endsWith("/")) {
    result = result.slice(0, -1);
  }
  return windows ? result.toLowerCase() : result;
}
