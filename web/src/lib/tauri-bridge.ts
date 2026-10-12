// Tauri v2 IPC bridge.
//
// Wraps @tauri-apps/api/core::invoke() calls to match the hermesDesktop API
// surface. On initialization, populates window.hermesDesktop so that ALL
// existing call sites (settings.tsx, projects.tsx, goose-composer.tsx, etc.)
// work without any changes.
//
// 只包装 Rust 外壳实际注册的命令（见 src/main.rs 的 generate_handler!）。
// 启动时等待 Node sidecar 就绪（sidecar-status）后再挂载 React。

import type {
  CodingAgentsCheckResult,
  EnvironmentCheckResult,
  ExportLogSnapshotInput,
  ExportLogSnapshotResult,
} from "@agentdeck/protocol";
import type {
  DesktopNotifyInput,
  DesktopNotifyResult,
  DesktopFileDropPayload,
  DownloadExternalImageInput,
  DownloadedImageResult,
  ExternalRequestInput,
  ExternalRequestResult,
  FilePickerResult,
  FilePreview,
  PreviewFileChangedPayload,
  FsListInput,
  FsListResult,
  ReadWorkspaceFileInput,
  ExternalTerminalResult,
  TerminalEventPayload,
  TerminalOpenExternalInput,
  TerminalStartInput,
  TerminalStartResult,
  UiEventInput,
  UiStoreSnapshot,
  UiTurnStats,
  WatchPreviewFileResult,
  WriteWorkspaceFileInput,
  WriteWorkspaceFileResult,
  HermesGitBridge,
  DesktopWindowControls,
} from "./runtime";
import { BUILD_COMMIT, DESKTOP_VERSION, versionLabel } from "./build-info";
import type { SidecarStatusPayload } from "./sidecar-client";

let invoke: typeof import("@tauri-apps/api/core").invoke;

const BASE64_CHUNK_SIZE = 0x8000;
type TauriFileDropPosition = {
  x: number;
  y: number;
};

type TauriFileDropEventPayload =
  | { type: "enter"; paths?: string[]; position?: TauriFileDropPosition }
  | { type: "over"; position?: TauriFileDropPosition }
  | { type: "drop"; paths?: string[]; position?: TauriFileDropPosition }
  | { type: "leave" };

interface BootstrapVersionLine {
  label: "界面";
  version: string;
  commit: string;
}

function shortBootstrapCommit(commit: string | undefined): string {
  const normalized = commit?.trim() ?? "";
  if (!normalized || normalized === "unknown") return "—";
  return normalized.slice(0, 4);
}

function buildBootstrapVersionLine(): BootstrapVersionLine {
  return {
    label: "界面",
    version: versionLabel(DESKTOP_VERSION),
    commit: shortBootstrapCommit(BUILD_COMMIT),
  };
}

export function arrayBufferToBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  const chunks: string[] = [];

  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE)));
  }

  return btoa(chunks.join(""));
}

async function ensureInvoke() {
  if (!invoke) {
    const mod = await import("@tauri-apps/api/core");
    invoke = mod.invoke;
  }
  return invoke;
}

// Tear down a Tauri event listener without ever surfacing an unhandled rejection.
// When a listener is unlistened before its async registration has fully landed
// in Tauri's internal map (e.g. React StrictMode mount→unmount racing the
// onDragDropEvent/listen promise), Tauri's injected unregisterListener throws
// "undefined is not an object (evaluating 'listeners[eventId].handlerId')".
// The unlisten can fail either synchronously or as a rejected promise depending
// on the transport, so guard both. The listener is gone regardless — swallow it.
function safeUnlisten(unlisten: (() => void) | null | undefined): void {
  if (!unlisten) return;
  try {
    const result = unlisten() as unknown;
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      void (result as Promise<unknown>).catch(() => {});
    }
  } catch {
    // Listener was never fully registered or was already removed.
  }
}

