/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HERMES_BUILD_COMMIT?: string;
  readonly VITE_HERMES_DESKTOP_VERSION?: string;
  readonly VITE_HERMES_DASHBOARD_ORIGIN?: string;
  /** 浏览器开发模式（非 Tauri）直连 sidecar 的 ws 地址，如 ws://127.0.0.1:17777/rpc */
  readonly VITE_AGENTDECK_SIDECAR_URL?: string;
  /** 浏览器开发模式直连 sidecar 用的 token（与 sidecar 的 AGENTDECK_TOKEN 一致） */
  readonly VITE_AGENTDECK_SIDECAR_TOKEN?: string;
}
