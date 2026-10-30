import { useSyncExternalStore } from "react";
import type { ComposerAttachment } from "@/components/chat/composer-types";
import {
  deleteAttachmentFile,
  loadAttachmentFile,
  pruneAttachmentFiles,
  saveAttachmentFile,
} from "@/lib/queue-attachment-files";

// Per-session send queue. When the agent is busy, composer submissions are
// parked here and drained (automatically on turn-settle, or manually) when it
// frees up. Pure client state, persisted to localStorage (pasted files live in
// IndexedDB, see lib/queue-attachment-files.ts); no backend.

export interface QueuedPromptEntry {
  id: string;
  text: string;
  attachments: ComposerAttachment[];
  queuedAt: number;
}

export type QueueState = Record<string, QueuedPromptEntry[]>;

const STORAGE_KEY = "agentdeck.desktop.composerQueue.v1";
const EMPTY: readonly QueuedPromptEntry[] = [];

// ---- Pure reducers (unit-tested) -------------------------------------------

export function entriesFor(
  state: QueueState,
  key: string | null | undefined,
): QueuedPromptEntry[] {
  return (key && state[key]) || (EMPTY as QueuedPromptEntry[]);
}

export function enqueue(state: QueueState, key: string, entry: QueuedPromptEntry): QueueState {
  return { ...state, [key]: [...(state[key] ?? []), entry] };
}

export function removeEntry(state: QueueState, key: string, id: string): QueueState {
  const queue = state[key];
  if (!queue) return state;
  const next = queue.filter((entry) => entry.id !== id);
  if (next.length === queue.length) return state;
  if (next.length === 0) {
    const { [key]: _drop, ...rest } = state;
    return rest;
  }
  return { ...state, [key]: next };
}

export function updateEntry(
  state: QueueState,
  key: string,
  id: string,
  patch: Partial<Pick<QueuedPromptEntry, "text" | "attachments">>,
): QueueState {
  const queue = state[key];
  if (!queue) return state;
  return {
    ...state,
    [key]: queue.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
  };
}

export interface AutoDrainSettleInput {
  isBusy: boolean;
  wasBusy: boolean;
  queueLength: number;
  userInterrupted: boolean;
}

/**
 * Decide whether to auto-send the next queued prompt now. Only fires on a
 * busy→idle transition, never when an explicit Stop just interrupted the turn
 * (that suppresses exactly one drain), and only when something is queued.
 */
export function shouldAutoDrainOnSettle(params: AutoDrainSettleInput): boolean {
  if (params.isBusy || !params.wasBusy) return false;
  if (params.userInterrupted) return false;
  return params.queueLength > 0;
}

// ---- Persistence -----------------------------------------------------------

/** Strip transient (non-serializable) attachment fields before persisting. */
function attachmentForStorage(attachment: ComposerAttachment): ComposerAttachment {
  const { file: _file, previewUrl: _previewUrl, ...rest } = attachment;
  return rest;
}

export function serializeQueue(state: QueueState): string {
  const cleaned: QueueState = {};
  for (const [key, entries] of Object.entries(state)) {
    cleaned[key] = entries.map((entry) => ({
      ...entry,
      attachments: entry.attachments.map(attachmentForStorage),
    }));
  }
  return JSON.stringify(cleaned);
}

function isQueuedEntry(value: unknown): value is QueuedPromptEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Partial<QueuedPromptEntry>;
  return (
    typeof e.id === "string" &&
    typeof e.text === "string" &&
    typeof e.queuedAt === "number" &&
    Array.isArray(e.attachments)
  );
}

/** Keep attachments that can come back after a reload: path-based and
 *  already-uploaded ones work as is, browser files get their content back from
 *  IndexedDB (see applyLoadedFiles).
 *  Tolerates malformed elements (null / non-objects) without throwing. */
function sanitizeAttachments(attachments: ComposerAttachment[]): ComposerAttachment[] {
  return attachments.filter(
    (a): a is ComposerAttachment =>
      Boolean(a) && typeof a === "object" && (
        (a.source === "path" && Boolean(a.path)) ||
        (a.source === "uploaded" && Boolean(a.uploadedPath)) ||
        (a.source === "browser" && typeof a.id === "string")
      ),
  );
}

