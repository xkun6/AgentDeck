// @vitest-environment jsdom
// 后台本地通知：attention 在前台 / 后台 / 当前会话三种状态下的路由、id 去重、按 kind 分 channel、权限处理、点击跳转。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { AttentionNotice } from "@agentdeck/protocol";
import { AttentionBanner, useAttentionNotice } from "./attention-banner";
import { decideAttention, setBackgroundAttentionHandler, setResolvedAttentionHandler } from "./attention";
import { BackgroundNotifier, notificationIdFor, notificationIdOf, type NotifierDeps } from "./native/local-notifications";
import { setNativeBackend, type AttentionNotification } from "./native/native-plugin";
import { routeOfClickTarget, useNotificationClicks } from "./native/use-notification-clicks";
import type { NotifyMode } from "./preferences";
import type { MobileRoute } from "./route";

afterEach(() => {
  cleanup();
  setBackgroundAttentionHandler(null);
  setResolvedAttentionHandler(null);
  setNativeBackend(null);
});

function notice(overrides: Partial<AttentionNotice> = {}): AttentionNotice {
  return { id: "n1", kind: "finished", agentId: "a1", title: "重构登录", body: "本轮已完成", timestamp: 1, ...overrides };
}

function fakeDeps(enabled: boolean | null = true) {
  const deps = {
    enabled: vi.fn(async () => enabled),
    request: vi.fn(async () => "granted" as const),
    show: vi.fn(async (_notification: AttentionNotification) => true),
    cancel: vi.fn(async (_id: number) => true),
  } satisfies NotifierDeps;
  return deps;
}

describe("decideAttention 前台 / 后台 / 当前会话", () => {
  it("后台一律走本地通知（即使停在该会话）；前台在该会话忽略；前台其它页面弹条", () => {
    const inSession: MobileRoute = { name: "session", agentId: "a1" };
    const elsewhere: MobileRoute = { name: "sessions" };
    expect(decideAttention(notice(), inSession, false)).toBe("background");
    expect(decideAttention(notice(), elsewhere, false)).toBe("background");
    expect(decideAttention(notice(), inSession, true)).toBe("ignore");
    expect(decideAttention(notice(), { name: "session", agentId: "other" }, true)).toBe("banner");
    expect(decideAttention(notice({ agentId: undefined, kind: "schedule" }), inSession, true)).toBe("banner");
  });
});

describe("通知档位 × 前台 / 后台 / 当前会话", () => {
  const inSession: MobileRoute = { name: "session", agentId: "a1" };
  const elsewhere: MobileRoute = { name: "sessions" };

  it("always：后台本地通知；前台当前会话忽略、其它页面弹条", () => {
    expect(decideAttention(notice(), elsewhere, false, "always")).toBe("background");
    expect(decideAttention(notice(), inSession, true, "always")).toBe("ignore");
    expect(decideAttention(notice(), elsewhere, true, "always")).toBe("banner");
  });

  it("foreground：后台不通知；前台规则同 always", () => {
    expect(decideAttention(notice(), elsewhere, false, "foreground")).toBe("ignore");
    expect(decideAttention(notice(), inSession, false, "foreground")).toBe("ignore");
    expect(decideAttention(notice(), inSession, true, "foreground")).toBe("ignore");
    expect(decideAttention(notice(), elsewhere, true, "foreground")).toBe("banner");
  });

  it("never：任何状态都不提醒", () => {
    for (const foreground of [true, false]) {
      for (const route of [inSession, elsewhere]) {
        expect(decideAttention(notice(), route, foreground, "never")).toBe("ignore");
      }
    }
  });

  it("useAttentionNotice 实时读取档位：切换后立即生效，无需重新订阅", () => {
    const handler = vi.fn();
    setBackgroundAttentionHandler(handler);
    let mode: NotifyMode = "always";
    let listener: ((n: AttentionNotice) => void) | null = null;
    const client = {
      onAttention: (l: (n: AttentionNotice) => void) => {
        listener = l;
        return () => {};
      },
    };
    function Probe({ foreground }: { foreground: boolean }) {
      const [current] = useAttentionNotice(client, elsewhere, () => foreground, () => mode);
      return <div>{current ? "有提示" : "无提示"}</div>;
    }
    const { rerender } = render(<Probe foreground={false} />);
    act(() => listener!(notice({ id: "m1" })));
    expect(handler).toHaveBeenCalledTimes(1);
    mode = "foreground";
    act(() => listener!(notice({ id: "m2" })));
    expect(handler).toHaveBeenCalledTimes(1);
    mode = "never";
    rerender(<Probe foreground />);
    act(() => listener!(notice({ id: "m3" })));
    expect(screen.getByText("无提示")).toBeTruthy();
    mode = "foreground";
    act(() => listener!(notice({ id: "m4" })));
    expect(screen.getByText("有提示")).toBeTruthy();
  });
});

