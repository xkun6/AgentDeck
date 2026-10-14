import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "path";

function gitShortCommit(): string {
  try {
    return execSync("git rev-parse --short=12 HEAD", { cwd: resolve(__dirname, ".."), stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function appVersion(): string {
  return (JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")) as { version: string }).version;
}

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
// 连接参数不在构建期注入：运行时从已配对电脑（HostStore）读取，经远程网关 E2EE 连接。
export default defineConfig({
  base: "./",
  plugins: [react(), renameMobileEntry()],
  define: {
    "import.meta.env.VITE_AGENTDECK_BUILD_COMMIT": JSON.stringify(gitShortCommit()),
    "import.meta.env.VITE_AGENTDECK_DESKTOP_VERSION": JSON.stringify(appVersion()),
  },
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
