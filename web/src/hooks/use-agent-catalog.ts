// provider 列表与模型 / 模式目录（来自 sidecar），以及新建会话的选择状态。
import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useAgentSession, humanizeSidecarError } from "@/hooks/use-agent-session";
import {
  readAgentSelection,
  resolveCatalogChoice,
  resolveProvider,
  writeAgentSelection,
  type AgentSelection,
} from "@/lib/agent-selection";
import { sidecarConnectionAtom } from "@/stores/agents";

export function useAgentProviders() {
  const actions = useAgentSession();
  const connected = useAtomValue(sidecarConnectionAtom) === "open";
  return useQuery({
    queryKey: ["agentdeck", "providers"],
    queryFn: () => actions.listProviders(),
    enabled: connected,
    staleTime: 30_000,
    retry: 1,
  });
}

export function useAgentCatalog(provider: string | null, cwd: string) {
  const actions = useAgentSession();
  const connected = useAtomValue(sidecarConnectionAtom) === "open";
  return useQuery({
    queryKey: ["agentdeck", "catalog", provider ?? "", cwd],
    queryFn: () => actions.listModels(provider!, cwd || undefined),
    enabled: connected && Boolean(provider),
    staleTime: 60_000,
    retry: 1,
  });
}

/** 新建会话的 Agent / 模型 / 模式选择：读写 ui_store 记忆，并按可用性与目录校正。 */
export function useAgentSessionSelection(cwd: string) {
  const [stored, setStored] = useState<AgentSelection>(readAgentSelection);
  const providersQuery = useAgentProviders();
  const providers = providersQuery.data ?? null;
  const provider = resolveProvider(stored.provider, providers);
  const catalogQuery = useAgentCatalog(provider, cwd);
  const catalog = catalogQuery.data ?? null;

  const selection: AgentSelection = {
    provider,
    model: resolveCatalogChoice(stored.model, catalog?.models),
    modeId: resolveCatalogChoice(stored.modeId, catalog?.modes),
  };

  // 写 ui_store 不能放进 setState 的 updater：updater 在渲染期执行，
  // 写入会同步通知其它组件，触发 React「渲染中更新其它组件」告警。
  const onChange = useCallback((next: AgentSelection) => {
    const merged = next.provider !== provider
      ? { provider: next.provider, model: null, modeId: null }
      : next;
    writeAgentSelection(merged);
    setStored(merged);
  }, [provider]);

  return {
    selection,
    onChange,
    providers,
    providersLoading: providersQuery.isLoading || (!providersQuery.data && providersQuery.fetchStatus === "idle"),
    providersError: providersQuery.error ? humanizeSidecarError(providersQuery.error) : undefined,
    catalog,
    catalogLoading: catalogQuery.isLoading,
    catalogError: catalogQuery.error ? humanizeSidecarError(catalogQuery.error) : undefined,
  };
}
