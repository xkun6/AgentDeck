import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStreamEnvelope, AgentStreamEvent, AgentUIMessage } from "@agentdeck/protocol";
import type { ChatSessionRuntime } from "@/stores/chat";
import type { NotificationSettings } from "@/stores/ui";

async function loadNotifications(seed: Record<string, unknown> = {}) {
  vi.resetModules();
  const uiStore = await import("@/lib/ui-store");
  uiStore.__resetUiStoreForTests(seed);
  const mod = await import("./notifications");
  return { ...mod, uiStore };
}

function settings(overrides: Partial<NotificationSettings> = {}): NotificationSettings {
  return {
    system: true,
    sound: true,
    onComplete: true,
    onApproval: true,
    onlyBackground: true,
    ...overrides,
  };
}

function runtimeWith(partial: Partial<ChatSessionRuntime> = {}): ChatSessionRuntime {
  return {
    messages: [],
    streamStatus: "streaming",
    pendingApprovals: [],
    statusMessage: "",
    updatedAt: 0,
    ...partial,
  };
}

function userMessage(text: string): AgentUIMessage {
  return {
    id: "u1",
    sessionId: "s1",
    role: "user",
    createdAt: 0,
    status: "complete",
    parts: [{ type: "text", text }],
  } as AgentUIMessage;
}

function envelopeOf(event: AgentStreamEvent, agentId = "s1"): AgentStreamEnvelope {
  return { agentId, seq: 1, epoch: "e1", timestamp: 0, event };
}

function approvalEvent(
  request: { id?: string; title?: string; name?: string } = { id: "r1", title: "rm -rf build" },
  agentId = "s1",
): AgentStreamEnvelope {
  return envelopeOf(
    {
      type: "permission_requested",
      request: { id: "", provider: "claude", name: "", kind: "tool", ...request },
    } as AgentStreamEvent,
    agentId,
  );
}

function completeEvent(agentId = "s1"): AgentStreamEnvelope {
  return envelopeOf({ type: "turn_completed", turnId: "t1" }, agentId);
}

function failedEvent(error: string): AgentStreamEnvelope {
  return envelopeOf({ type: "turn_failed", turnId: "t1", error });
}

const never = () => false;

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  delete (globalThis as any).window;
  vi.unstubAllGlobals();
});

describe("decideNotification — permission_requested", () => {
  it("produces an approval action with command body and a stable dedupe key", async () => {
    const { decideNotification } = await loadNotifications();
    const action = decideNotification({
      envelope: approvalEvent(),
      prevRuntime: runtimeWith(),
      settings: settings(),
      alreadyNotified: never,
    });
    expect(action).toEqual({
      dedupeKey: "approval:s1:r1",
      kind: "approval",
      title: "需要权限确认",
      body: "rm -rf build",
    });
  });

  it("falls back from title to tool name to a default body", async () => {
    const { decideNotification } = await loadNotifications();
    const byName = decideNotification({
      envelope: approvalEvent({ id: "r1", name: "Write" }),
      prevRuntime: runtimeWith(),
      settings: settings(),
      alreadyNotified: never,
    });
    expect(byName?.body).toBe("Write");

    const byDefault = decideNotification({
      envelope: approvalEvent({ id: "r1" }),
      prevRuntime: runtimeWith(),
      settings: settings(),
      alreadyNotified: never,
    });
    expect(byDefault?.body).toBe("需要确认操作");
  });

  it("returns null when the approval toggle is off", async () => {
    const { decideNotification } = await loadNotifications();
    expect(
      decideNotification({
        envelope: approvalEvent(),
        prevRuntime: runtimeWith(),
        settings: settings({ onApproval: false }),
        alreadyNotified: never,
      }),
    ).toBeNull();
  });

  it("returns null when both system notification and sound are off", async () => {
    const { decideNotification } = await loadNotifications();
    expect(
      decideNotification({
        envelope: approvalEvent(),
        prevRuntime: runtimeWith(),
        settings: settings({ system: false, sound: false }),
        alreadyNotified: never,
      }),
    ).toBeNull();
  });

  it("returns null without a request id (cannot dedupe replays)", async () => {
    const { decideNotification } = await loadNotifications();
    expect(
      decideNotification({
        envelope: approvalEvent({ title: "rm -rf build" }),
        prevRuntime: runtimeWith(),
        settings: settings(),
        alreadyNotified: never,
      }),
    ).toBeNull();
  });

  it("returns null when the approval is already pending in the previous runtime", async () => {
    const { decideNotification } = await loadNotifications();
    expect(
      decideNotification({
        envelope: approvalEvent(),
        prevRuntime: runtimeWith({
          pendingApprovals: [{ requestId: "r1", sessionId: "s1", command: "rm -rf build" }],
        }),
        settings: settings(),
        alreadyNotified: never,
      }),
    ).toBeNull();
  });

  it("returns null when the dedupe key was already notified", async () => {
    const { decideNotification } = await loadNotifications();
    expect(
      decideNotification({
        envelope: approvalEvent(),
        prevRuntime: runtimeWith(),
        settings: settings(),
        alreadyNotified: (key) => key === "approval:s1:r1",
      }),
    ).toBeNull();
  });

  it("truncates an overlong command body", async () => {
    const { decideNotification } = await loadNotifications();
    const action = decideNotification({
      envelope: approvalEvent({ id: "r1", title: "x".repeat(500) }),
      prevRuntime: runtimeWith(),
      settings: settings(),
      alreadyNotified: never,
    });
    expect(action?.body.length).toBeLessThanOrEqual(120);
    expect(action?.body.endsWith("…")).toBe(true);
  });

  it("does not split surrogate pairs when truncating", async () => {
    const { decideNotification } = await loadNotifications();
    const action = decideNotification({
      envelope: approvalEvent({ id: "r1", title: "🚀".repeat(200) }),
      prevRuntime: runtimeWith(),
      settings: settings(),
      alreadyNotified: never,
    });
    const body = action?.body ?? "";
    expect(body.endsWith("…")).toBe(true);
    expect(Array.from(body).length).toBeLessThanOrEqual(120);
    // 截断点不能落在代理对中间产生孤立代理字符。
    expect(body).toMatch(/^(?:🚀)+…$/u);
  });
});