describe("resolved 撤回信号（useAttentionNotice）", () => {
  const elsewhere: MobileRoute = { name: "sessions" };

  function setup(foreground: boolean, mode: NotifyMode = "always") {
    let listener: ((n: AttentionNotice) => void) | null = null;
    const client = {
      onAttention: (l: (n: AttentionNotice) => void) => {
        listener = l;
        return () => {};
      },
    };
    function Probe() {
      const [current] = useAttentionNotice(client, elsewhere, () => foreground, () => mode);
      return <div>{current ? `提示:${current.requestId}` : "无提示"}</div>;
    }
    render(<Probe />);
    return (n: AttentionNotice) => act(() => listener!(n));
  }

  it("收到撤回：调用取消处理器，并关掉同一条审批的应用内提示条", () => {
    const cancel = vi.fn();
    setResolvedAttentionHandler(cancel);
    const emit = setup(true);
    emit(notice({ id: "p1", kind: "permission", requestId: "r1" }));
    expect(screen.getByText("提示:r1")).toBeTruthy();
    // 其它审批的撤回不影响当前提示条，但仍会取消对应系统通知
    emit(notice({ id: "x1", kind: "resolved", requestId: "other" }));
    expect(screen.getByText("提示:r1")).toBeTruthy();
    emit(notice({ id: "x2", kind: "resolved", requestId: "r1" }));
    expect(screen.getByText("无提示")).toBeTruthy();
    expect(cancel.mock.calls.map(([n]) => n.requestId)).toEqual(["other", "r1"]);
  });

  it("撤回不受通知档位影响（never 也取消），且不进入后台通知通道", () => {
    const cancel = vi.fn();
    const background = vi.fn();
    setResolvedAttentionHandler(cancel);
    setBackgroundAttentionHandler(background);
    const emit = setup(false, "never");
    emit(notice({ id: "x1", kind: "resolved", requestId: "r1" }));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(background).not.toHaveBeenCalled();
  });
});

