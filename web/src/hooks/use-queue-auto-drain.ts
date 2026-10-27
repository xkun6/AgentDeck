import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { useAgentSession } from "@/hooks/use-agent-session";
import { useProviderConfig } from "@/hooks/use-provider-config";
import { prepareAgentPrompt } from "@/lib/agent-prompt";
import { relaySessionState } from "@/lib/provider-profiles";
import { isRuntimeRunning } from "@/lib/session-activity";
import { agentSnapshotsAtom } from "@/stores/agents";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import {
  clearQueueInterrupted,
  drainQueuedPrompt,
  entriesFor,
  shouldAutoDrainOnSettle,
  takeQueueInterrupted,
  useQueueState,
} from "@/stores/composer-queue";

/**
 * 发送队列自动出队：在应用根部监视所有会话，回合结束（忙 → 闲）时发出该会话队首的排队消息。
 * 不依赖详情页是否正在显示该会话，切换会话 / 停留在其他页面时同样会发出。
 */
export function useQueueAutoDrain(): void {
  const actions = useAgentSession();
  const snapshots = useAtomValue(agentSnapshotsAtom);
  const runtimes = useAtomValue(chatRuntimeBySessionAtom);
  const queues = useQueueState();
  const providerConfigQuery = useProviderConfig();
  const busyRef = useRef<Record<string, boolean>>({});

  useEffect(() => {
    const previous = busyRef.current;
    const next: Record<string, boolean> = {};
    for (const id of new Set([...Object.keys(snapshots), ...Object.keys(runtimes)])) {
      const isBusy = isRuntimeRunning(runtimes[id]) || snapshots[id]?.status === "running";
      const wasBusy = previous[id] ?? false;
      next[id] = isBusy;
      if (isBusy && !wasBusy) {
        clearQueueInterrupted(id);
        continue;
      }
      if (isBusy || !wasBusy) continue;
      const queue = entriesFor(queues, id);
      if (!shouldAutoDrainOnSettle({
        isBusy,
        wasBusy,
        queueLength: queue.length,
        userInterrupted: takeQueueInterrupted(id),
      })) continue;
      const providerDisabled =
        relaySessionState(snapshots[id]?.provider, providerConfigQuery.data?.providers) === "disabled";
      void drainQueuedPrompt(id, queue[0]!, async (entry) => {
        const prepared = await prepareAgentPrompt({ text: entry.text, attachments: entry.attachments });
        await actions.sendPrompt(id, prepared.prompt, {
          displayText: prepared.displayText,
          displayImages: prepared.displayImages,
          providerDisabled,
        });
      });
    }
    busyRef.current = next;
  }, [actions, providerConfigQuery.data, queues, runtimes, snapshots]);
}
