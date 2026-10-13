// provider 列表、模型 / 模式目录、会话斜杠命令（来自 sidecar），以及新建会话的选择状态。
import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import type { AgentStatus } from "@agentdeck/protocol";
import { useAgentSession, humanizeSidecarError } from "@/hooks/use-agent-session";
import {
  findMode,
  isDangerousMode,
  readAgentSelection,
  resolveCatalogChoice,
  resolveModeChoice,
  resolveProvider,
  resolveThinkingChoice,
  writeAgentSelection,
  type AgentSelection,
} from "@/lib/agent-selection";
import { sidecarConnectionAtom } from "@/stores/agents";
import { AGENT_QUERY_KEYS } from "@/lib/agent-query-keys";
import { useProviderConfig } from "@/hooks/use-provider-config";

export function useAgentProviders() {
  const actions = useAgentSession();
  const connected = useAtomValue(sidecarConnectionAtom) === "open";
  return useQuery({
    queryKey: AGENT_QUERY_KEYS.providers,
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
    queryKey: [...AGENT_QUERY_KEYS.catalog, provider ?? "", cwd],
    queryFn: () => actions.listModels(provider!, cwd || undefined),
    enabled: connected && Boolean(provider),
    staleTime: 60_000,
    retry: 1,
  });
}

/**
 * 会话可用的斜杠命令（agent.commands）。key 带会话阶段：休眠（dormant / closed）走目录兜底，
 * 恢复后（starting → idle / running）换 key 自动重新拉取运行时的完整列表；idle ↔ running 不重复拉取。
 */
export function useAgentCommands(agentId: string | null | undefined, status: AgentStatus | undefined) {
  const actions = useAgentSession();
  const connected = useAtomValue(sidecarConnectionAtom) === "open";
  const phase = status === "dormant" || status === "closed" ? "inactive" : status === "starting" ? "starting" : "live";
  return useQuery({
    queryKey: [...AGENT_QUERY_KEYS.commands, agentId ?? "", phase],
    queryFn: () => actions.listCommands(agentId!),
    enabled: connected && Boolean(agentId),
    staleTime: 60_000,
    retry: 1,
  });
}

/** 新建会话的 Agent / 模型 / 模式 / 思考强度选择：读写 ui_store 记忆，并按可用性与目录校正。 */
export function useAgentSessionSelection(cwd: string) {
  const [stored, setStored] = useState<AgentSelection>(readAgentSelection);
  // 本次手动选中的危险模式（只有它会被保留；记忆里的危险模式不恢复）
  const [pickedDangerousModeId, setPickedDangerousModeId] = useState<string | null>(null);
  const providersQuery = useAgentProviders();
  const providers = providersQuery.data ?? null;
  const providerConfigQuery = useProviderConfig();
  const provider = resolveProvider(stored.provider, providers);
  const catalogQuery = useAgentCatalog(provider, cwd);
  const catalog = catalogQuery.data ?? null;

  const model = resolveCatalogChoice(stored.model, catalog?.models);
  const selection: AgentSelection = {
    provider,
    model,
    modeId: resolveModeChoice(stored.modeId, catalog?.modes, pickedDangerousModeId),
    thinkingOptionId: resolveThinkingChoice(stored.thinkingOptionId, catalog?.models, model),
  };

  // 写 ui_store 不能放进 setState 的 updater：updater 在渲染期执行，
  // 写入会同步通知其它组件，触发 React「渲染中更新其它组件」告警。
  const onChange = useCallback((next: AgentSelection) => {
    const merged: AgentSelection = next.provider !== provider
      ? { provider: next.provider, model: null, modeId: null, thinkingOptionId: null }
      : next;
    const modes = next.provider !== provider ? undefined : catalog?.modes;
    setPickedDangerousModeId(isDangerousMode(findMode(merged.modeId, modes)) ? merged.modeId : null);
    writeAgentSelection(merged, modes);
    setStored(merged);
  }, [catalog?.modes, provider]);

  return {
    selection,
    onChange,
    providers,
    providerProfiles: providerConfigQuery.data?.providers ?? null,
    providersLoading: providersQuery.isLoading || (!providersQuery.data && providersQuery.fetchStatus === "idle"),
    providersError: providersQuery.error ? humanizeSidecarError(providersQuery.error) : undefined,
    catalog,
    catalogLoading: catalogQuery.isLoading,
    catalogError: catalogQuery.error ? humanizeSidecarError(catalogQuery.error) : undefined,
  };
}
