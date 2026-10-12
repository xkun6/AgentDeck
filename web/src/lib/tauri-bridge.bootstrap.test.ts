// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn();
let statusHandler: ((event: { payload: unknown }) => void) | null = null;
const mockListen = vi.fn((event: string, handler: (event: { payload: unknown }) => void) => {
  if (event === "sidecar-status") statusHandler = handler;
  return Promise.resolve(() => {});
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mockListen }));

import { installTauriBridge } from "./tauri-bridge";

const FAILED = {
  wsUrl: "",
  token: "t",
  version: null,
  status: "failed",
  error: "找不到 node 可执行文件",
};
const STARTING = { ...FAILED, status: "starting", error: null };
const READY = { wsUrl: "ws://127.0.0.1:5555/rpc", token: "t2", version: "0.1.0", status: "ready", error: null };

async function flush(times = 5) {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

beforeEach(() => {
  mockInvoke.mockReset();
  mockListen.mockClear();
  statusHandler = null;
  delete window.__HERMES_RUNTIME__;
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.useRealTimers();
});

describe("installTauriBridge 启动遮罩", () => {
  it("启动失败时展示错误与重试，重试成功后挂载", async () => {
    let restarted = false;
    mockInvoke.mockImplementation((command: string) => {
      if (command === "get_sidecar_config") return Promise.resolve(restarted ? READY : FAILED);
      if (command === "restart_sidecar") {
        restarted = true;
        return Promise.resolve(READY);
      }
      return Promise.resolve(null);
    });

    let done = false;
    const installing = installTauriBridge().then(() => {
      done = true;
    });
    await flush(10);

    const overlay = document.getElementById("hermes-bootstrap-overlay");
    expect(overlay).not.toBeNull();
    expect(document.getElementById("hermes-bootstrap-error-text")?.textContent).toContain("找不到 node 可执行文件");
    const retry = document.getElementById("hermes-bootstrap-retry") as HTMLButtonElement;
    expect(retry.style.display).not.toBe("none");
    expect(done).toBe(false);

    retry.click();
    await installing;

    expect(mockInvoke).toHaveBeenCalledWith("restart_sidecar", undefined);
    expect(document.getElementById("hermes-bootstrap-overlay")).toBeNull();
    expect(window.__HERMES_RUNTIME__).toMatchObject({ platform: "tauri" });
  });

  it("starting 状态等待 sidecar-status 的 ready 事件", async () => {
    mockInvoke.mockImplementation((command: string) => {
      if (command === "get_sidecar_config") return Promise.resolve(STARTING);
      return Promise.resolve(null);
    });

    let done = false;
    const installing = installTauriBridge().then(() => {
      done = true;
    });
    await flush(10);
    expect(done).toBe(false);
    expect(statusHandler).not.toBeNull();

    statusHandler?.({ payload: READY });
    await installing;
    expect(done).toBe(true);
    expect(mockListen).not.toHaveBeenCalledWith("runtime-status", expect.anything());
  });
});
