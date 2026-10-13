import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "path";

/**
 * Vite's dev port, resolved at startup.
 *
 * Windows reserves whole TCP port ranges for Hyper-V / WSL2 / WinNAT
 * ("excluded port ranges" — see `netsh interface ipv4 show excludedportrange
 * protocol=tcp`). Binding to a reserved port then fails with EACCES even
 * though nothing is listening, and the reserved ranges move across reboots —
 * so a hard-coded 9545 is not safe. We probe the exact addresses Node will
 * bind for `localhost` and, if the preferred port is blocked, fall back to a
 * free port (strictPort then applies to the chosen port).
 *
 * The probe is skipped when E2E_VITE_PORT is explicitly set (the e2e harness
 * has already verified the port) and under `tauri dev`, whose devUrl
 * is a static http://localhost:9545 — silently moving ports there would just
 * leave the WebView pointing at a dead URL, so it fails loudly instead.
 */
function resolveDevServerPort(): number {
  const preferred = Number(process.env.E2E_VITE_PORT || 9545);
  if (process.env.E2E_VITE_PORT || process.env.TAURI_ENV_PLATFORM) return preferred;

  const probeScript = `
    const net = require("net");
    const dns = require("dns");
    const probe = (port, host) => new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.listen(port, host, () => server.close(() => resolve(true)));
    });
    (async () => {
      const preferred = Number(process.argv[1]);
      const addrs = await new Promise((resolve) => {
        dns.lookup("localhost", { all: true }, (err, res) => {
          resolve(err ? [{ address: "127.0.0.1" }] : res);
        });
      });
      const usable = async (port) => {
        for (const { address } of addrs) {
          if (!(await probe(port, address))) return false;
        }
        return true;
      };
      let port = (await usable(preferred)) ? preferred : null;
      if (port == null) {
        port = await new Promise((resolve) => {
          const server = net.createServer();
          server.once("error", () => resolve(null));
          server.listen(0, "127.0.0.1", () => {
            const p = server.address().port;
            server.close(() => resolve(p));
          });
        });
        if (port == null || !(await usable(port))) process.exit(1);
      }
      process.stdout.write(String(port));
    })();
  `;
  try {
    const out = execFileSync(process.execPath, ["-e", probeScript, String(preferred)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
    const port = Number(out);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error("unexpected probe result: " + out);
    }
    if (port !== preferred) {
      console.warn(
        "\n[vite] Port " +
          preferred +
          " is blocked by the OS (Windows excluded port range, usually reserved " +
          "by Hyper-V/WSL2). Falling back to port " +
          port +
          ".\n",
      );
    }
    return port;
  } catch {
    // Probe failed — let Vite try the preferred port and surface its own error.
    return preferred;
  }
}

function gitShortCommit(): string {
  if (process.env.AGENTDECK_BUILD_COMMIT) return process.env.AGENTDECK_BUILD_COMMIT;
  try {
    return execSync("git rev-parse --short=12 HEAD", {
      cwd: resolve(__dirname, ".."),
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

function gitCommitDate(): string {
  if (process.env.AGENTDECK_BUILD_DATE) return process.env.AGENTDECK_BUILD_DATE;
  try {
    return execSync("git log -1 --format=%cI HEAD", {
      cwd: resolve(__dirname, ".."),
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

function desktopAppVersion(): string {
  if (process.env.AGENTDECK_DESKTOP_APP_VERSION) return process.env.AGENTDECK_DESKTOP_APP_VERSION;
  const pkgPath = resolve(__dirname, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || !pkg.version.trim()) {
    throw new Error(`${pkgPath} must define a desktop version`);
  }
  return pkg.version.trim();
}

export default defineConfig({
  // Packaged Tauri builds load web/dist through a custom protocol, so asset
  // URLs must stay relative instead of resolving to tauri://localhost/assets/*.
  base: "./",
  plugins: [react()],
  define: {
    "import.meta.env.VITE_AGENTDECK_BUILD_COMMIT": JSON.stringify(gitShortCommit()),
    "import.meta.env.VITE_AGENTDECK_BUILD_DATE": JSON.stringify(gitCommitDate()),
    "import.meta.env.VITE_AGENTDECK_DESKTOP_VERSION": JSON.stringify(desktopAppVersion()),
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    port: resolveDevServerPort(),
    strictPort: true,
  },
  build: {
    // Split heavy third-party libraries into their own chunks so the app
    // shell + route chunks stay small and, critically, Rollup never merges a
    // big vendor (e.g. the 3.3 MB mermaid bundle) into the startup chunk.
    // Without manualChunks the app bundle used to merge into the mermaid
    // chunk, forcing ~3.8 MB of JS to download+parse before first paint.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("xterm")) return "vendor-terminal";
          if (id.includes("mermaid") || id.includes("cytoscape") || id.includes("dagre") || id.includes("elkjs") || id.includes("khroma")) return "vendor-mermaid";
          if (id.includes("cmdk") || id.includes("@radix-ui") || id.includes("@floating-ui")) return "vendor-ui";
          if (id.includes("lucide-react")) return "vendor-icons";
          if (id.includes("katex") || id.includes("streamdown") || id.includes("rehype") || id.includes("remark") || id.includes("unified")) return "vendor-markdown";
          return undefined;
        },
      },
    },
  },
  css: {
    modules: {
      localsConvention: "camelCase",
    },
  },
});
