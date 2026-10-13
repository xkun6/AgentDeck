import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  arrayBufferToBase64,
  installTauriBridge,
  isSidecarReady,
  normalizeTauriInvokeError,
} from "./tauri-bridge";

const mockInvoke = vi.fn();
const mockListen = vi.fn();
const mockFileDropUnlisten = vi.fn();
let fileDropHandler: ((event: {
  payload: {
    type: "enter" | "over" | "drop" | "leave";
    paths?: string[];
    position?: { x: number; y: number };
  };
}) => void) | null = null;
const mockOnDragDropEvent = vi.fn((handler: NonNullable<typeof fileDropHandler>) => {
  fileDropHandler = handler;
  return Promise.resolve(mockFileDropUnlisten);
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mockListen,
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: mockOnDragDropEvent,
  }),
}));

const READY_STATUS = {
  wsUrl: "ws://127.0.0.1:43210/rpc",
  token: "token",
  version: "0.1.0",
  status: "ready",
  error: null,
};

beforeEach(() => {
  mockInvoke.mockReset();
  mockListen.mockReset();
  mockListen.mockResolvedValue(() => {});
  mockFileDropUnlisten.mockReset();
  mockOnDragDropEvent.mockClear();
  fileDropHandler = null;
  mockInvoke.mockImplementation((command: string, args?: unknown) => {
    if (command === "get_sidecar_config") return Promise.resolve(READY_STATUS);
    return Promise.resolve({ command, args });
  });
  (globalThis as any).window = {};
});

afterEach(() => {
  delete (globalThis as any).window;
});

