import { atom } from "jotai";
import type { ComposerSubmitShortcut } from "@/lib/composer-submit-shortcut";
import { readUiValue, removeUiValue, subscribeUiStore, writeUiValue } from "@/lib/ui-store";

function persistedUiBaseAtom<T>(read: () => T) {
  const baseAtom = atom<T>(read());
  baseAtom.onMount = (setValue) => {
    const syncFromUiStore = () => setValue(read());
    syncFromUiStore();
    return subscribeUiStore(syncFromUiStore);
  };
  return baseAtom;
}

const ACTIVE_SESSION_ID_KEY = "agentdeck.active-session-id";

const activeSessionIdBaseAtom = persistedUiBaseAtom<string | null>(
  () => readUiValue<string | null>(ACTIVE_SESSION_ID_KEY, null),
);

/**
 * Tracks the currently-active session ID across the UI (sidebar highlight,
 * detail route target, sidecar resume). Persisted to the UI store so it
 * survives page refresh (F5) on non-detail routes (e.g., the Panel page).
 *
 * On detail routes the URL (`/tasks/:taskId`) provides recovery, but the
 * atom is the single source of truth at runtime — sidebar/history/panel
 * clicks update it synchronously before navigating (see issue #53).
 *
 * Setting to `null` short-circuits the persisted key (via removeUiValue)
 * so a stale session ID doesn't linger after the user has explicitly
 * cleared their active context.
 */
export const activeSessionIdAtom = atom(
  (get) => get(activeSessionIdBaseAtom),
  (_get, set, next: string | null) => {
    set(activeSessionIdBaseAtom, next);
    if (next) {
      writeUiValue(ACTIVE_SESSION_ID_KEY, next);
    } else {
      removeUiValue(ACTIVE_SESSION_ID_KEY);
    }
  },
);

const SIDEBAR_SEARCH_KEY = "agentdeck.sidebar-search";

