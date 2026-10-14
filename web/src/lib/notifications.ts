// 桌面通知触发链路（issue #194）。
//
// 在 applyAgentEventAtom 消费 sidecar 事件时旁路调用（见 stores/chat.ts），
// 把「任务完成 / 任务出错 / 需要权限确认」翻译成 desktop_notify IPC：Rust 侧负责
// 前台判定、系统通知（自带原生提示音）和 dock 弹跳 / 任务栏闪烁；本模块负责
// 决策（设置开关、防重放去重、文案）和系统通知不可用时的 WebAudio 兜底音。
//
// decideNotification / shouldPlayFallbackSound 是纯函数，便于 vitest 全矩阵
// 覆盖；所有副作用都 fire-and-forget 且错误吞掉，绝不影响聊天主流程。

import type { AgentStreamEnvelope, ScheduleNotice } from "@agentdeck/protocol";
import type { ChatSessionRuntime } from "@/stores/chat";
import { readNotificationSettings, type NotificationSettings } from "@/stores/ui";
import type { DesktopNotifyInput, DesktopNotifyResult } from "@/lib/runtime";
import { describePermissionCommand } from "@/lib/agent-tool-detail";

export interface NotificationAction {
  dedupeKey: string;
  kind: "approval" | "complete" | "error";
  title: string;
  body: string;
}

const MAX_BODY_CHARS = 120;
const SUMMARY_CHARS = 80;
const SESSION_TITLE_CHARS = 24;
const MAX_DEDUPE_KEYS = 500;

function truncate(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  // 按码点切，`slice` 按 UTF-16 截断会把 emoji 的代理对劈成孤立代理字符。
  const chars = Array.from(trimmed);
  if (chars.length <= max) return trimmed;
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

function lastUserPromptSummary(
  runtime: ChatSessionRuntime | undefined,
  max: number,
): string | undefined {
  if (!runtime) return undefined;
  for (let i = runtime.messages.length - 1; i >= 0; i -= 1) {
    const message = runtime.messages[i];
    if (message.role !== "user") continue;
    const text = message.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join(" ")
      .trim();
    if (text) return truncate(text, max);
  }
  return undefined;
}

export function decideNotification(input: {
  envelope: AgentStreamEnvelope;
  prevRuntime: ChatSessionRuntime | undefined;
  settings: NotificationSettings;
  alreadyNotified: (key: string) => boolean;
}): NotificationAction | null {
  const { envelope, prevRuntime, settings, alreadyNotified } = input;
  // 总闸：系统通知和提示音都关 = 用户不要任何打扰（注意力请求也不发）。
  if (!settings.system && !settings.sound) return null;
  const { agentId, event } = envelope;
  if (!agentId) return null;

  if (event.type === "permission_requested") {
    if (!settings.onApproval) return null;
    const requestId = event.request.id;
    if (!requestId) return null;
    // 已在待审批列表里（回放 / 重复推送）就不再通知。
    if (prevRuntime?.pendingApprovals.some((item) => item.requestId === requestId)) {
      return null;
    }
    const dedupeKey = `approval:${agentId}:${requestId}`;
    if (alreadyNotified(dedupeKey)) return null;
    const detail = describePermissionCommand(event.request).trim();
    return {
      dedupeKey,
      kind: "approval",
      title: "需要权限确认",
      body: truncate(detail || "任务等待你的确认后才能继续", MAX_BODY_CHARS),
    };
  }

  if (event.type === "turn_completed" || event.type === "turn_failed") {
    if (!settings.onComplete) return null;
    // 重放防护：本地没有活跃回合（timeline 回放、重连）或用户已手动中断时
    // 不通知。回合收尾后会清空 activeAssistantId，同一回合只有一次「在场」的结束事件。
    if (!prevRuntime?.activeAssistantId || prevRuntime.interrupted) return null;
    const dedupeKey = `complete:${agentId}:${event.turnId}`;
    if (alreadyNotified(dedupeKey)) return null;
    if (event.type === "turn_failed") {
      return {
        dedupeKey,
        kind: "error",
        title: "任务出错",
        body: truncate(event.error || "任务执行失败，请回来查看详情", MAX_BODY_CHARS),
      };
    }
    return {
      dedupeKey,
      kind: "complete",
      title: "任务完成",
      body: lastUserPromptSummary(prevRuntime, SUMMARY_CHARS) ?? "会话回复已就绪",
    };
  }

  return null;
}

// ── 去重存储（module 级，FIFO 上限防泄漏）─────────────────────────────

const notifiedKeys = new Set<string>();
const notifiedOrder: string[] = [];

export function hasNotified(key: string): boolean {
  return notifiedKeys.has(key);
}

export function markNotified(key: string): void {
  if (notifiedKeys.has(key)) return;
  notifiedKeys.add(key);
  notifiedOrder.push(key);
  while (notifiedOrder.length > MAX_DEDUPE_KEYS) {
    const oldest = notifiedOrder.shift();
    if (oldest !== undefined) notifiedKeys.delete(oldest);
  }
}

export function __resetNotificationsForTests(): void {
  notifiedKeys.clear();
  notifiedOrder.length = 0;
}

function bodyWithSessionTitle(body: string, sessionTitle: string | undefined): string {
  const title = sessionTitle?.trim();
  if (!title) return body;
  return `「${truncate(title, SESSION_TITLE_CHARS)}」${body ? ` · ${body}` : ""}`;
}

// ── 提示音兜底 ──────────────────────────────────────────────────────────

export function shouldPlayFallbackSound(
  settings: NotificationSettings,
  result: Pick<DesktopNotifyResult, "delivered" | "focused" | "error">,
): boolean {
  if (!settings.sound) return false;
  // 窗口在前台且用户只要后台提醒：Rust 侧已整体抑制，这里也保持安静。
  if (result.focused && settings.onlyBackground) return false;
  // 系统通知正常发出时提示音由通知自身携带，不再补播。
  if (settings.system && result.delivered && !result.error) return false;
  return true;
}

let chimeAudioContext: AudioContext | undefined;

function chimeContext(): AudioContext | undefined {
  if (typeof AudioContext === "undefined") return undefined;
  try {
    if (!chimeAudioContext) chimeAudioContext = new AudioContext();
    if (chimeAudioContext.state === "suspended") {
      void chimeAudioContext.resume().catch(() => {});
    }
    return chimeAudioContext;
  } catch {
    return undefined;
  }
}

/** WebAudio 合成的两音上行 chime（A5 → E6，约 0.45s），零音频资产。 */
export function playChime(): void {
  const ctx = chimeContext();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.4, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
    gain.connect(ctx.destination);
    const notes: ReadonlyArray<readonly [number, number]> = [
      [880, now],
      [1318.5, now + 0.12],
    ];
    for (const [frequency, at] of notes) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(frequency, at);
      osc.connect(gain);
      osc.start(at);
      osc.stop(now + 0.5);
    }
  } catch {
    // 播放失败保持静默。
  }
}

