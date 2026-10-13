import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CodingAgentPaths, CodingAgentsCheckResult } from "@agentdeck/protocol";
import { invalidateProviderQueries } from "@/lib/agent-query-keys";
import { runtime } from "@/lib/runtime";
import { raceAbort } from "@/lib/transport";

const CODING_AGENTS_CHECK_KEY = ["desktop-coding-agents-check"] as const;

function hasCodingAgentsBridge(): boolean {
  return (
    typeof window !== "undefined" &&
    runtime.platform !== "web" &&
    Boolean(window.hermesDesktop?.codingAgentsCheck)
  );
}

/** 编程Agent CLI（Claude Code / Codex）检测；比照 use-environment-check。 */
export function useCodingAgentsCheck() {
  return useQuery<CodingAgentsCheckResult>({
    queryKey: CODING_AGENTS_CHECK_KEY,
    queryFn: ({ signal }) => raceAbort(window.hermesDesktop!.codingAgentsCheck!(), signal),
    enabled: hasCodingAgentsBridge(),
    staleTime: 10_000,
    refetchInterval: 60_000,
  });
}

export function useRefreshCodingAgents() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: CODING_AGENTS_CHECK_KEY });
}

export type CodingAgentPathKey = keyof CodingAgentPaths;

/**
 * 保存单个 Agent 的可执行文件路径（null = 恢复自动查找）：先读当前配置再整份写回（Rust 负责校验与原子写入）。
 * 成功后让编程 Agent 检测与 sidecar 的 provider 列表 / 模型目录重新获取；sidecar 每次解析都重读配置文件，无需重启。
 */
export function useSaveCodingAgentPath() {
  const queryClient = useQueryClient();
  return useCallback(async (key: CodingAgentPathKey, value: string | null): Promise<CodingAgentPaths> => {
    const bridge = window.hermesDesktop;
    if (!bridge?.codingAgentPathsGet || !bridge.codingAgentPathsSet) {
      throw new Error("当前运行环境不支持配置路径（需要桌面端）");
    }
    const current = await bridge.codingAgentPathsGet();
    const saved = await bridge.codingAgentPathsSet({ ...current, [key]: value });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: CODING_AGENTS_CHECK_KEY }),
      invalidateProviderQueries(queryClient),
    ]);
    return saved;
  }, [queryClient]);
}