describe("BackgroundNotifier", () => {
  it("按 kind 传给原生（决定 channel），带 agentId 与稳定的通知 id", async () => {
    const deps = fakeDeps();
    const notifier = new BackgroundNotifier(deps);
    await notifier.notify(notice({ id: "p1", kind: "permission", title: "T", body: "Agent 请求审批：运行命令" }));
    await notifier.notify(notice({ id: "f1", kind: "failed" }));
    await notifier.notify(notice({ id: "s1", kind: "schedule", agentId: undefined }));
    expect(deps.show.mock.calls.map(([n]) => [n.kind, n.agentId, n.id])).toEqual([
      ["permission", "a1", notificationIdOf("p1")],
      ["failed", "a1", notificationIdOf("f1")],
      ["schedule", undefined, notificationIdOf("s1")],
    ]);
    expect(deps.show.mock.calls[0]![0]).toMatchObject({ title: "T", body: "Agent 请求审批：运行命令" });
    expect(notificationIdOf("p1")).toBe(notificationIdOf("p1"));
    expect(notificationIdOf("p1")).not.toBe(notificationIdOf("p2"));
  });

  it("审批通知的系统 id 按 agentId + requestId 算：resolved 撤回与原通知指向同一条", async () => {
    const permission = notice({ id: "n-perm", kind: "permission", requestId: "r1" });
    const resolved = notice({ id: "n-res", kind: "resolved", requestId: "r1" });
    expect(notificationIdFor(permission)).toBe(notificationIdFor(resolved));
    expect(notificationIdFor(permission)).not.toBe(notificationIdOf("n-perm"));
    expect(notificationIdFor(permission)).not.toBe(notificationIdFor(notice({ kind: "permission", requestId: "r2" })));
    expect(notificationIdFor(permission)).not.toBe(notificationIdFor({ ...permission, agentId: "a2" }));
    // 没有 requestId 的通知（完成 / 失败 / 调度）仍按自身 id
    expect(notificationIdFor(notice({ id: "f1" }))).toBe(notificationIdOf("f1"));

    const deps = fakeDeps();
    const notifier = new BackgroundNotifier(deps);
    await notifier.notify(permission);
    await notifier.cancel(resolved);
    expect(deps.cancel).toHaveBeenCalledWith(deps.show.mock.calls[0]![0].id);
  });

  it("撤回信号本身不弹通知；撤回先于异步发出的通知到达时，该通知不再发出", async () => {
    const deps = fakeDeps();
    const notifier = new BackgroundNotifier(deps);
    expect(await notifier.notify(notice({ id: "n-res", kind: "resolved", requestId: "r1" }))).toBe(false);
    expect(deps.show).not.toHaveBeenCalled();

    let releaseEnabled: (value: boolean) => void = () => {};
    deps.enabled.mockImplementationOnce(() => new Promise<boolean>((resolve) => (releaseEnabled = resolve)));
    const pending = notifier.notify(notice({ id: "n-perm", kind: "permission", requestId: "r9" }));
    await notifier.cancel(notice({ id: "n-res2", kind: "resolved", requestId: "r9" }));
    releaseEnabled(true);
    expect(await pending).toBe(false);
    expect(deps.show).not.toHaveBeenCalled();
  });

  it("同一个 id 只通知一次", async () => {
    const deps = fakeDeps();
    const notifier = new BackgroundNotifier(deps);
    expect(await notifier.notify(notice({ id: "dup" }))).toBe(true);
    expect(await notifier.notify(notice({ id: "dup" }))).toBe(false);
    expect(deps.show).toHaveBeenCalledTimes(1);
  });

  it("通知权限没开（或环境不支持）时不发；后台不会去申请权限", async () => {
    const off = fakeDeps(false);
    await new BackgroundNotifier(off).notify(notice());
    expect(off.show).not.toHaveBeenCalled();
    expect(off.request).not.toHaveBeenCalled();

    const unsupported = fakeDeps(null);
    await new BackgroundNotifier(unsupported).notify(notice());
    expect(unsupported.show).not.toHaveBeenCalled();
  });

  it("ensurePermission：未开启时只在前台问一次；已开启 / 不支持时不问", async () => {
    const off = fakeDeps(false);
    const notifier = new BackgroundNotifier(off);
    await notifier.ensurePermission();
    await notifier.ensurePermission();
    expect(off.request).toHaveBeenCalledTimes(1);

    const on = fakeDeps(true);
    await new BackgroundNotifier(on).ensurePermission();
    expect(on.request).not.toHaveBeenCalled();
    const none = fakeDeps(null);
    await new BackgroundNotifier(none).ensurePermission();
    expect(none.request).not.toHaveBeenCalled();
  });
});