// Tauri's webview onDragDropEvent wraps its unlisten so the actual teardown runs
// in a detached promise that never reaches safeUnlisten's catch above. When that
// teardown loses the StrictMode mount→unmount race, its
// "listeners[eventId].handlerId" TypeError surfaces as an *unhandled* rejection
// even though the listener is already gone and nothing is broken. Swallow exactly
// that signature (the Tauri-internal "handlerId" field name — app code never
// throws it) and let every other rejection propagate untouched.
let rejectionGuardInstalled = false;

function isTauriListenerTeardownRejection(reason: unknown): boolean {
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason
        : "";
  // WebKit: "undefined is not an object (evaluating 'listeners[eventId].handlerId')"
  // Chromium: "Cannot read properties of undefined (reading 'handlerId')"
  return message.includes("handlerId");
}

function installTauriRejectionGuard(): void {
  if (rejectionGuardInstalled || typeof window === "undefined") return;
  if (typeof window.addEventListener !== "function") return;
  rejectionGuardInstalled = true;
  window.addEventListener("unhandledrejection", (event) => {
    if (isTauriListenerTeardownRejection(event.reason)) {
      event.preventDefault();
    }
  });
}

export interface TauriIpcError extends Error {
  code?: string;
  kind?: string;
  details?: unknown;
  raw?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function normalizeTauriInvokeError(error: unknown): Error {
  if (error instanceof Error) return error;

  if (isRecord(error)) {
    const message = typeof error.message === "string" && error.message.trim()
      ? error.message
      : JSON.stringify(error);
    const normalized = new Error(message) as TauriIpcError;
    if (typeof error.code === "string") normalized.code = error.code;
    if (typeof error.kind === "string") normalized.kind = error.kind;
    if ("details" in error) normalized.details = error.details;
    normalized.raw = error;
    return normalized;
  }

  return new Error(String(error));
}

async function invokeCommand<T = any>(command: string, args?: Record<string, unknown>): Promise<T> {
  const inv = await ensureInvoke();
  try {
    return await inv<T>(command, args);
  } catch (error) {
    throw normalizeTauriInvokeError(error);
  }
}

function normalizeFileDropPayload(payload: TauriFileDropEventPayload): DesktopFileDropPayload {
  return {
    phase: payload.type,
    paths: "paths" in payload && Array.isArray(payload.paths) ? payload.paths : [],
    position: "position" in payload && payload.position
      ? { x: payload.position.x, y: payload.position.y }
      : undefined,
  };
}

const tauriBridge = {
  windowType: "tauri" as const,

  async fatalErrorAndExit(input: { title: string; message: string }): Promise<never> {
    return invokeCommand("fatal_error_and_exit", { input });
  },

  async externalRequest(input: ExternalRequestInput): Promise<ExternalRequestResult> {
    return invokeCommand("external_request", { input });
  },

  async downloadExternalImage(input: DownloadExternalImageInput): Promise<DownloadedImageResult> {
    return invokeCommand("download_external_image", { input });
  },

  async pickFiles(): Promise<FilePickerResult> {
    return invokeCommand("pick_files");
  },

  async pickDirectory(): Promise<FilePickerResult> {
    return invokeCommand("pick_directory");
  },

  async createWorkspaceProject(): Promise<FilePickerResult> {
    return invokeCommand("create_workspace_project");
  },

  onFileDrop(handler: (payload: DesktopFileDropPayload) => void): () => void {
    let unlisten: (() => void) | null = null;
    let disposed = false;

    import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          handler(normalizeFileDropPayload(event.payload as TauriFileDropEventPayload));
        }))
      .then((fn) => {
        if (disposed) {
          safeUnlisten(fn);
        } else {
          unlisten = fn;
        }
      })
      .catch((error) => {
        console.warn("Failed to register Tauri file drop handler", error);
      });

    return () => {
      disposed = true;
      safeUnlisten(unlisten);
    };
  },

  async openWorkspacePath(input: { path: string }): Promise<ExternalRequestResult> {
    return invokeCommand("open_workspace_path", { input });
  },

  async openExternalUrl(input: { url: string }): Promise<{ ok: boolean; message?: string | null }> {
    return invokeCommand("open_external_url", { input });
  },

  async toggleDevtools(): Promise<void> {
    return invokeCommand("toggle_devtools");
  },

  async exportLogSnapshot(input: ExportLogSnapshotInput): Promise<ExportLogSnapshotResult> {
    return invokeCommand("export_log_snapshot", { input });
  },

  async environmentCheck(): Promise<EnvironmentCheckResult> {
    return invokeCommand("environment_check");
  },

  async codingAgentsCheck(): Promise<CodingAgentsCheckResult> {
    return invokeCommand("coding_agents_check");
  },

  async uiStoreSnapshot(): Promise<UiStoreSnapshot> {
    return invokeCommand("ui_store_snapshot");
  },

  async uiStoreSetKv(input: { key: string; value: unknown }): Promise<boolean> {
    return invokeCommand("ui_store_set_kv", { input });
  },

  async uiStoreRemoveKv(input: { key: string }): Promise<boolean> {
    return invokeCommand("ui_store_remove_kv", { input });
  },

  async uiStoreRecordTurnStats(input: UiTurnStats): Promise<boolean> {
    return invokeCommand("ui_store_record_turn_stats", { input });
  },

  async uiStoreGetTurnStats(input: { sessionId: string }): Promise<UiTurnStats[]> {
    return invokeCommand("ui_store_get_turn_stats", { input });
  },

  async uiStoreGetTurnStatsWindow(input: { sinceMs?: number; limit?: number }): Promise<UiTurnStats[]> {
    return invokeCommand("ui_store_get_turn_stats_window", { input });
  },

  async uiStoreRecordEvent(input: UiEventInput): Promise<boolean> {
    return invokeCommand("ui_store_record_event", { input });
  },

  async desktopNotify(input: DesktopNotifyInput): Promise<DesktopNotifyResult> {
    return invokeCommand("desktop_notify", { input });
  },

  async terminalStart(input: TerminalStartInput): Promise<TerminalStartResult> {
    return invokeCommand("terminal_start", { input });
  },

  async terminalOpenExternal(input: TerminalOpenExternalInput): Promise<ExternalTerminalResult> {
    return invokeCommand("terminal_open_external", { input });
  },

  async terminalWrite(input: { terminalId: string; data: string }): Promise<boolean> {
    return invokeCommand("terminal_write", { input });
  },

  async terminalResize(input: { terminalId: string; cols: number; rows: number }): Promise<boolean> {
    return invokeCommand("terminal_resize", { input });
  },

  async terminalClose(input: { terminalId: string }): Promise<boolean> {
    return invokeCommand("terminal_close", { input });
  },

  onTerminalOutput(handler: (event: TerminalEventPayload) => void): () => void {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<TerminalEventPayload>("terminal-output", (event) => {
          handler(event.payload);
        }))
      .then((fn) => {
        if (disposed) safeUnlisten(fn);
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      safeUnlisten(unlisten);
    };
  },

  async readWorkspaceFile(input: ReadWorkspaceFileInput): Promise<FilePreview> {
    return invokeCommand("read_workspace_file", { input });
  },

  async fsList(input: FsListInput): Promise<FsListResult> {
    return invokeCommand("fs_list", { input });
  },

  async readFileDataUrl(path: string): Promise<string> {
    return invokeCommand("read_file_data_url", { input: { path } });
  },

  async writeWorkspaceFile(input: WriteWorkspaceFileInput): Promise<WriteWorkspaceFileResult> {
    return invokeCommand("write_workspace_file", { input });
  },
  // Git ops backing the review pane (issue #328). Mirrors the upstream
  // `window.hermesDesktop.git.review.*` shape so the ported review logic reads
  // naturally; each method forwards to a Rust command that shells `git`/`gh`.
  git: {
    review: {
      list: (input) => invokeCommand("git_review_list", { input }),
      diff: (input) => invokeCommand("git_review_diff", { input }),
      stage: (input) => invokeCommand("git_review_stage", { input }),
      unstage: (input) => invokeCommand("git_review_unstage", { input }),
      revert: (input) => invokeCommand("git_review_revert", { input }),
      revParse: (input) => invokeCommand("git_review_rev_parse", { input }),
      commit: (input) => invokeCommand("git_review_commit", { input }),
      commitContext: (input) => invokeCommand("git_review_commit_context", { input }),
      push: (input) => invokeCommand("git_review_push", { input }),
      shipInfo: (input) => invokeCommand("git_review_ship_info", { input }),
      createPr: (input) => invokeCommand("git_review_create_pr", { input }),
    },
    // Worktree / branch / status ops backing the projects sidebar (issue #327).
    worktree: {
      list: (input) => invokeCommand("git_worktree_list", { input }),
      add: (input) => invokeCommand("git_worktree_add", { input }),
      remove: (input) => invokeCommand("git_worktree_remove", { input }),
    },
    branch: {
      list: (input) => invokeCommand("git_branch_list", { input }),
      switch: (input) => invokeCommand("git_branch_switch", { input }),
    },
    repoStatus: (input) => invokeCommand("git_repo_status", { input }),
  } satisfies HermesGitBridge,

  async watchPreviewFile(input: { path: string }): Promise<WatchPreviewFileResult> {
    return invokeCommand("watch_preview_file", { input });
  },

  async stopPreviewFileWatch(input: { watchId: string }): Promise<boolean> {
    return invokeCommand("stop_preview_file_watch", { input });
  },

  onPreviewFileChanged(handler: (payload: PreviewFileChangedPayload) => void): () => void {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<PreviewFileChangedPayload>("preview-file-changed", (event) => {
          handler(event.payload);
        }))
      .then((fn) => {
        if (disposed) safeUnlisten(fn);
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      safeUnlisten(unlisten);
    };
  },

  onSystemResume(handler: () => void): () => void {
    // Initial build: rely on the JS clock-skew watchdog in sidecar-client.ts.
    // The watchdog detects sleep/wake within ~5s, which is acceptable.
    // Native power monitoring can be added later via a Tauri event.
    let unlisten: (() => void) | null = null;
    let disposed = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen("system-resume", handler))
      .then((fn) => {
        if (disposed) safeUnlisten(fn);
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      safeUnlisten(unlisten);
    };
  },

  setUiZoom(factor: number): void {
    // Native webview page zoom (WKWebView setPageZoom / WebView2 ZoomFactor /
    // WebKitGTK zoom_level). Unlike CSS `zoom`, page zoom reflows the layout and
    // scales the viewport, so `100vw`/`100vh` keep matching the window and the
    // interface-scale setting no longer clips the right edge / bottom status bar.
    import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => getCurrentWebview().setZoom(factor))
      .catch((error) => {
        console.warn("Failed to apply webview zoom", error);
      });
  },
};

