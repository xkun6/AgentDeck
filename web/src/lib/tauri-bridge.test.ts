import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  arrayBufferToBase64,
  installTauriBridge,
  isSidecarReady,
  normalizeTauriInvokeError,
} from "./tauri-bridge";
import { AGENTDECK_UNSUPPORTED_MESSAGE } from "./agentdeck-unsupported";

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

  it("sidecar 就绪时直接挂载，运行时标记为无 Hermes 后端", async () => {
    await installTauriBridge();

    expect(mockInvoke).toHaveBeenCalledWith("get_sidecar_config", undefined);
    expect(mockInvoke).not.toHaveBeenCalledWith("get_runtime_config", expect.anything());
    expect(mockInvoke).not.toHaveBeenCalledWith("get_runtime_config", undefined);
    expect(mockInvoke).not.toHaveBeenCalledWith("runtime_info", undefined);
    expect(mockInvoke).not.toHaveBeenCalledWith("api_request", expect.anything());
    expect(mockListen).not.toHaveBeenCalledWith("runtime-status", expect.anything());
    expect(window.__HERMES_RUNTIME__).toMatchObject({
      platform: "tauri",
      backendReady: true,
      hermesBackendDisabled: true,
    });
    expect(window.hermesDesktop?.windowType).toBe("tauri");
  });

  it("isSidecarReady 只在 ready 且有 wsUrl 时为真", () => {
    expect(isSidecarReady(READY_STATUS as never)).toBe(true);
    expect(isSidecarReady({ ...READY_STATUS, status: "starting" } as never)).toBe(false);
    expect(isSidecarReady({ ...READY_STATUS, wsUrl: "" } as never)).toBe(false);
    expect(isSidecarReady(null)).toBe(false);
  });

  it("已删除的 Hermes 命令统一返回「暂不支持」", async () => {
    await installTauriBridge();
    const bridge = window.hermesDesktop!;
    const calls: Array<Promise<unknown> | undefined> = [
      bridge.request({ path: "/api/version" }),
      bridge.scanConfigMigration?.({ manualPath: "/Users/alice/.hermes" }),
      bridge.exportDebugBundle?.({ frontendDebug: [] }),
      bridge.checkDesktopUpdate?.(),
      bridge.exportProfileBackup?.(),
      bridge.getRuntimeInfo?.(),
      bridge.refreshGatewayUrl?.(),
      bridge.getDesktopControlState?.(),
      bridge.installManagedRuntime?.(),
      bridge.readMemory?.(),
      bridge.getYoloMode?.(),
    ];
    for (const call of calls) {
      await expect(call).rejects.toThrow(AGENTDECK_UNSUPPORTED_MESSAGE);
    }
    const invokedCommands = mockInvoke.mock.calls.map(([command]) => command);
    expect(invokedCommands).toEqual(["get_sidecar_config"]);
  });

  it("已删除事件的订阅不注册监听", async () => {
    await installTauriBridge();
    const unsubscribe = window.hermesDesktop?.onUiUpdateReady?.(() => {});
    const unsubscribeProgress = window.hermesDesktop?.onAppUpdateProgress?.(() => {});
    expect(typeof unsubscribe).toBe("function");
    expect(typeof unsubscribeProgress).toBe("function");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockListen).not.toHaveBeenCalledWith("ui-update-ready", expect.anything());
    expect(mockListen).not.toHaveBeenCalledWith("app-update-progress", expect.anything());
  });

  it("exposes log snapshot export through Tauri IPC", async () => {
    await installTauriBridge();

    await window.hermesDesktop?.exportLogSnapshot?.({
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

  it("exposes session JSON export through Tauri IPC", async () => {
    await installTauriBridge();

    await window.hermesDesktop?.exportSessionJson?.({
      fileName: "session-abc.json",
      content: "{\n  \"id\": \"abc\"\n}\n",
    });

    expect(mockInvoke).toHaveBeenCalledWith("export_session_json", {
      input: {
        fileName: "session-abc.json",
        content: "{\n  \"id\": \"abc\"\n}\n",
      },
    });
  });

  it("exposes external URL opening through Tauri IPC", async () => {
    await installTauriBridge();

    await window.hermesDesktop?.openExternalUrl?.({ url: "https://example.com" });

    expect(mockInvoke).toHaveBeenCalledWith("open_external_url", {
      input: { url: "https://example.com" },
    });
  });

  it("exposes external terminal opening through Tauri IPC", async () => {
    await installTauriBridge();

    await window.hermesDesktop?.terminalOpenExternal?.({ purpose: "shell" });

    expect(mockInvoke).toHaveBeenCalledWith("terminal_open_external", {
      input: { purpose: "shell" },
    });
  });

  it("exposes native Tauri file drop events through the desktop bridge", async () => {
    await installTauriBridge();

    const received: unknown[] = [];
    const unsubscribe = window.hermesDesktop?.onFileDrop?.((payload) => {
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
