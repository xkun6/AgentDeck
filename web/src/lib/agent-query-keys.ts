// sidecar 相关 TanStack Query 的 key 与失效规则（provider.changed 时统一刷新）。
import type { QueryClient } from "@tanstack/react-query";

export const AGENT_QUERY_KEYS = {
  providers: ["agentdeck", "providers"] as const,
  /** 前缀；完整 key 为 [...catalog, provider, cwd] */
  catalog: ["agentdeck", "catalog"] as const,
  providerConfig: ["agentdeck", "provider-config"] as const,
};

/** providers.json 变化：provider.list、各 provider 的模型目录、中转配置全部失效并重新拉取。 */
export function invalidateProviderQueries(queryClient: Pick<QueryClient, "invalidateQueries">): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: AGENT_QUERY_KEYS.providers }),
    queryClient.invalidateQueries({ queryKey: AGENT_QUERY_KEYS.catalog }),
    queryClient.invalidateQueries({ queryKey: AGENT_QUERY_KEYS.providerConfig }),
  ]).then(() => undefined);
}
