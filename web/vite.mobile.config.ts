import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

/** Tauri 的 frontendDist 约定入口为 index.html：构建产物里把 mobile.html 改名。 */
function renameMobileEntry(): Plugin {
  return {
    name: "agentdeck-rename-mobile-entry",
    enforce: "post",
    generateBundle(_options, bundle) {
      const html = bundle["mobile.html"];
      if (html) {
        delete bundle["mobile.html"];
        html.fileName = "index.html";
        bundle["index.html"] = html;
      }
    },
  };
}

// 手机端（Tauri Android）独立入口：web/mobile.html → web/src/mobile/main.tsx，输出 web/dist-mobile。
// 连接参数由构建期环境变量 VITE_AGENTDECK_SIDECAR_URL / VITE_AGENTDECK_SIDECAR_TOKEN 注入（M0 临时方案）。
export default defineConfig({
  base: "./",
  plugins: [react(), renameMobileEntry()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    port: 9546,
    strictPort: true,
    host: true,
  },
  build: {
    outDir: "dist-mobile",
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, "mobile.html"),
    },
  },
  css: {
    modules: {
      localsConvention: "camelCase",
    },
  },
});
