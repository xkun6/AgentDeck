// 按回合文件快照（design.md 4.24）的查询 hook。与 sidecar 通信只走 use-agent-session。
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import type { SnapshotTurn } from "@agentdeck/protocol";
import { sidecarConnectionAtom } from "@/stores/agents";
import { useAgentSession } from "./use-agent-session";

export const SNAPSHOT_QUERY_KEY = ["agentdeck", "snapshots"] as const;

const NO_TURNS: SnapshotTurn[] = [];

/**
 * 会话的快照索引。`busy` 由真转假（回合结束）时刷新一次；sidecar 的 snapshot.list 会等待该会话
 * 排队中的快照任务完成，所以刷新到的一定包含刚结束回合的 changedFiles。
 */
export function useSnapshotTurns(agentId: string | undefined, busy = false) {
  const actions = useAgentSession();
  const connected = useAtomValue(sidecarConnectionAtom) === "open";
  const query = useQuery({
    queryKey: [...SNAPSHOT_QUERY_KEY, agentId],
    queryFn: () => actions.listSnapshots(agentId as string),
    enabled: connected && Boolean(agentId),
    staleTime: 30_000,
    retry: false,
  });
  const wasBusy = useRef(busy);
  const refetch = query.refetch;
  useEffect(() => {
    if (wasBusy.current && !busy && agentId) void refetch();
    wasBusy.current = busy;
  }, [busy, agentId, refetch]);
  return { ...query, turns: query.data ?? NO_TURNS };
}