// ── 通知出口（可按入口替换）──────────────────────────────────────────────

export type Notifier = (input: DesktopNotifyInput) => Promise<DesktopNotifyResult | void>;

// undefined = 默认走桌面桥 desktopNotify；null = 本入口不发通知；函数 = 入口自带实现（手机 M3 的本地通知）
let notifier: Notifier | null | undefined;

export function configureNotifier(next: Notifier | null | undefined): void {
  notifier = next;
}

function resolveNotifier(): Notifier | null {
  if (notifier !== undefined) return notifier;
  const bridge = typeof window === "undefined" ? undefined : window.agentdeckDesktop;
  return typeof bridge?.desktopNotify === "function" ? (input) => bridge.desktopNotify!(input) : null;
}

// ── 触发器（副作用入口，错误全吞）──────────────────────────────────────

export function notifyFromAgentEvent(
  envelope: AgentStreamEnvelope,
  prevRuntime: ChatSessionRuntime | undefined,
  sessionTitle?: string,
): void {
  try {
    const notify = resolveNotifier();
    if (!notify) return;
    const settings = readNotificationSettings();
    const action = decideNotification({
      envelope,
      prevRuntime,
      settings,
      alreadyNotified: hasNotified,
    });
    if (!action) return;
    markNotified(action.dedupeKey);
    void notify({
      kind: action.kind,
      title: action.title,
      body: bodyWithSessionTitle(action.body, sessionTitle),
      showSystemNotification: settings.system,
      withSound: settings.sound,
      respectFocus: settings.onlyBackground,
      requestAttention: true,
    })
      .then((result) => {
        if (result && shouldPlayFallbackSound(settings, result)) playChime();
      })
      .catch(() => {});
  } catch {
    // 通知永远不能影响聊天主流程。
  }
}

// ── 调度器通知（design.md 4.25）──────────────────────────────────────────

export interface ScheduleNotificationAction {
  kind: "complete" | "error";
  title: string;
  body: string;
}

/** 目标循环结束 / 定时任务失败 → 通知内容；遵守通知总闸与「任务完成」开关。纯函数。 */
export function decideScheduleNotification(
  notice: ScheduleNotice,
  settings: NotificationSettings,
): ScheduleNotificationAction | null {
  if (!settings.system && !settings.sound) return null;
  if (!settings.onComplete) return null;
  const name = truncate(notice.name, SESSION_TITLE_CHARS);
  const body = truncate(notice.message, MAX_BODY_CHARS);
  const detail = `「${name}」${body ? ` · ${body}` : ""}`;
  switch (notice.kind) {
    case "done":
      return { kind: "complete", title: "目标循环已完成", body: detail };
    case "exhausted":
      return { kind: "error", title: "目标循环已达最大轮数", body: detail };
    default:
      return { kind: "error", title: "自动化任务失败", body: detail };
  }
}

export function notifyFromSchedule(notice: ScheduleNotice): void {
  try {
    const notify = resolveNotifier();
    if (!notify) return;
    const settings = readNotificationSettings();
    const action = decideScheduleNotification(notice, settings);
    if (!action) return;
    void notify({
      kind: action.kind,
      title: action.title,
      body: action.body,
      showSystemNotification: settings.system,
      withSound: settings.sound,
      respectFocus: settings.onlyBackground,
      requestAttention: true,
    })
      .then((result) => {
        if (result && shouldPlayFallbackSound(settings, result)) playChime();
      })
      .catch(() => {});
  } catch {
    // 通知永远不能影响主流程。
  }
}
