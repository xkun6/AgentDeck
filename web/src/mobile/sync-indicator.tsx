// 「正在同步…」提示：断线重连后按 sinceSeq 补齐各会话期间显示，补齐结束自动消失（界面照常可用，不阻塞）。
import { useSyncExternalStore } from "react";
import type { SidecarClient } from "@/lib/sidecar-client";
import s from "./mobile.module.css";

/** 订阅 client 的重连补齐状态；client 为空时恒为 false */
export function useClientSyncing(client: Pick<SidecarClient, "onSyncing" | "syncing"> | null): boolean {
  return useSyncExternalStore(
    (listener) => (client ? client.onSyncing(listener) : () => {}),
    () => client?.syncing ?? false,
  );
}

export function SyncBanner() {
  return (
    <div className={s.syncBanner} role="status">
      正在同步…
    </div>
  );
}
