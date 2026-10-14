// @vitest-environment jsdom
// 各入口可替换的桌面依赖：通知出口、ui-store 后端。默认（桌面）行为不变，手机入口显式关闭 / 改用 localStorage。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduleNotice } from "@agentdeck/protocol";
import { configureNotifier, notifyFromSchedule } from "./notifications";
import {
  __resetUiStoreForTests,
  configureUiStoreBackend,
  readUiValue,
  writeUiValue,
} from "./ui-store";

const notice: ScheduleNotice = { scheduleId: "s1", name: "夜间巡检", kind: "failed", message: "超时" };

beforeEach(() => {
  __resetUiStoreForTests();
});

afterEach(() => {
  configureNotifier(undefined);
  configureUiStoreBackend("desktop");
  delete (window as { agentdeckDesktop?: unknown }).agentdeckDesktop;
  localStorage.clear();
});

describe("configureNotifier", () => {
  it("默认走桌面桥 desktopNotify（桌面行为不变）", () => {
    const desktopNotify = vi.fn().mockResolvedValue({ delivered: true, focused: false, attentionRequested: true });
    (window as { agentdeckDesktop?: unknown }).agentdeckDesktop = { windowType: "tauri", desktopNotify };
    notifyFromSchedule(notice);
    expect(desktopNotify).toHaveBeenCalledTimes(1);
    expect(desktopNotify.mock.calls[0]![0]).toMatchObject({ kind: "error", title: "自动化任务失败" });
  });

  it("入口传 null：即使存在桌面桥也不发通知（手机入口）", () => {
    const desktopNotify = vi.fn();
    (window as { agentdeckDesktop?: unknown }).agentdeckDesktop = { windowType: "tauri", desktopNotify };
    configureNotifier(null);
    notifyFromSchedule(notice);
    expect(desktopNotify).not.toHaveBeenCalled();
  });

  it("入口传自定义出口（M3 的本地通知）：收到同样的载荷", () => {
    const custom = vi.fn().mockResolvedValue(undefined);
    configureNotifier(custom);
    notifyFromSchedule(notice);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(custom.mock.calls[0]![0]).toMatchObject({ kind: "error", body: expect.stringContaining("夜间巡检") });
  });

  it("没有桌面桥也没有注入：静默忽略", () => {
    expect(() => notifyFromSchedule(notice)).not.toThrow();
  });
});

describe("configureUiStoreBackend", () => {
  it("local-storage 后端：写 localStorage，不碰桌面桥", () => {
    const uiStoreSetKv = vi.fn().mockResolvedValue(true);
    (window as { agentdeckDesktop?: unknown }).agentdeckDesktop = { windowType: "tauri", uiStoreSetKv };
    configureUiStoreBackend("local-storage");
    writeUiValue("k", { a: 1 });
    expect(uiStoreSetKv).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem("agentdeck_ui_backup")!)).toEqual({ k: { a: 1 } });
    expect(readUiValue("k", null)).toEqual({ a: 1 });
  });

  it("默认（desktop）后端：有桥时写桥，不写 localStorage", () => {
    const uiStoreSetKv = vi.fn().mockResolvedValue(true);
    (window as { agentdeckDesktop?: unknown }).agentdeckDesktop = { windowType: "tauri", uiStoreSetKv };
    writeUiValue("k", 1);
    expect(uiStoreSetKv).toHaveBeenCalledWith({ key: "k", value: 1 });
    expect(localStorage.getItem("agentdeck_ui_backup")).toBeNull();
  });
});
