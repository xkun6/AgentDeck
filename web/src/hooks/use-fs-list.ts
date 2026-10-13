// 本地目录列表：经 tauri-bridge 调 Rust 命令 `fs_list`（docs/design.md 4.6），
// 映射成调用方使用的 FsListResponse（条目字段为 `is_dir`）。
import { useQuery } from "@tanstack/react-query";
import type { FsListResponse } from "@agentdeck/protocol";
import type { FsListResult } from "@/lib/runtime";

/** 纯 web 模式（无 Tauri）下没有 fs_list。 */
export const FS_LIST_UNAVAILABLE_MESSAGE = "目录浏览需要在桌面端中使用，请直接输入或粘贴目录路径";

export function mapFsListResult(result: FsListResult): FsListResponse {
  return {
    path: result.path,
    parent: result.parent ?? null,
    home: result.home,
    entries: (result.entries ?? []).map((entry) => ({
      name: entry.name,
      path: entry.path,
      is_dir: entry.isDir,
    })),
    ...(result.error ? { error: result.error } : {}),
  };
}

/**
 * 列出目录。`path` 为 null 时列用户主目录；Windows 下空字符串返回盘符列表
 * （非 Windows 为根目录 `/`）。读取失败不抛错，结果带中文 `error`。
 */
export async function listDirectory(
  path: string | null,
  options: { showHidden?: boolean } = {},
): Promise<FsListResponse> {
  const fsList = typeof window !== "undefined" ? window.agentdeckDesktop?.fsList : undefined;
  if (typeof fsList !== "function") throw new Error(FS_LIST_UNAVAILABLE_MESSAGE);
  const result = await fsList({
    ...(path === null ? {} : { path }),
    showHidden: options.showHidden ?? false,
  });
  return mapFsListResult(result);
}

export function useFsList(path: string | null, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["fs-list", path],
    queryFn: () => listDirectory(path),
    enabled: options?.enabled ?? true,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
    gcTime: 30_000,
  });
}