describe("decideNotification — turn_completed / turn_failed", () => {
  it("produces a complete action summarizing the latest user prompt", async () => {
    const { decideNotification } = await loadNotifications();
    const action = decideNotification({
      envelope: completeEvent(),
      prevRuntime: runtimeWith({
        activeAssistantId: "agent-turn-t1",
        messages: [userMessage("帮我重构登录模块")],
      }),
      settings: settings(),
      alreadyNotified: never,
    });
    expect(action).toEqual({
      dedupeKey: "complete:s1:t1",
      kind: "complete",
      title: "任务完成",
      body: "帮我重构登录模块",
    });
  });

  it("falls back to a default body without a user prompt", async () => {
    const { decideNotification } = await loadNotifications();
    const action = decideNotification({
      envelope: completeEvent(),
      prevRuntime: runtimeWith({ activeAssistantId: "agent-turn-t1" }),
      settings: settings(),
      alreadyNotified: never,
    });
    expect(action?.body).toBe("会话回复已就绪");
  });

  it("maps turn_failed to an error action carrying the error text", async () => {
    const { decideNotification } = await loadNotifications();
    const action = decideNotification({
      envelope: failedEvent("API Key 已失效"),
      prevRuntime: runtimeWith({ activeAssistantId: "agent-turn-t1" }),
      settings: settings(),
      alreadyNotified: never,
    });
    expect(action?.kind).toBe("error");
    expect(action?.title).toBe("任务出错");
    expect(action?.body).toBe("API Key 已失效");
  });

  it("returns null without an active assistant turn (replay protection)", async () => {
    const { decideNotification } = await loadNotifications();
    expect(
      decideNotification({
        envelope: completeEvent(),
        prevRuntime: runtimeWith(),
        settings: settings(),
        alreadyNotified: never,
      }),
    ).toBeNull();
    expect(
      decideNotification({
        envelope: completeEvent(),
        prevRuntime: undefined,
        settings: settings(),
        alreadyNotified: never,
      }),
    ).toBeNull();
  });

  it("returns null after a manual interrupt", async () => {
    const { decideNotification } = await loadNotifications();
    expect(
      decideNotification({
        envelope: completeEvent(),
        prevRuntime: runtimeWith({ activeAssistantId: "agent-turn-t1", interrupted: true }),
        settings: settings(),
        alreadyNotified: never,
      }),
    ).toBeNull();
  });

  it("returns null when the complete toggle is off", async () => {
    const { decideNotification } = await loadNotifications();
    expect(
      decideNotification({
        envelope: completeEvent(),
        prevRuntime: runtimeWith({ activeAssistantId: "agent-turn-t1" }),
        settings: settings({ onComplete: false }),
        alreadyNotified: never,
      }),
    ).toBeNull();
  });
});

