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
import { createPreferencesStore } from "./preferences";
import { KeepAliveController } from "./native/keepalive-controller";
import { BackgroundNotifier } from "./native/local-notifications";
import { keepaliveStart, keepaliveStop } from "./native/native-plugin";
import { setBackgroundAttentionHandler } from "./attention";
import "@/styles/global.css";

// 手机上即使在 Tauri 壳里也不是桌面：显式声明，避免任何代码按 platform==="tauri" 去调桌面命令
window.__AGENTDECK_RUNTIME__ = { platform: "web" };
applyPlatformToDOM("web");
applyThemeToDOM(DEFAULT_THEME_CONFIG);

// 持久化只用 localStorage；桌面通知出口关闭（后台提醒走 setBackgroundAttentionHandler → 本地通知，见 bootstrap）
configureUiStoreBackend("local-storage");
configureNotifier(null);

async function bootstrap() {
  await initUiStore();
  const hosts = new HostStore(createHostStorage());
  await hosts.load();
  const manager = new ConnectionManager(hosts, queryClient);
  const prefs = createPreferencesStore();
  // 后台收到 client.attention → 本地通知；首次连上电脑（App 在前台）时申请通知权限
  const notifier = new BackgroundNotifier();
  setBackgroundAttentionHandler((notice) => void notifier.notify(notice));
  let permissionRequested = false;
  manager.subscribe(() => {
    if (permissionRequested || manager.getSnapshot().phase !== "open") return;
    permissionRequested = true;
    void notifier.ensurePermission();
  });
  // 后台保持连接：随连接状态与开关启停前台服务（非 Tauri 环境下原生调用是 no-op）
  new KeepAliveController(
    {
      getConnection: manager.getSnapshot,
      subscribeConnection: manager.subscribe,
      getPreferences: prefs.getState,
      subscribePreferences: prefs.subscribe,
      hostName: (hostId) => hosts.get(hostId)?.name,
    },
    { start: (text) => keepaliveStart(text), stop: keepaliveStop },
  );

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <MobileApp hosts={hosts} manager={manager} prefs={prefs} />
      </QueryClientProvider>
    </StrictMode>,
  );
}

void bootstrap();