/**
 * Check whether any queued entry has attachments that cannot survive a page
 * refresh (browser files not yet saved to IndexedDB). Callers can use this to
 * warn the user before unload — see the `beforeunload` listener in this module.
 */
export function hasNonSerializableAttachments(
  state: QueueState,
  savedFileIds: ReadonlySet<string> = new Set(),
): boolean {
  for (const entries of Object.values(state)) {
    for (const entry of entries) {
      for (const att of entry.attachments) {
        if (
          att && typeof att === "object" && att.source !== "path" && att.source !== "uploaded" &&
          !savedFileIds.has(att.id)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

export function deserializeQueue(raw: string | null): QueueState {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    // Persisted state outlives the code that wrote it: it survives app updates
    // and reinstalls — only deleting app data clears it. A single malformed
    // entry (e.g. a `text` that deserializes to an object) would otherwise be
    // restored verbatim, render as "[object Object]" under the composer, and
    // wedge send/drain until the user wipes app data — the disaster reported in
    // issue #224's comments. Validate every entry and drop anything malformed
    // instead of trusting the persisted shape.
    const clean: QueueState = {};
    for (const [key, entries] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue;
      const valid = entries
        .filter(isQueuedEntry)
        .map((entry) => ({ ...entry, attachments: sanitizeAttachments(entry.attachments) }));
      if (valid.length > 0) clean[key] = valid;
    }
    return clean;
  } catch {
    return {};
  }
}

/** 刚从 localStorage 恢复、内容还没取回的浏览器文件附件 id。 */
export function fileIdsToLoad(state: QueueState): string[] {
  return Object.values(state).flatMap((entries) =>
    entries.flatMap((entry) =>
      entry.attachments.filter((a) => a.source === "browser" && !a.file).map((a) => a.id),
    ),
  );
}

/**
 * 并入从 IndexedDB 取回的文件：取到的填回 file，取不到（null）的去掉该附件；
 * 因此变成空消息的条目一并去掉。loaded 里没有的附件不动。
 */
export function applyLoadedFiles(state: QueueState, loaded: ReadonlyMap<string, File | null>): QueueState {
  const next: QueueState = {};
  for (const [key, entries] of Object.entries(state)) {
    const kept = entries.flatMap((entry) => {
      const attachments = entry.attachments.flatMap((a) => {
        if (a.source !== "browser" || a.file || !loaded.has(a.id)) return [a];
        const file = loaded.get(a.id);
        return file ? [{ ...a, file }] : [];
      });
      if (attachments.length === entry.attachments.length) return [{ ...entry, attachments }];
      return entry.text.trim() || attachments.length > 0 ? [{ ...entry, attachments }] : [];
    });
    if (kept.length > 0) next[key] = kept;
  }
  return next;
}

// ---- Live store (useSyncExternalStore) -------------------------------------

function readStorage(): QueueState {
  if (typeof window === "undefined") return {};
  try {
    return deserializeQueue(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
}

let liveState: QueueState = readStorage();
let idCounter = 0;
const listeners = new Set<() => void>();

function commit(next: QueueState) {
  liveState = next;
  if (typeof window !== "undefined") {
    try {
      if (Object.keys(next).length === 0) window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, serializeQueue(next));
    } catch {
      // best-effort; queue still works in-memory
    }
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): QueueState {
  return liveState;
}

// 已写入 IndexedDB（或启动时从那里恢复）的文件附件 id，刷新不会丢。
const savedFileIds = new Set<string>(fileIdsToLoad(liveState));

// 启动时取回粘贴文件的内容；发送和编辑要等它完成，否则会丢掉还没取回的附件。
const hydration: Promise<void> = hydrateAttachmentFiles();

async function hydrateAttachmentFiles(): Promise<void> {
  const ids = fileIdsToLoad(liveState);
  if (ids.length > 0) {
    const loaded = new Map(
      await Promise.all(ids.map(async (id) => [id, await loadAttachmentFile(id)] as const)),
    );
    for (const [id, file] of loaded) {
      if (!file) savedFileIds.delete(id);
    }
    commit(applyLoadedFiles(liveState, loaded));
  }
  const referenced = Object.values(liveState).flatMap((entries) =>
    entries.flatMap((entry) => entry.attachments.map((a) => a.id)),
  );
  await pruneAttachmentFiles(new Set(referenced));
}

function forgetAttachmentFiles(entry: QueuedPromptEntry): void {
  for (const attachment of entry.attachments) {
    if (attachment.source !== "browser") continue;
    savedFileIds.delete(attachment.id);
    void deleteAttachmentFile(attachment.id);
  }
}

// Warn before page refresh when queued prompts have attachments not yet saved
// (browser File objects / blob URLs that would be lost).
function installBeforeUnloadWarning() {
  if (typeof window === "undefined") return;
  const handler = (event: BeforeUnloadEvent) => {
    if (hasNonSerializableAttachments(liveState, savedFileIds)) {
      event.preventDefault();
      event.returnValue = "有暂存的附件可能丢失";
    }
  };
  window.addEventListener("beforeunload", handler);
}
installBeforeUnloadWarning();

export function enqueueQueuedPrompt(
  key: string | null | undefined,
  input: { text: string; attachments: ComposerAttachment[] },
  now: number,
): QueuedPromptEntry | null {
  if (!key) return null;
  if (!input.text.trim() && input.attachments.length === 0) return null;
  const entry: QueuedPromptEntry = {
    id: `queued-${now}-${(idCounter += 1)}`,
    text: input.text,
    attachments: input.attachments,
    queuedAt: now,
  };
  commit(enqueue(liveState, key, entry));
  for (const attachment of input.attachments) {
    if (attachment.source !== "browser" || !attachment.file) continue;
    void saveAttachmentFile(attachment.id, attachment.file).then((saved) => {
      if (saved) savedFileIds.add(attachment.id);
    });
  }
  return entry;
}

export function removeQueuedPrompt(key: string | null | undefined, id: string): void {
  if (!key) return;
  const entry = entriesFor(liveState, key).find((item) => item.id === id);
  if (entry) forgetAttachmentFiles(entry);
  commit(removeEntry(liveState, key, id));
}

/** 编辑排队消息：等文件取回后移出队列并返回该条，已不在队列时返回 null。 */
export async function takeQueuedPrompt(key: string, id: string): Promise<QueuedPromptEntry | null> {
  await hydration;
  const entry = entriesFor(liveState, key).find((item) => item.id === id);
  if (!entry) return null;
  removeQueuedPrompt(key, id);
  return entry;
}

export function updateQueuedPrompt(
  key: string | null | undefined,
  id: string,
  patch: Partial<Pick<QueuedPromptEntry, "text" | "attachments">>,
): void {
  if (!key) return;
  commit(updateEntry(liveState, key, id, patch));
}

/** Subscribe a component to the queued entries for one session. */
export function useQueuedPrompts(key: string | null | undefined): QueuedPromptEntry[] {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return entriesFor(snapshot, key);
}

/** Subscribe to the whole queue state (all sessions). */
export function useQueueState(): QueueState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ---- 出队协调（仅内存） ------------------------------------------------------
// 自动出队由应用根部的 useQueueAutoDrain 统一监视所有会话，详情页的「立即发送」
// 与之共用同一把按会话的发送锁；用户主动中止 / 撤回时记一次抑制。

const drainingKeys = new Set<string>();
const interruptedKeys = new Set<string>();

/** 用户主动中止 / 撤回本轮：抑制该会话下一次回合结束时的自动出队 */
export function markQueueInterrupted(key: string | null | undefined): void {
  if (key) interruptedKeys.add(key);
}

export function clearQueueInterrupted(key: string | null | undefined): void {
  if (key) interruptedKeys.delete(key);
}

/** 读取并清除中止标记 */
export function takeQueueInterrupted(key: string): boolean {
  return interruptedKeys.delete(key);
}

/** 发送一条排队消息，成功后移出队列；同一会话同时只发一条 */
export async function drainQueuedPrompt(
  key: string,
  entry: QueuedPromptEntry,
  send: (entry: QueuedPromptEntry) => Promise<void>,
): Promise<void> {
  if (drainingKeys.has(key)) return;
  drainingKeys.add(key);
  try {
    await hydration;
    const current = entriesFor(liveState, key).find((item) => item.id === entry.id);
    if (!current) return;
    await send(current);
    removeQueuedPrompt(key, current.id);
  } catch (error) {
    console.error("发送排队消息失败：", error);
  } finally {
    drainingKeys.delete(key);
  }
}