describe("decideNotification — other events", () => {
  it("ignores unrelated event types and missing agent ids", async () => {
    const { decideNotification } = await loadNotifications();
    expect(
      decideNotification({
        envelope: envelopeOf({ type: "turn_started", turnId: "t1" }),
        prevRuntime: runtimeWith({ activeAssistantId: "a" }),
        settings: settings(),
        alreadyNotified: never,
      }),
    ).toBeNull();
    expect(
      decideNotification({
        envelope: approvalEvent(undefined, ""),
        prevRuntime: runtimeWith(),
        settings: settings(),
        alreadyNotified: never,
      }),
    ).toBeNull();
  });
});

describe("dedupe store", () => {
  it("remembers marked keys", async () => {
    const { markNotified, hasNotified } = await loadNotifications();
    expect(hasNotified("k1")).toBe(false);
    markNotified("k1");
    markNotified("k1");
    expect(hasNotified("k1")).toBe(true);
  });

  it("evicts the oldest keys beyond the FIFO cap of 500", async () => {
    const { markNotified, hasNotified } = await loadNotifications();
    for (let i = 0; i < 501; i += 1) markNotified(`k${i}`);
    expect(hasNotified("k0")).toBe(false);
    expect(hasNotified("k1")).toBe(true);
    expect(hasNotified("k500")).toBe(true);
  });
});

describe("shouldPlayFallbackSound", () => {
  const delivered = { delivered: true, focused: false };
  const undelivered = { delivered: false, focused: false };

  it("never plays when the sound toggle is off", async () => {
    const { shouldPlayFallbackSound } = await loadNotifications();
    expect(shouldPlayFallbackSound(settings({ sound: false }), undelivered)).toBe(false);
    expect(shouldPlayFallbackSound(settings({ sound: false, system: false }), undelivered)).toBe(false);
  });

  it("stays silent in the foreground when only-background is on", async () => {
    const { shouldPlayFallbackSound } = await loadNotifications();
    expect(
      shouldPlayFallbackSound(settings(), { delivered: false, focused: true }),
    ).toBe(false);
    expect(
      shouldPlayFallbackSound(settings({ onlyBackground: false }), {
        delivered: false,
        focused: true,
      }),
    ).toBe(true);
  });

  it("skips the chime when the system notification carried its own sound", async () => {
    const { shouldPlayFallbackSound } = await loadNotifications();
    expect(shouldPlayFallbackSound(settings(), delivered)).toBe(false);
  });

  it("plays when system notifications are disabled or failed", async () => {
    const { shouldPlayFallbackSound } = await loadNotifications();
    expect(shouldPlayFallbackSound(settings({ system: false }), undelivered)).toBe(true);
    expect(
      shouldPlayFallbackSound(settings(), { ...undelivered, error: "permission denied" }),
    ).toBe(true);
  });
});

describe("decideScheduleNotification（design.md 4.25）", () => {
  const notice = { scheduleId: "s1", name: "修测试", kind: "done" as const, message: "目标已完成" };

  it("目标完成 / 达到上限 / 失败给出不同标题", async () => {
    const { decideScheduleNotification } = await loadNotifications();
    expect(decideScheduleNotification(notice, settings())).toEqual({
      kind: "complete", title: "目标循环已完成", body: "「修测试」 · 目标已完成",
    });
    expect(decideScheduleNotification({ ...notice, kind: "exhausted" }, settings())).toMatchObject({
      kind: "error", title: "目标循环已达最大轮数",
    });
    expect(decideScheduleNotification({ ...notice, kind: "failed" }, settings())).toMatchObject({
      kind: "error", title: "自动化任务失败",
    });
  });

  it("遵守总闸与「任务完成」开关", async () => {
    const { decideScheduleNotification } = await loadNotifications();
    expect(decideScheduleNotification(notice, settings({ system: false, sound: false }))).toBeNull();
    expect(decideScheduleNotification(notice, settings({ onComplete: false }))).toBeNull();
  });
});

