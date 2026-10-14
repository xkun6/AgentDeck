// 手机端入口（M0 技术验证，docs/mobile.md 第 5 节）。
//
// 与桌面 main.tsx 的区别：
// - 不安装 tauri-bridge、不初始化 Rust ui_store（手机 Tauri 工程没有桌面命令）；
// - 不走 sidecar-client 的 get_sidecar_config / Rust WS 中继，直接用构建期环境变量里的地址建原生 WebSocket；
// - 每收到一帧 / 每次心跳都 console.log 带时间戳的标记，供 logcat 判断后台存活。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Provider as JotaiProvider, getDefaultStore } from "jotai";
import { QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_THEME_CONFIG, applyPlatformToDOM, applyThemeToDOM, themeAtom } from "@agentdeck/shared-ui";
import { queryClient } from "@/lib/query-client";
import { SidecarClient, __setSidecarClientForTests, buildSidecarSocketUrl } from "@/lib/sidecar-client";
import { MobileApp } from "./mobile-app";
import { m0Log } from "./m0-log";
import "@/styles/global.css";

const SIDECAR_URL = import.meta.env.VITE_AGENTDECK_SIDECAR_URL?.trim() ?? "";
const SIDECAR_TOKEN = import.meta.env.VITE_AGENTDECK_SIDECAR_TOKEN?.trim() ?? "";
const HEARTBEAT_MS = 15_000;

/** 给原生 WebSocket 挂帧计数日志（不改 sidecar-client）。 */
function loggingSocket(url: string): WebSocket {
  const ws = new WebSocket(url);
  let frames = 0;
  ws.addEventListener("open", () => m0Log("ws-open"));
  ws.addEventListener("close", (event) => m0Log(`ws-close code=${event.code}`));
  ws.addEventListener("error", () => m0Log("ws-error"));
  ws.addEventListener("message", (event) => {
    frames += 1;
    const text = typeof event.data === "string" ? event.data : "";
    const method = /"method":"([^"]+)"/.exec(text.slice(0, 120))?.[1] ?? "response";
    m0Log(`ws-frame #${frames} ${method}`);
  });
  return ws;
}

function installClient(): SidecarClient {
  const client = new SidecarClient({
    resolveUrl: async () => {
      if (!SIDECAR_URL) throw new Error("构建时未设置 VITE_AGENTDECK_SIDECAR_URL");
      return buildSidecarSocketUrl(SIDECAR_URL, SIDECAR_TOKEN);
    },
    socketFactory: loggingSocket,
  });
  client.enableAutoReconnect();
  // M0：sidecar-client 在 Tauri 环境下会走 get_sidecar_config，这里直接换成自己的实例。
  __setSidecarClientForTests(client);

  client.onStream((envelope, meta) => {
    m0Log(`agent.stream agent=${envelope.agentId.slice(0, 8)} seq=${envelope.seq} ${envelope.event.type}${meta.replay ? " replay" : ""}`);
  });
  client.onState((state) => m0Log(`state=${state}`));

  // 心跳：JS 定时器 + sidecar.info 请求。WebView 被冻结时两者都会停。
  setInterval(() => {
    const started = performance.now();
    client
      .request("sidecar.info", undefined, { timeoutMs: 10_000 })
      .then(() => m0Log(`heartbeat ok rtt=${Math.round(performance.now() - started)}ms`))
      .catch((error: unknown) => m0Log(`heartbeat fail ${String(error)}`));
  }, HEARTBEAT_MS);
  document.addEventListener("visibilitychange", () => m0Log(`visibility=${document.visibilityState}`));
  return client;
}

applyPlatformToDOM("web");
applyThemeToDOM(DEFAULT_THEME_CONFIG);
const jotaiStore = getDefaultStore();
jotaiStore.set(themeAtom, DEFAULT_THEME_CONFIG);

const client = installClient();
client.connect().catch(() => {});
m0Log("boot");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <JotaiProvider store={jotaiStore}>
        <MobileApp />
      </JotaiProvider>
    </QueryClientProvider>
  </StrictMode>,
);
