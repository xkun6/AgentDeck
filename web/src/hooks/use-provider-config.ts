// 自定义 provider / 三方中转配置（providers.json）的查询与保存（design.md 4.7）。
// 与 sidecar 通信只走 use-agent-session 的动作层；provider.changed 由 useSidecarBridge 统一失效缓存。
import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import type { ProviderInfo, ProviderProfile } from "@agentdeck/protocol";
import { useAgentSession } from "@/hooks/use-agent-session";
import { AGENT_QUERY_KEYS, invalidateProviderQueries } from "@/lib/agent-query-keys";
import { sidecarConnectionAtom } from "@/stores/agents";

export interface ProviderConfigData {
  providers: ProviderProfile[];
  /** providers.json 路径；未设数据目录时为 null（无法保存） */
  path: string | null;
}

export function useProviderConfig() {
  const actions = useAgentSession();
  const connected = useAtomValue(sidecarConnectionAtom) === "open";
  return useQuery<ProviderConfigData>({
    queryKey: AGENT_QUERY_KEYS.providerConfig,
    queryFn: () => actions.getProviderConfig(),
    enabled: connected,
    staleTime: 30_000,
    retry: 1,
  });
}

/** 整表保存：成功后立即写入 provider.list 与配置缓存，再让相关查询失效（provider.changed 也会触发）。 */
export function useSaveProviderConfig() {
  const actions = useAgentSession();
  const queryClient = useQueryClient();
  return useCallback(async (providers: ProviderProfile[]): Promise<ProviderInfo[]> => {
    const list = await actions.setProviderConfig(providers);
    queryClient.setQueryData<ProviderInfo[]>(AGENT_QUERY_KEYS.providers, list);
    queryClient.setQueryData<ProviderConfigData>(AGENT_QUERY_KEYS.providerConfig, (previous) => ({
      providers,
      path: previous?.path ?? null,
    }));
    void invalidateProviderQueries(queryClient);
    return list;
  }, [actions, queryClient]);
}
