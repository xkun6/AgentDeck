import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { EnvironmentCheckResult, EnvironmentInstallResult } from "@agentdeck/protocol";
import { useRefreshCodingAgents } from "@/hooks/use-coding-agents";
import { runtime } from "@/lib/runtime";
import { raceAbort } from "@/lib/transport";

const ENVIRONMENT_CHECK_KEY = ["desktop-environment-check"] as const;

function hasEnvironmentBridge(): boolean {
  return typeof window !== "undefined" &&
    runtime.platform !== "web" &&
    Boolean(window.hermesDesktop?.environmentCheck);
}

export function useEnvironmentCheck() {
  return useQuery<EnvironmentCheckResult>({
    queryKey: ENVIRONMENT_CHECK_KEY,
    queryFn: ({ signal }) => raceAbort(window.hermesDesktop!.environmentCheck!(), signal),
    enabled: hasEnvironmentBridge(),
    staleTime: 10_000,
    refetchInterval: 60_000,
  });
}

/**
 * 一键安装缺失工具（Rust environment_install，只传检测项 id）。
 * 成功后让环境检查与编程 Agent 检测重新获取。
 */
export function useEnvironmentInstall() {
  const queryClient = useQueryClient();
  const refreshCodingAgents = useRefreshCodingAgents();
  return async (id: string): Promise<EnvironmentInstallResult> => {
    const install = window.hermesDesktop?.environmentInstall;
    if (!install) throw new Error("当前运行环境不支持一键安装（需要桌面端）");
    const result = await install(id);
    if (result.ok) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ENVIRONMENT_CHECK_KEY }),
        refreshCodingAgents(),
      ]);
    }
    return result;
  };
}
