// 把一台已配对电脑变成 SidecarClient：socket 走 E2EE 多地址连接，其余（请求匹配、seq 补齐、重连）沿用 sidecar-client。
import { SidecarClient, type SidecarClientOptions } from "@/lib/sidecar-client";
import { createE2eeSocketFactory, type E2eeSocketOptions } from "./e2ee-socket";
import type { HostStore, PairedHost } from "./hosts";

export interface HostClientOverrides extends Partial<Pick<E2eeSocketOptions, "createSocket" | "staggerMs" | "attemptTimeoutMs">> {
  client?: Partial<SidecarClientOptions>;
}

export function createHostClient(host: PairedHost, store: HostStore, overrides: HostClientOverrides = {}): SidecarClient {
  const { client: clientOptions, ...socketOverrides } = overrides;
  const client = new SidecarClient({
    // 地址与凭据由 socket 工厂每次建连时从 store 读取最新值，这里的 url 只是占位
    resolveUrl: async () => `e2ee://${host.id}`,
    socketFactory: createE2eeSocketFactory(() => {
      const current = store.get(host.id) ?? host;
      return {
        addresses: current.addresses,
        lastAddress: current.lastAddress ?? null,
        credentials: {
          mode: "auth",
          daemonPublicKey: current.daemonPublicKey,
          deviceId: current.deviceId,
          deviceSecret: current.deviceSecret,
        },
        onAddressSelected: (address) => {
          void store.setLastAddress(host.id, address);
        },
        ...socketOverrides,
      };
    }),
    ...clientOptions,
  });
  client.enableAutoReconnect();
  return client;
}
