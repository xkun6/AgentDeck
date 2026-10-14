// 桌面入口的 sidecar 连接：经 Tauri `get_sidecar_config` 取地址与 token、监听 `sidecar-status` 事件、
// socket 沿用原生 WS / Rust 中继自动回退。只被桌面 main.tsx 引用；手机入口不得引入本文件。
import { SidecarClient, type SidecarStatusPayload } from "./sidecar-client";
import { createSidecarSocket } from "./sidecar-socket-path";

export function buildSidecarSocketUrl(wsUrl: string, token: string): string {
  const url = new URL(wsUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" &&
    (window.__AGENTDECK_RUNTIME__?.platform === "tauri" || Boolean(window.__TAURI_INTERNALS__));
}

/** 解析当前 sidecar 的 ws 地址：Tauri 下取 `get_sidecar_config`，浏览器开发模式取环境变量。 */
export async function resolveSidecarUrl(): Promise<string> {
  if (isTauriRuntime()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const status = await invoke<SidecarStatusPayload>("get_sidecar_config");
    if (status.status !== "ready" || !status.wsUrl) {
      throw new Error(status.error || `Agent 服务未就绪（${status.status}）`);
    }
    return buildSidecarSocketUrl(status.wsUrl, status.token);
  }
  const wsUrl = import.meta.env.VITE_AGENTDECK_SIDECAR_URL?.trim();
  const token = import.meta.env.VITE_AGENTDECK_SIDECAR_TOKEN?.trim() ?? "";
  if (!wsUrl) {
    throw new Error("未配置 Agent 服务地址：浏览器模式请设置 VITE_AGENTDECK_SIDECAR_URL 与 VITE_AGENTDECK_SIDECAR_TOKEN");
  }
  return buildSidecarSocketUrl(wsUrl, token);
}

async function watchTauriSidecarStatus(client: SidecarClient): Promise<void> {
  const { listen } = await import("@tauri-apps/api/event");
  await listen<SidecarStatusPayload>("sidecar-status", (event) => {
    const status = event.payload;
    if (status.status !== "ready" || !status.wsUrl) return;
    const url = buildSidecarSocketUrl(status.wsUrl, status.token);
    // 已连在同一地址上无需重连；sidecar 重启后端口 / token 变化则立即重连
    if (client.state === "open" && client.currentUrl === url) return;
    client.forceReconnect("sidecar-status");
  });
}

export function createDesktopSidecarClient(): SidecarClient {
  const client = new SidecarClient({
    resolveUrl: resolveSidecarUrl,
    socketFactory: createSidecarSocket,
  });
  client.enableAutoReconnect();
  if (isTauriRuntime()) {
    void watchTauriSidecarStatus(client).catch((error) => {
      console.warn("[sidecar-client] 无法监听 sidecar-status", error);
    });
  }
  return client;
}