// 自绘标题栏的窗口控制。只在主窗口没有原生标题栏（Windows / Linux，见 src/main.rs）时挂载，
// 由 installTauriBridge 在 React 挂载前用 isDecorated() 判定，组件只看 windowControls 是否存在。
const tauriWindowControls: DesktopWindowControls = {
  async minimize(): Promise<void> {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().minimize();
  },

  async toggleMaximize(): Promise<void> {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().toggleMaximize();
  },

  async close(): Promise<void> {
    // close() 触发 CloseRequested：托盘可用时 Rust 侧拦截并隐藏到托盘。
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
  },

  async isMaximized(): Promise<boolean> {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow().isMaximized();
  },

  onResized(handler: () => void): () => void {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().onResized(() => handler()))
      .then((fn) => {
        if (disposed) safeUnlisten(fn);
        else unlisten = fn;
      })
      .catch((error) => {
        console.warn("Failed to register window resize handler", error);
      });
    return () => {
      disposed = true;
      safeUnlisten(unlisten);
    };
  },
};

async function resolveWindowControls(): Promise<DesktopWindowControls | null> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return (await getCurrentWindow().isDecorated()) ? null : tauriWindowControls;
  } catch {
    // 拿不到窗口信息时保留原状（不渲染自绘按钮），不影响启动。
    return null;
  }
}