describe("tauri bridge", () => {
  it("encodes large upload buffers in chunks", () => {
    const bytes = new Uint8Array(100_000);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = i % 256;
    }

    const decoded = Uint8Array.from(atob(arrayBufferToBase64(bytes.buffer)), (char) => char.charCodeAt(0));

    expect(decoded).toEqual(bytes);
  });

  it("sidecar 就绪时直接挂载并写入运行环境", async () => {
    await installTauriBridge();

    expect(mockInvoke).toHaveBeenCalledWith("get_sidecar_config", undefined);
    expect(mockInvoke).not.toHaveBeenCalledWith("get_runtime_config", expect.anything());
    expect(mockInvoke).not.toHaveBeenCalledWith("get_runtime_config", undefined);
    expect(mockInvoke).not.toHaveBeenCalledWith("runtime_info", undefined);
    expect(mockInvoke).not.toHaveBeenCalledWith("api_request", expect.anything());
    expect(mockListen).not.toHaveBeenCalledWith("runtime-status", expect.anything());
    expect(window.__AGENTDECK_RUNTIME__).toEqual({ platform: "tauri" });
    expect(window.agentdeckDesktop?.windowType).toBe("tauri");
  });

  it("isSidecarReady 只在 ready 且有 wsUrl 时为真", () => {
    expect(isSidecarReady(READY_STATUS as never)).toBe(true);
    expect(isSidecarReady({ ...READY_STATUS, status: "starting" } as never)).toBe(false);
    expect(isSidecarReady({ ...READY_STATUS, wsUrl: "" } as never)).toBe(false);
    expect(isSidecarReady(null)).toBe(false);
  });

  it("桥上只暴露 Rust 已注册的命令", async () => {
    await installTauriBridge();
    const bridge = window.agentdeckDesktop as Record<string, unknown>;
    for (const removed of ["request", "uploadFile", "getRuntimeInfo", "switchProfile", "readMemory", "getYoloMode"]) {
      expect(bridge[removed]).toBeUndefined();
    }
  });

  it("exposes log snapshot export through Tauri IPC", async () => {
    await installTauriBridge();

    await window.agentdeckDesktop?.exportLogSnapshot?.({
      fileName: "agentdeck-logs.log",
      content: "hello\n",
      format: "log",
    });

    expect(mockInvoke).toHaveBeenCalledWith("export_log_snapshot", {
      input: {
        fileName: "agentdeck-logs.log",
        content: "hello\n",
        format: "log",
      },
    });
  });

  it("exposes session file export through Tauri IPC", async () => {
    await installTauriBridge();

    await window.agentdeckDesktop?.exportSessionFile?.({
      fileName: "会话-20260102-0304",
      content: "# 会话\n",
      format: "markdown",
    });

    expect(mockInvoke).toHaveBeenCalledWith("export_session_file", {
      input: { fileName: "会话-20260102-0304", content: "# 会话\n", format: "markdown" },
    });
  });

  it("exposes debug panel commands through Tauri IPC", async () => {
    await installTauriBridge();

    await window.agentdeckDesktop?.logTail?.({ maxBytes: 1024 });
    await window.agentdeckDesktop?.debugPaths?.();
    await window.agentdeckDesktop?.exportDebugBundle?.({ diagnostics: "{}", frontendEvents: "" });

    expect(mockInvoke).toHaveBeenCalledWith("log_tail", { input: { maxBytes: 1024 } });
    expect(mockInvoke).toHaveBeenCalledWith("debug_paths", undefined);
    expect(mockInvoke).toHaveBeenCalledWith("export_debug_bundle", {
      input: { diagnostics: "{}", frontendEvents: "" },
    });
  });

  it("exposes external URL opening through Tauri IPC", async () => {
    await installTauriBridge();

    await window.agentdeckDesktop?.openExternalUrl?.({ url: "https://example.com" });

    expect(mockInvoke).toHaveBeenCalledWith("open_external_url", {
      input: { url: "https://example.com" },
    });
  });

  it("exposes external terminal opening through Tauri IPC", async () => {
    await installTauriBridge();

    await window.agentdeckDesktop?.terminalOpenExternal?.({ cwd: "C:/repo" });

    expect(mockInvoke).toHaveBeenCalledWith("terminal_open_external", {
      input: { cwd: "C:/repo" },
    });
  });

  it("exposes native Tauri file drop events through the desktop bridge", async () => {
    await installTauriBridge();

    const received: unknown[] = [];
    const unsubscribe = window.agentdeckDesktop?.onFileDrop?.((payload) => {
      received.push(payload);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockOnDragDropEvent).toHaveBeenCalledTimes(1);

    fileDropHandler?.({
      payload: { type: "enter", paths: ["/Users/alice/a.txt"], position: { x: 10, y: 20 } },
    });
    fileDropHandler?.({
      payload: { type: "over", position: { x: 11, y: 21 } },
    });
    fileDropHandler?.({
      payload: { type: "drop", paths: ["/Users/alice/a.txt"], position: { x: 12, y: 22 } },
    });
    fileDropHandler?.({
      payload: { type: "leave" },
    });

    expect(received).toEqual([
      { phase: "enter", paths: ["/Users/alice/a.txt"], position: { x: 10, y: 20 } },
      { phase: "over", paths: [], position: { x: 11, y: 21 } },
      { phase: "drop", paths: ["/Users/alice/a.txt"], position: { x: 12, y: 22 } },
      { phase: "leave", paths: [], position: undefined },
    ]);

    unsubscribe?.();
    expect(mockFileDropUnlisten).toHaveBeenCalledTimes(1);
  });

  it("normalizes structured Tauri IPC errors while preserving code and kind", () => {
    const error = normalizeTauriInvokeError({
      code: "not_ready",
      kind: "state",
      message: "Desktop runtime not ready",
      details: { phase: "starting" },
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Desktop runtime not ready");
    expect((error as any).code).toBe("not_ready");
    expect((error as any).kind).toBe("state");
    expect((error as any).details).toEqual({ phase: "starting" });
  });

  it("normalizes legacy string Tauri IPC errors", () => {
    const error = normalizeTauriInvokeError("Desktop runtime not ready");
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Desktop runtime not ready");
  });
});

describe("tauri bridge fs_list", () => {
  it("fsList 按仓库惯例把参数包在 input 里调 fs_list", async () => {
    await installTauriBridge();
    await window.agentdeckDesktop?.fsList?.({ path: "", showHidden: false });
    expect(mockInvoke).toHaveBeenCalledWith("fs_list", { input: { path: "", showHidden: false } });
  });
});
