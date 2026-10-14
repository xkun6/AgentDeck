// 手机端入口（docs/mobile.md 第 4 节）。
//
// 与桌面 main.tsx 的区别：
// - 不安装 tauri-bridge、不用 Rust ui_store / 桌面通知 / 桌面 sidecar 连接（手机 Tauri 工程没有这些命令）；
// - 连接走远程网关：已配对电脑存在 HostStore（Android 用 tauri-plugin-store，浏览器用 localStorage），
//   ConnectionManager 把当前电脑变成 SidecarClient（E2EE socket、多地址、sinceSeq 补齐）并注入 sidecar-client。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_THEME_CONFIG, applyPlatformToDOM, applyThemeToDOM } from "@agentdeck/shared-ui";
import { queryClient } from "@/lib/query-client";
import { configureNotifier } from "@/lib/notifications";
import { configureUiStoreBackend, initUiStore } from "@/lib/ui-store";
import { HostStore } from "@/lib/remote/hosts";
import { ConnectionManager } from "./connection-manager";
import { MobileApp } from "./mobile-app";
import { createHostStorage } from "./platform";
import "@/styles/global.css";

// 手机上即使在 Tauri 壳里也不是桌面：显式声明，避免任何代码按 platform==="tauri" 去调桌面命令
window.__AGENTDECK_RUNTIME__ = { platform: "web" };
applyPlatformToDOM("web");
applyThemeToDOM(DEFAULT_THEME_CONFIG);

// 持久化只用 localStorage；桌面通知出口关闭（后台本地通知在 M3 经 configureNotifier / setBackgroundAttentionHandler 接入）
configureUiStoreBackend("local-storage");
configureNotifier(null);

async function bootstrap() {
  await initUiStore();
  const hosts = new HostStore(createHostStorage());
  await hosts.load();
  const manager = new ConnectionManager(hosts, queryClient);

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <MobileApp hosts={hosts} manager={manager} />
      </QueryClientProvider>
    </StrictMode>,
  );
}

void bootstrap();