// Overlay shown while the Rust side starts the Node sidecar before React can
// mount. Pre-React, plain DOM. Phases follow the `sidecar-status` event
// (starting / failed / stopped); failures expose the full error text and a
// 「重试」button that calls `restart_sidecar`.
interface BootstrapOverlay {
  update(phase: "starting" | "error", message: string): void;
  dismiss(): void;
}

function showBootstrapOverlay(initialMessage: string, onRetry: () => void): BootstrapOverlay {
  let lastErrorMessage = "";

  const root = document.createElement("div");
  root.id = "hermes-bootstrap-overlay";
  root.setAttribute(
    "style",
    "position:fixed;inset:0;background:#111111;" +
      "color:#fbfaf6;display:flex;align-items:center;justify-content:center;" +
      "font-family:'HarmonyOS Sans SC','HarmonyOS Sans','PingFang SC','Segoe UI',sans-serif;" +
      "z-index:2147483647;padding:48px;box-sizing:border-box;overflow:auto;",
  );

  const panel = document.createElement("section");
  panel.setAttribute("aria-live", "polite");
  panel.setAttribute(
    "style",
    "width:min(760px,calc(100vw - 64px));display:flex;flex-direction:column;" +
      "align-items:center;gap:20px;text-align:center;",
  );

  const title = document.createElement("div");
  title.setAttribute(
    "style",
    "font-size:16px;font-weight:700;letter-spacing:0.02em;color:#fbfaf6;",
  );
  title.textContent = "AgentDeck";
  panel.appendChild(title);

  const brand = document.createElement("div");
  brand.setAttribute(
    "style",
    "margin-top:-12px;font-size:12px;font-weight:600;color:rgba(251,250,246,0.54);" +
      "letter-spacing:0.08em;",
  );
  brand.textContent = "多 Agent 编排桌面工具";
  panel.appendChild(brand);

  const message = document.createElement("div");
  message.id = "hermes-bootstrap-message";
  message.setAttribute(
    "style",
    "font-size:15px;color:rgba(251,250,246,0.9);max-width:620px;line-height:1.6;",
  );
  message.textContent = initialMessage;
  panel.appendChild(message);

  const detail = document.createElement("div");
  detail.id = "hermes-bootstrap-error-detail";
  detail.setAttribute(
    "style",
    "display:none;width:100%;box-sizing:border-box;margin-top:4px;border:1px solid rgba(251,250,246,0.14);" +
      "border-radius: 0;background:#181818;overflow:hidden;",
  );

  const detailHeader = document.createElement("div");
  detailHeader.setAttribute(
    "style",
    "display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;" +
      "border-bottom:1px solid rgba(251,250,246,0.1);",
  );

  const detailTitle = document.createElement("div");
  detailTitle.setAttribute(
    "style",
    "font-size:12px;font-weight:700;color:rgba(251,250,246,0.72);letter-spacing:0.08em;text-transform:uppercase;",
  );
  detailTitle.textContent = "完整错误信息";
  detailHeader.appendChild(detailTitle);

  const buttonStyle =
    "appearance:none;border:1px solid rgba(251,250,246,0.18);background:rgba(251,250,246,0.08);" +
    "color:#fbfaf6;border-radius: 0;padding:8px 12px;font-size:12px;font-weight:700;" +
    "font-family:inherit;cursor:pointer;";

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.disabled = true;
  copyButton.setAttribute("style", buttonStyle);
  copyButton.textContent = "复制错误信息";
  detailHeader.appendChild(copyButton);
  detail.appendChild(detailHeader);

  const errorText = document.createElement("pre");
  errorText.id = "hermes-bootstrap-error-text";
  errorText.tabIndex = 0;
  errorText.setAttribute(
    "style",
    "margin:0;max-height:min(300px,38vh);overflow:auto;padding:16px;text-align:left;" +
      "white-space:pre-wrap;word-break:break-word;user-select:text;" +
      "font-family:'JetBrains Mono','SFMono-Regular',Consolas,ui-monospace,monospace;" +
      "font-size:12px;line-height:1.6;color:rgba(251,250,246,0.88);",
  );
  detail.appendChild(errorText);
  panel.appendChild(detail);

  const retryButton = document.createElement("button");
  retryButton.type = "button";
  retryButton.id = "hermes-bootstrap-retry";
  retryButton.setAttribute("style", `${buttonStyle}display:none;`);
  retryButton.textContent = "重试";
  retryButton.addEventListener("click", () => {
    if (retryButton.disabled) return;
    onRetry();
  });
  panel.appendChild(retryButton);

  const versionPanel = document.createElement("div");
  versionPanel.setAttribute(
    "style",
    "display:flex;flex-direction:column;align-items:center;gap:4px;margin-top:4px;" +
      "font-family:'JetBrains Mono','SFMono-Regular',Consolas,ui-monospace,monospace;" +
      "font-size:10px;line-height:1.45;letter-spacing:0.06em;color:rgba(133,126,111,0.76);",
  );

  const uiVersionRow = document.createElement("div");
  const versionLine = buildBootstrapVersionLine();
  uiVersionRow.setAttribute(
    "style",
    "font-variant-numeric:tabular-nums;white-space:nowrap;color:rgba(133,126,111,0.76);",
  );
  uiVersionRow.textContent = `${versionLine.label} ${versionLine.version} · ${versionLine.commit}`;
  versionPanel.append(uiVersionRow);
  panel.appendChild(versionPanel);

  const sub = document.createElement("div");
  sub.id = "hermes-bootstrap-sub";
  sub.setAttribute(
    "style",
    "font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;" +
      "color:rgba(255,255,255,0.45);letter-spacing:0.06em;",
  );
  sub.textContent = "AgentDeck · 启动中";
  panel.appendChild(sub);

  root.appendChild(panel);

  document.body.appendChild(root);

  const copyErrorMessage = async () => {
    if (!lastErrorMessage) return;
    try {
      await navigator.clipboard.writeText(lastErrorMessage);
      copyButton.textContent = "已复制";
      window.setTimeout(() => {
        copyButton.textContent = "复制错误信息";
      }, 1600);
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(errorText);
      selection?.removeAllRanges();
      selection?.addRange(range);
      copyButton.textContent = "已选中，可手动复制";
      window.setTimeout(() => {
        copyButton.textContent = "复制错误信息";
      }, 2200);
    }
  };

  copyButton.addEventListener("click", () => {
    void copyErrorMessage();
  });

  return {
    update(phase, msg) {
      if (phase === "error") {
        lastErrorMessage = msg || "未知启动错误";
        root.setAttribute("role", "alert");
        panel.setAttribute("aria-live", "assertive");
        message.textContent = "Agent 服务（Node sidecar）启动失败，可复制下方错误信息排查，或点击「重试」重新启动。";
        errorText.textContent = lastErrorMessage;
        detail.style.display = "block";
        copyButton.disabled = false;
        retryButton.style.display = "inline-block";
        retryButton.disabled = false;
        retryButton.textContent = "重试";
        sub.textContent = "启动失败";
      } else {
        root.removeAttribute("role");
        panel.setAttribute("aria-live", "polite");
        message.textContent = msg || initialMessage;
        detail.style.display = "none";
        retryButton.style.display = "none";
        sub.textContent = "AgentDeck · 启动中";
      }
    },
    dismiss() {
      root.remove();
    },
  };
}