describe("useAttentionNotice 与后台处理器联动", () => {
  function fakeClient() {
    let listener: ((n: AttentionNotice) => void) | null = null;
    return {
      client: {
        onAttention: (l: (n: AttentionNotice) => void) => {
          listener = l;
          return () => {
            listener = null;
          };
        },
      },
      emit: (n: AttentionNotice) => act(() => listener?.(n)),
    };
  }

  function Harness({ client, route, foreground }: { client: ReturnType<typeof fakeClient>["client"]; route: MobileRoute; foreground: boolean }) {
    const [current, dismiss] = useAttentionNotice(client, route, () => foreground);
    return current ? <AttentionBanner notice={current} onOpen={() => {}} onDismiss={dismiss} /> : <div>无提示</div>;
  }

  it("提示条标签按 permissionKind 区分：question 待回答 / plan 待确认计划 / 其余待审批", () => {
    const { client, emit } = fakeClient();
    render(<Harness client={client} route={{ name: "sessions" }} foreground />);
    emit(notice({ id: "k1", kind: "permission", permissionKind: "question" }));
    expect(screen.getByRole("status").textContent).toContain("重构登录 · 待回答");
    emit(notice({ id: "k2", kind: "permission", permissionKind: "plan" }));
    expect(screen.getByRole("status").textContent).toContain("待确认计划");
    emit(notice({ id: "k3", kind: "permission", permissionKind: "tool" }));
    expect(screen.getByRole("status").textContent).toContain("待审批");
    emit(notice({ id: "k4", kind: "permission" }));
    expect(screen.getByRole("status").textContent).toContain("待审批");
    emit(notice({ id: "k5", kind: "failed" }));
    expect(screen.getByRole("status").textContent).toContain("失败");
  });

  it("后台：交给本地通知处理器且不弹条；同一 id 只交一次", () => {
    const handler = vi.fn();
    setBackgroundAttentionHandler(handler);
    const { client, emit } = fakeClient();
    render(<Harness client={client} route={{ name: "session", agentId: "a1" }} foreground={false} />);
    emit(notice({ id: "b1" }));
    emit(notice({ id: "b1" }));
    emit(notice({ id: "b2", kind: "permission" }));
    expect(handler.mock.calls.map(([n]) => n.id)).toEqual(["b1", "b2"]);
    expect(screen.getByText("无提示")).toBeTruthy();
  });

  it("前台：当前会话忽略、其它页面弹条，都不触发本地通知", () => {
    const handler = vi.fn();
    setBackgroundAttentionHandler(handler);
    const { client, emit } = fakeClient();
    const { rerender } = render(<Harness client={client} route={{ name: "session", agentId: "a1" }} foreground />);
    emit(notice({ id: "f1" }));
    expect(screen.getByText("无提示")).toBeTruthy();
    rerender(<Harness client={client} route={{ name: "sessions" }} foreground />);
    emit(notice({ id: "f2" }));
    expect(screen.getByRole("status")).toBeTruthy();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("点击通知跳转会话", () => {
  it("目标转路由：有 agentId 去会话，调度类去会话列表", () => {
    expect(routeOfClickTarget({ agentId: "a1" })).toEqual({ name: "session", agentId: "a1" });
    expect(routeOfClickTarget({})).toEqual({ name: "sessions" });
  });

  it("运行时点击与冷启动目标都会导航；卸载后取消订阅", async () => {
    let clickHandler: ((payload: unknown) => void) | null = null;
    const unlisten = vi.fn();
    setNativeBackend({
      invoke: async (command) => (command === "take_launch_target" ? { target: { agentId: "cold" } } : null),
      listen: async (_event, handler) => {
        clickHandler = handler;
        return unlisten;
      },
    });
    const navigate = vi.fn();
    function Probe() {
      useNotificationClicks(navigate);
      return null;
    }
    const { unmount } = render(<Probe />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(navigate).toHaveBeenCalledWith({ name: "session", agentId: "cold" });
    act(() => clickHandler!({ agentId: "a2" }));
    expect(navigate).toHaveBeenLastCalledWith({ name: "session", agentId: "a2" });
    act(() => clickHandler!({}));
    expect(navigate).toHaveBeenLastCalledWith({ name: "sessions" });
    unmount();
    expect(unlisten).toHaveBeenCalled();
  });
});
