// 手机端的「当前连接的电脑」：把 HostStore 里的一台已配对电脑变成 SidecarClient，
// 并为它准备独立的 jotai store（切换电脑时旧电脑的会话 / 时间线不会残留）。
import { createStore } from "jotai";
import type { QueryClient } from "@tanstack/react-query";
import { DEFAULT_THEME_CONFIG, themeAtom } from "@agentdeck/shared-ui";
import type { AuthFailedReason } from "@agentdeck/remote";
import { DEFAULT_LIVENESS_PROBE, configureSidecarClient, type SidecarClient } from "@/lib/sidecar-client";
import { getMobileConnectionLog } from "@/lib/connection-log";
import { createHostClient } from "@/lib/remote/connection";
import type { HostStore } from "@/lib/remote/hosts";
import { isAppForeground } from "./native/app-state";

/** 手机首屏取最近这么多条时间线条目，更早的向前翻页（design.md 4.31） */
export const MOBILE_HISTORY_LIMIT = 300;

export type ConnectionPhase = "idle" | "connecting" | "open" | "failed" | "auth_failed";

export interface ConnectionSnapshot {
  hostId: string | null;
  phase: ConnectionPhase;
  /** failed：网络类原因；auth_failed：凭据失效的原因码 */
  error: string | null;
  authReason: AuthFailedReason | null;
  client: SidecarClient | null;
  store: ReturnType<typeof createStore> | null;
}

const IDLE: ConnectionSnapshot = {
  hostId: null,
  phase: "idle",
  error: null,
  authReason: null,
  client: null,
  store: null,
};

export const AUTH_REASON_TEXT: Record<AuthFailedReason, string> = {
  expired: "凭据已失效，请重新配对",
  invalid: "凭据已失效，请重新配对",
  revoked: "此设备已在电脑上被吊销，请重新配对",
};

function isAuthReason(value: string): value is AuthFailedReason {
  return value === "expired" || value === "invalid" || value === "revoked";
}

export class ConnectionManager {
  private snapshot: ConnectionSnapshot = IDLE;
  private readonly listeners = new Set<() => void>();
  private teardown: Array<() => void> = [];

  constructor(
    private readonly hosts: HostStore,
    private readonly queryClient: Pick<QueryClient, "clear">,
    private readonly createClient: (hostId: string) => SidecarClient | null = (hostId) => {
      const host = this.hosts.get(hostId);
      return host
        ? createHostClient(host, this.hosts, {
            client: {
              historyLimit: MOBILE_HISTORY_LIMIT,
              livenessProbe: DEFAULT_LIVENESS_PROBE,
              isBackground: () => !isAppForeground(),
              eventLog: getMobileConnectionLog(),
            },
          })
        : null;
    },
  ) {}

  getSnapshot = (): ConnectionSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** 连接某台电脑（已连着别的电脑则先断开）；同一台电脑已在连接中 / 已连接则忽略 */
  connect(hostId: string): void {
    if (this.snapshot.hostId === hostId && this.snapshot.client && this.snapshot.phase !== "auth_failed") return;
    this.disconnect();
    const client = this.createClient(hostId);
    if (!client) return;
    this.queryClient.clear();
    const store = createStore();
    store.set(themeAtom, DEFAULT_THEME_CONFIG);
    configureSidecarClient({ client });
    this.teardown = [
      client.onState((state) => this.onClientState(client, state)),
      client.onTerminalError((error) => {
        this.update({
          phase: "auth_failed",
          error: error.reason,
          authReason: isAuthReason(error.reason) ? error.reason : "invalid",
        });
      }),
    ];
    this.snapshot = { hostId, phase: "connecting", error: null, authReason: null, client, store };
    this.emit();
    client.connect().catch(() => {});
  }

  /** 凭据失效后用户点「重试」：清掉终止状态重新连接 */
  retry(): void {
    this.snapshot.client?.forceReconnect("manual");
  }

  disconnect(): void {
    for (const off of this.teardown) off();
    this.teardown = [];
    const { client } = this.snapshot;
    if (client) client.close();
    configureSidecarClient({ client: null });
    this.snapshot = IDLE;
    this.emit();
  }

  private onClientState(client: SidecarClient, state: string): void {
    if (this.snapshot.client !== client) return;
    if (this.snapshot.phase === "auth_failed" && state === "error") return;
    switch (state) {
      case "open":
        this.update({ phase: "open", error: null, authReason: null });
        break;
      case "connecting":
      case "idle":
        this.update({ phase: "connecting", error: null });
        break;
      default:
        this.update({ phase: "failed", error: client.lastError ?? "无法连接电脑" });
    }
  }

  private update(patch: Partial<ConnectionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