const SIDECAR_STARTING_MESSAGE = "正在启动 Agent 服务…";
const OVERLAY_SHOW_DELAY_MS = 1200;
const SIDECAR_POLL_INTERVAL_MS = 1000;

export function isSidecarReady(status: SidecarStatusPayload | null | undefined): boolean {
  return status?.status === "ready" && Boolean(status.wsUrl);
}

/**
 * 阻塞到 sidecar 就绪：starting 超过 1.2 秒显示遮罩；failed / stopped 立即显示错误
 * 与「重试」按钮（调用 restart_sidecar）。首次拉起失败 Rust 不会自动重试，只能手动重启。
 */
async function waitForSidecarReady(initial: SidecarStatusPayload): Promise<void> {
  const { listen } = await import("@tauri-apps/api/event");

  return new Promise<void>((resolve) => {
    let overlay: BootstrapOverlay | null = null;
    let unlisten: (() => void) | null = null;
    let settled = false;
    let restarting = false;

    const retry = () => {
      if (restarting) return;
      restarting = true;
      ensureOverlay().update("starting", "正在重启 Agent 服务…");
      invokeCommand<SidecarStatusPayload>("restart_sidecar")
        .then((status) => handle(status))
        .catch((error) => {
          ensureOverlay().update("error", error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          restarting = false;
        });
    };

    const ensureOverlay = (): BootstrapOverlay => {
      if (!overlay) overlay = showBootstrapOverlay(SIDECAR_STARTING_MESSAGE, retry);
      return overlay;
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      safeUnlisten(unlisten);
      window.clearInterval(poll);
      window.clearTimeout(showTimer);
      overlay?.dismiss();
      resolve();
    };

    const handle = (status: SidecarStatusPayload) => {
      if (settled) return;
      if (isSidecarReady(status)) {
        finish();
        return;
      }
      if (status.status === "failed" || status.status === "stopped") {
        if (restarting) return;
        ensureOverlay().update("error", status.error || "Agent 服务未能启动");
      } else {
        overlay?.update("starting", restarting ? "正在重启 Agent 服务…" : SIDECAR_STARTING_MESSAGE);
      }
    };

    const showTimer = window.setTimeout(() => {
      if (!settled) ensureOverlay();
    }, OVERLAY_SHOW_DELAY_MS);
    const poll = window.setInterval(() => {
      if (restarting) return;
      void invokeCommand<SidecarStatusPayload>("get_sidecar_config").then(handle).catch(() => {});
    }, SIDECAR_POLL_INTERVAL_MS);

    listen<SidecarStatusPayload>("sidecar-status", (event) => handle(event.payload))
      .then((fn) => {
        if (settled) safeUnlisten(fn);
        else unlisten = fn;
      })
      .catch(() => {});

    handle(initial);
  });
}

// Developer mode ships enabled in release builds (the `devtools` Cargo feature),
// so the WebView inspector can be opened at runtime. Bind it to the keyboard
// shortcuts every browser already uses so users can pop devtools without a menu:
//   - F12                        (all platforms)
//   - Cmd + Option + I  on macOS
//   - Ctrl + Shift + I  on Windows / Linux
// The matching hint lives on the About page (web/src/routes/settings.tsx).
function isDevtoolsShortcut(event: KeyboardEvent): boolean {
  if (event.key === "F12") return true;
  if (event.key.toLowerCase() !== "i") return false;
  const macCombo = event.metaKey && event.altKey;
  const winCombo = event.ctrlKey && event.shiftKey;
  return macCombo || winCombo;
}

let devtoolsShortcutBound = false;

function registerDevtoolsShortcut(): void {
  if (devtoolsShortcutBound || typeof window === "undefined") return;
  if (typeof window.addEventListener !== "function") return;
  devtoolsShortcutBound = true;
  window.addEventListener(
    "keydown",
    (event) => {
      if (!isDevtoolsShortcut(event)) return;
      event.preventDefault();
      void invokeCommand("toggle_devtools").catch((error) => {
        console.warn("Failed to toggle devtools", error);
      });
    },
    // Capture phase so app-level key handlers can't swallow the shortcut first.
    { capture: true },
  );
}

export async function installTauriBridge(): Promise<void> {
  // Install before any React component mounts a Tauri event listener, so the
  // StrictMode mount→unmount teardown race can't leak an unhandled rejection.
  installTauriRejectionGuard();
  const windowControlsReady = resolveWindowControls();

  // Mount the bridge first so the fatal-error dialog and ui_store work while we
  // wait for the sidecar.
  (window as any).hermesDesktop = tauriBridge;

  const status = await invokeCommand<SidecarStatusPayload>("get_sidecar_config");
  if (!isSidecarReady(status)) {
    await waitForSidecarReady(status);
  }

  const windowControls = await windowControlsReady;
  if (windowControls && window.hermesDesktop) window.hermesDesktop.windowControls = windowControls;

  window.__HERMES_RUNTIME__ = { platform: "tauri" };

  registerDevtoolsShortcut();
}
