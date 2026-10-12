import { useQuery } from "@tanstack/react-query";
import type { FsListResponse } from "@agentdeck/protocol";

/** 目录列表尚未接入：下一阶段改为调用 Rust 命令 `fs_list`（docs/design.md 第 4.6 节）。 */
export const FS_LIST_UNAVAILABLE_MESSAGE = "目录浏览暂不可用，请直接输入或粘贴目录路径";

// 接入点：把 queryFn 换成 `invoke("fs_list", { path })` 并映射到 FsListResponse。
export async function listDirectory(_path: string): Promise<FsListResponse> {
  throw new Error(FS_LIST_UNAVAILABLE_MESSAGE);
}

export function useFsList(path: string, options?: { enabled?: boolean }) {
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