function readSidebarSearch(): string {
  if (typeof sessionStorage === "undefined") return "";
  try {
    return sessionStorage.getItem(SIDEBAR_SEARCH_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeSidebarSearch(value: string): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    if (value) {
      sessionStorage.setItem(SIDEBAR_SEARCH_KEY, value);
    } else {
      sessionStorage.removeItem(SIDEBAR_SEARCH_KEY);
    }
  } catch {}
}

const sidebarSearchBaseAtom = atom<string>(readSidebarSearch());

export const sidebarSearchAtom = atom(
  (get) => get(sidebarSearchBaseAtom),
  (_get, set, next: string) => {
    set(sidebarSearchBaseAtom, next);
    writeSidebarSearch(next);
  },
);
export const commandPaletteOpenAtom = atom(false);

const APP_SIDEBAR_VISIBLE_KEY = "agentdeck.app-sidebar-visible";
const appSidebarVisibleBaseAtom = persistedUiBaseAtom<boolean>(
  () => readUiValue<unknown>(APP_SIDEBAR_VISIBLE_KEY, true) !== false,
);
export const appSidebarVisibleAtom = atom(
  (get) => get(appSidebarVisibleBaseAtom),
  (_get, set, next: boolean) => {
    const visible = next === true;
    set(appSidebarVisibleBaseAtom, visible);
    writeUiValue(APP_SIDEBAR_VISIBLE_KEY, visible);
  },
);

// 侧栏快捷入口（「新建对话」除外）中被关掉的入口路径；存「隐藏」而非「显示」，以后新增的入口默认可见。
const SIDEBAR_HIDDEN_ENTRIES_KEY = "agentdeck.sidebar-hidden-entries";
function normalizeSidebarHiddenEntries(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
const sidebarHiddenEntriesBaseAtom = persistedUiBaseAtom<string[]>(
  () => normalizeSidebarHiddenEntries(readUiValue<unknown>(SIDEBAR_HIDDEN_ENTRIES_KEY, [])),
);
export const sidebarHiddenEntriesAtom = atom(
  (get) => get(sidebarHiddenEntriesBaseAtom),
  (_get, set, next: string[]) => {
    const value = normalizeSidebarHiddenEntries(next);
    set(sidebarHiddenEntriesBaseAtom, value);
    writeUiValue(SIDEBAR_HIDDEN_ENTRIES_KEY, value);
  },
);

export const CONVERSATION_WIDTH_OPTIONS = [
  // 档位整体上调一档（用户反馈原「小/中」过窄）：大 = 960 + 头像列
  // 46px（36px 头像 + 10px gap），正文有效宽度与原「大」一致。
  { value: "small", label: "小", title: "小宽度", maxWidth: "780px" },
  { value: "medium", label: "中", title: "中等宽度", maxWidth: "960px" },
  { value: "large", label: "大", title: "大宽度", maxWidth: "1008px" },
  { value: "full", label: "满", title: "铺满宽度", maxWidth: "100%" },
] as const;

export type ConversationWidthMode = typeof CONVERSATION_WIDTH_OPTIONS[number]["value"];

export const CONVERSATION_FONT_SIZE_OPTIONS = [
  { value: "small", label: "小", title: "小字号", fontSize: "13px", lineHeight: "1.72" },
  { value: "standard", label: "标准", title: "标准字号", fontSize: "14px", lineHeight: "1.78" },
  { value: "large", label: "大", title: "大字号", fontSize: "15.5px", lineHeight: "1.82" },
] as const;

export type ConversationFontSizeMode = typeof CONVERSATION_FONT_SIZE_OPTIONS[number]["value"];

/** 未自定义助手名称时存空串：展示时按会话所用 Agent 的名称显示，取不到时显示 ASSISTANT_FALLBACK_NAME。 */
export const DEFAULT_ASSISTANT_DISPLAY_NAME = "";
export const ASSISTANT_FALLBACK_NAME = "Agent";
export const ASSISTANT_DISPLAY_NAME_KEY = "agentdeck.assistant-display-name";
export const ASSISTANT_AVATAR_KEY = "agentdeck.assistant-avatar-data-url";
const MAX_ASSISTANT_DISPLAY_NAME_LENGTH = 40;

const DEFAULT_CONVERSATION_WIDTH_MODE: ConversationWidthMode = "large";
const CONVERSATION_WIDTH_KEY = "agentdeck.conversation-width";
const CONVERSATION_WIDTH_VALUES = CONVERSATION_WIDTH_OPTIONS.map((option) => option.value);
const DEFAULT_CONVERSATION_FONT_SIZE_MODE: ConversationFontSizeMode = "standard";
const CONVERSATION_FONT_SIZE_KEY = "agentdeck.conversation-font-size";
const CONVERSATION_FONT_SIZE_VALUES = CONVERSATION_FONT_SIZE_OPTIONS.map((option) => option.value);

export function normalizeConversationWidthMode(value: unknown): ConversationWidthMode {
  return CONVERSATION_WIDTH_VALUES.includes(value as ConversationWidthMode)
    ? (value as ConversationWidthMode)
    : DEFAULT_CONVERSATION_WIDTH_MODE;
}

export function conversationWidthMaxWidth(mode: ConversationWidthMode): string {
  return CONVERSATION_WIDTH_OPTIONS.find((option) => option.value === mode)?.maxWidth ?? "780px";
}

export function normalizeConversationFontSizeMode(value: unknown): ConversationFontSizeMode {
  return CONVERSATION_FONT_SIZE_VALUES.includes(value as ConversationFontSizeMode)
    ? (value as ConversationFontSizeMode)
    : DEFAULT_CONVERSATION_FONT_SIZE_MODE;
}

export function conversationFontSizeVars(mode: ConversationFontSizeMode): { fontSize: string; lineHeight: string } {
  const option = CONVERSATION_FONT_SIZE_OPTIONS.find((item) => item.value === mode)
    ?? CONVERSATION_FONT_SIZE_OPTIONS[1];
  return { fontSize: option.fontSize, lineHeight: option.lineHeight };
}

export function normalizeAssistantDisplayName(value: unknown): string {
  const trimmed = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!trimmed) return DEFAULT_ASSISTANT_DISPLAY_NAME;
  return Array.from(trimmed).slice(0, MAX_ASSISTANT_DISPLAY_NAME_LENGTH).join("");
}

export function normalizeAssistantAvatarDataUrl(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  return /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,/i.test(text) ? text : "";
}

const conversationWidthModeBaseAtom = persistedUiBaseAtom<ConversationWidthMode>(
  () => normalizeConversationWidthMode(readUiValue(CONVERSATION_WIDTH_KEY, DEFAULT_CONVERSATION_WIDTH_MODE)),
);
export const conversationWidthModeAtom = atom(
  (get) => get(conversationWidthModeBaseAtom),
  (_get, set, next: ConversationWidthMode) => {
    const value = normalizeConversationWidthMode(next);
    set(conversationWidthModeBaseAtom, value);
    writeUiValue(CONVERSATION_WIDTH_KEY, value);
  },
);

const conversationFontSizeBaseAtom = persistedUiBaseAtom<ConversationFontSizeMode>(
  () => normalizeConversationFontSizeMode(readUiValue(CONVERSATION_FONT_SIZE_KEY, DEFAULT_CONVERSATION_FONT_SIZE_MODE)),
);
export const conversationFontSizeAtom = atom(
  (get) => get(conversationFontSizeBaseAtom),
  (_get, set, next: ConversationFontSizeMode) => {
    const value = normalizeConversationFontSizeMode(next);
    set(conversationFontSizeBaseAtom, value);
    writeUiValue(CONVERSATION_FONT_SIZE_KEY, value);
  },
);

const assistantDisplayNameBaseAtom = persistedUiBaseAtom<string>(
  () => normalizeAssistantDisplayName(readUiValue(ASSISTANT_DISPLAY_NAME_KEY, DEFAULT_ASSISTANT_DISPLAY_NAME)),
);
export const assistantDisplayNameAtom = atom(
  (get) => get(assistantDisplayNameBaseAtom),
  (_get, set, next: string) => {
    const value = normalizeAssistantDisplayName(next);
    set(assistantDisplayNameBaseAtom, value);
    if (value === DEFAULT_ASSISTANT_DISPLAY_NAME) {
      writeUiValue(ASSISTANT_DISPLAY_NAME_KEY, "");
    } else {
      writeUiValue(ASSISTANT_DISPLAY_NAME_KEY, value);
    }
  },
);

const assistantAvatarDataUrlBaseAtom = persistedUiBaseAtom<string>(
  () => normalizeAssistantAvatarDataUrl(readUiValue(ASSISTANT_AVATAR_KEY, "")),
);
export const assistantAvatarDataUrlAtom = atom(
  (get) => get(assistantAvatarDataUrlBaseAtom),
  (_get, set, next: string) => {
    const value = normalizeAssistantAvatarDataUrl(next);
    set(assistantAvatarDataUrlBaseAtom, value);
    writeUiValue(ASSISTANT_AVATAR_KEY, value);
  },
);

const showReasoningBaseAtom = persistedUiBaseAtom<boolean>(
  () => readUiValue("agentdeck.show-reasoning", false),
);
export const showReasoningAtom = atom(
  (get) => get(showReasoningBaseAtom),
  (_get, set, next: boolean) => {
    set(showReasoningBaseAtom, next);
    writeUiValue("agentdeck.show-reasoning", next);
  },
);

// Task-detail right rail (issue #233): rich preview panel visibility. Persisted
// so the user's last choice survives reload; ⌘B toggles it. The active tab
// lives in the `?panel=` query, not here (see lib/preview-rail.ts).
const RIGHT_RAIL_VISIBLE_KEY = "agentdeck.right-rail-visible";
const rightRailVisibleBaseAtom = persistedUiBaseAtom<boolean>(
  () => readUiValue<unknown>(RIGHT_RAIL_VISIBLE_KEY, false) === true,
);
export const rightRailVisibleAtom = atom(
  (get) => get(rightRailVisibleBaseAtom),
  (_get, set, next: boolean) => {
    set(rightRailVisibleBaseAtom, next === true);
    writeUiValue(RIGHT_RAIL_VISIBLE_KEY, next === true);
  },
);

const COMPOSER_SUBMIT_SHORTCUT_KEY = "agentdeck.composer-submit-shortcut";

function normalizeComposerSubmitShortcut(value: unknown): ComposerSubmitShortcut {
  return value === "ctrl-enter" ? "ctrl-enter" : "enter";
}

const composerSubmitShortcutBaseAtom = persistedUiBaseAtom<ComposerSubmitShortcut>(
  () => normalizeComposerSubmitShortcut(readUiValue(COMPOSER_SUBMIT_SHORTCUT_KEY, "ctrl-enter")),
);
export const composerSubmitShortcutAtom = atom(
  (get) => get(composerSubmitShortcutBaseAtom),
  (_get, set, next: ComposerSubmitShortcut) => {
    const value = normalizeComposerSubmitShortcut(next);
    set(composerSubmitShortcutBaseAtom, value);
    writeUiValue(COMPOSER_SUBMIT_SHORTCUT_KEY, value);
  },
);

// 桌面通知设置（issue #194）。触发链路（stores/chat.ts → lib/notifications.ts）
// 不在 React 上下文里，直接通过 readNotificationSettings() 同步读 kv 缓存；
// atoms 写入时 writeUiValue 同步写穿同一缓存，两边天然一致。
const NOTIFY_SYSTEM_KEY = "agentdeck.notify-system";
const NOTIFY_SOUND_KEY = "agentdeck.notify-sound";
const NOTIFY_ON_COMPLETE_KEY = "agentdeck.notify-on-complete";
const NOTIFY_ON_APPROVAL_KEY = "agentdeck.notify-on-approval";
const NOTIFY_ONLY_BACKGROUND_KEY = "agentdeck.notify-only-background";

function readNotifyFlag(key: string): boolean {
  return readUiValue<unknown>(key, true) !== false;
}

function makeNotifyFlagAtom(key: string) {
  const baseAtom = persistedUiBaseAtom<boolean>(() => readNotifyFlag(key));
  return atom(
    (get) => get(baseAtom),
    (_get, set, next: boolean) => {
      set(baseAtom, next === true);
      writeUiValue(key, next === true);
    },
  );
}

export const notifySystemAtom = makeNotifyFlagAtom(NOTIFY_SYSTEM_KEY);
export const notifySoundAtom = makeNotifyFlagAtom(NOTIFY_SOUND_KEY);
export const notifyOnCompleteAtom = makeNotifyFlagAtom(NOTIFY_ON_COMPLETE_KEY);
export const notifyOnApprovalAtom = makeNotifyFlagAtom(NOTIFY_ON_APPROVAL_KEY);
export const notifyOnlyBackgroundAtom = makeNotifyFlagAtom(NOTIFY_ONLY_BACKGROUND_KEY);

export interface NotificationSettings {
  system: boolean;
  sound: boolean;
  onComplete: boolean;
  onApproval: boolean;
  onlyBackground: boolean;
}

/**
 * Re-read all persisted atoms from the UI store's current kvCache.
 *
 * Call this AFTER `initUiStore()` completes to ensure atoms reflect
 * persisted values even if they were created at module-import time
 * before the UI store was initialized (the F5 refresh race).
 *
 * For writable atoms created via `makeNotifyFlagAtom` (whose private
 * base atoms are not accessible), we call `store.set()` on the exported
 * atom — the write handler is idempotent for values already in kvCache.
 *
 * This function is safe to call multiple times; it only updates atoms
 * whose current value differs from the persisted value.
 */
export function hydratePersistedUiAtoms(store: ReturnType<typeof import("jotai/vanilla")["createStore"]>): void {
  type JotaiStore = typeof store;

  // 1. Conversation width
  const width = readUiValue(CONVERSATION_WIDTH_KEY, undefined);
  if (width !== undefined) {
    const normalized = normalizeConversationWidthMode(width);
    if (store.get(conversationWidthModeBaseAtom) !== normalized) {
      store.set(conversationWidthModeBaseAtom as any, normalized);
    }
  }

  // 2. Conversation font size
  const fontSize = readUiValue(CONVERSATION_FONT_SIZE_KEY, undefined);
  if (fontSize !== undefined) {
    const normalized = normalizeConversationFontSizeMode(fontSize);
    if (store.get(conversationFontSizeBaseAtom) !== normalized) {
      store.set(conversationFontSizeBaseAtom as any, normalized);
    }
  }

  // 4. Assistant display name
  const displayName = readUiValue<string | undefined>(ASSISTANT_DISPLAY_NAME_KEY, undefined);
  if (displayName !== undefined) {
    const normalized = normalizeAssistantDisplayName(displayName);
    if (store.get(assistantDisplayNameBaseAtom) !== normalized) {
      store.set(assistantDisplayNameBaseAtom as any, normalized);
    }
  }

  // 5. Assistant avatar
  const avatar = readUiValue<string | undefined>(ASSISTANT_AVATAR_KEY, undefined);
  if (avatar !== undefined) {
    const normalized = normalizeAssistantAvatarDataUrl(avatar);
    if (store.get(assistantAvatarDataUrlBaseAtom) !== normalized) {
      store.set(assistantAvatarDataUrlBaseAtom as any, normalized);
    }
  }

  // 6. Show reasoning
  const showReasoning = readUiValue<unknown>("agentdeck.show-reasoning", undefined);
  if (showReasoning !== undefined) {
    const enabled = showReasoning === true;
    if (store.get(showReasoningBaseAtom) !== enabled) {
      store.set(showReasoningBaseAtom as any, enabled);
    }
  }

  // 8. Right rail visible
  const rightRail = readUiValue<unknown>(RIGHT_RAIL_VISIBLE_KEY, undefined);
  if (rightRail !== undefined) {
    const visible = rightRail === true;
    if (store.get(rightRailVisibleBaseAtom) !== visible) {
      store.set(rightRailVisibleBaseAtom as any, visible);
    }
  }

  // 9. Composer submit shortcut
  const shortcut = readUiValue<unknown>(COMPOSER_SUBMIT_SHORTCUT_KEY, undefined);
  if (shortcut !== undefined) {
    const normalized = normalizeComposerSubmitShortcut(shortcut);
    if (store.get(composerSubmitShortcutBaseAtom) !== normalized) {
      store.set(composerSubmitShortcutBaseAtom as any, normalized);
    }
  }

  // 10. Active session ID — use exported atom (write handler handles set/null)
  const activeSessionId = readUiValue<string | null | undefined>(ACTIVE_SESSION_ID_KEY, undefined);
  // We read the store's current value from the exported atom's getter, not
  // the private base atom, because the exported atom layers on top of the base.
  // For null comparison we check if the stored value is explicitly null vs absent.
  if (activeSessionId !== undefined) {
    const current = store.get(activeSessionIdAtom);
    if (current !== activeSessionId) {
      store.set(activeSessionIdAtom, activeSessionId);
    }
  }

  // 11-15. Notification flags — use exported atoms (write handler is idempotent)
  const notifyKeys: Array<{ atom: any; key: string }> = [
    { atom: notifySystemAtom, key: NOTIFY_SYSTEM_KEY },
    { atom: notifySoundAtom, key: NOTIFY_SOUND_KEY },
    { atom: notifyOnCompleteAtom, key: NOTIFY_ON_COMPLETE_KEY },
    { atom: notifyOnApprovalAtom, key: NOTIFY_ON_APPROVAL_KEY },
    { atom: notifyOnlyBackgroundAtom, key: NOTIFY_ONLY_BACKGROUND_KEY },
  ];
  for (const { atom: notifAtom, key } of notifyKeys) {
    const stored = readUiValue<unknown>(key, undefined);
    if (stored !== undefined) {
      const enabled = stored !== false;
      if (store.get(notifAtom) !== enabled) {
        store.set(notifAtom, enabled);
      }
    }
  }
}

export function readNotificationSettings(): NotificationSettings {
  return {
    system: readNotifyFlag(NOTIFY_SYSTEM_KEY),
    sound: readNotifyFlag(NOTIFY_SOUND_KEY),
    onComplete: readNotifyFlag(NOTIFY_ON_COMPLETE_KEY),
    onApproval: readNotifyFlag(NOTIFY_ON_APPROVAL_KEY),
    onlyBackground: readNotifyFlag(NOTIFY_ONLY_BACKGROUND_KEY),
  };
}