describe("notifyFromAgentEvent", () => {
  class FakeAudioContext {
    static created = 0;
    state = "running";
    currentTime = 0;
    destination = {};
    constructor() {
      FakeAudioContext.created += 1;
    }
    createGain() {
      return {
        gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
        connect: vi.fn(),
      };
    }
    createOscillator() {
      return {
        type: "sine",
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
    }
    resume() {
      return Promise.resolve();
    }
  }

  beforeEach(() => {
    FakeAudioContext.created = 0;
    vi.stubGlobal("AudioContext", FakeAudioContext);
  });

  it("is a no-op without the desktop bridge", async () => {
    const { notifyFromAgentEvent } = await loadNotifications();
    (globalThis as any).window = {};
    expect(() => notifyFromAgentEvent(approvalEvent(), runtimeWith())).not.toThrow();
  });

  it("invokes desktopNotify once with the settings-driven payload", async () => {
    const { notifyFromAgentEvent } = await loadNotifications();
    const desktopNotify = vi
      .fn()
      .mockResolvedValue({ delivered: true, focused: false, attentionRequested: true });
    (globalThis as any).window = { agentdeckDesktop: { desktopNotify } };

    notifyFromAgentEvent(approvalEvent(), runtimeWith());
    await flushAsync();

    expect(desktopNotify).toHaveBeenCalledTimes(1);
    expect(desktopNotify).toHaveBeenCalledWith({
      kind: "approval",
      title: "需要权限确认",
      body: "rm -rf build",
      showSystemNotification: true,
      withSound: true,
      respectFocus: true,
      requestAttention: true,
    });
  });

  it("does not notify twice for a replayed event", async () => {
    const { notifyFromAgentEvent } = await loadNotifications();
    const desktopNotify = vi
      .fn()
      .mockResolvedValue({ delivered: true, focused: false, attentionRequested: false });
    (globalThis as any).window = { agentdeckDesktop: { desktopNotify } };

    notifyFromAgentEvent(approvalEvent(), runtimeWith());
    notifyFromAgentEvent(approvalEvent(), runtimeWith());
    await flushAsync();

    expect(desktopNotify).toHaveBeenCalledTimes(1);
  });

  it("swallows bridge rejections", async () => {
    const { notifyFromAgentEvent } = await loadNotifications();
    const desktopNotify = vi.fn().mockRejectedValue(new Error("ipc down"));
    (globalThis as any).window = { agentdeckDesktop: { desktopNotify } };

    expect(() => notifyFromAgentEvent(approvalEvent(), runtimeWith())).not.toThrow();
    await flushAsync();
    expect(desktopNotify).toHaveBeenCalledTimes(1);
  });

  it("plays the WebAudio chime when system notifications are disabled", async () => {
    const { notifyFromAgentEvent } = await loadNotifications({
      "agentdeck.notify-system": false,
    });
    const desktopNotify = vi
      .fn()
      .mockResolvedValue({ delivered: false, focused: false, attentionRequested: true });
    (globalThis as any).window = { agentdeckDesktop: { desktopNotify } };

    notifyFromAgentEvent(approvalEvent(), runtimeWith());
    await flushAsync();

    expect(desktopNotify).toHaveBeenCalledWith(
      expect.objectContaining({ showSystemNotification: false, withSound: true }),
    );
    expect(FakeAudioContext.created).toBe(1);
  });

  it("respects disabled event-type toggles end to end", async () => {
    const { notifyFromAgentEvent } = await loadNotifications({
      "agentdeck.notify-on-approval": false,
    });
    const desktopNotify = vi.fn();
    (globalThis as any).window = { agentdeckDesktop: { desktopNotify } };

    notifyFromAgentEvent(approvalEvent(), runtimeWith());
    await flushAsync();

    expect(desktopNotify).not.toHaveBeenCalled();
  });

  it("prefixes the body with the session title", async () => {
    const { notifyFromAgentEvent } = await loadNotifications();
    const desktopNotify = vi
      .fn()
      .mockResolvedValue({ delivered: true, focused: false, attentionRequested: false });
    (globalThis as any).window = { agentdeckDesktop: { desktopNotify } };

    notifyFromAgentEvent(approvalEvent(), runtimeWith(), "重构登录");
    await flushAsync();

    expect(desktopNotify).toHaveBeenCalledWith(
      expect.objectContaining({ body: "「重构登录」 · rm -rf build" }),
    );
  });
});
