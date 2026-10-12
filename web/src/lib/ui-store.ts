import type { HermesMessageMetadata } from "@agentdeck/protocol";

export interface UiStoreSnapshot {
  kv: Record<string, unknown>;
}

export interface UiTurnStats {
  id: string;
  sessionId: string;
  gatewaySessionId?: string;
  clientMessageId?: string;
  backendMessageId?: number;
  turnIndex?: number;
  contentHash?: string;
  metadata?: HermesMessageMetadata;
  model?: string;
  provider?: string;
  startedAt?: number;
  firstTokenAt?: number;
  completedAt?: number;
  ttftMs?: number;
  durationMs?: number;
  tokensInput?: number;
  tokensOutput?: number;
  tokensTotal?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoningTokens?: number;
  contextUsed?: number;
  contextMax?: number;
  apiCalls?: number;
  costUsd?: number;
  costStatus?: string;
  finishReason?: string;
  status?: string;
  createdAt?: number;
}

export interface UiEventInput {
  id: string;
  ts: number;
  eventName: string;
  sessionId?: string;
  source?: string;
  props?: Record<string, unknown>;
  appVersion?: string;
}

type Listener = () => void;

const UI_STORE_BACKUP_KEY = "hermes_ui_backup";

const listeners = new Set<Listener>();
let kvCache: Record<string, unknown> = {};
let initialized = false;
let initPromise: Promise<void> | null = null;

function notify(): void {
  listeners.forEach((listener) => listener());
}

function bridge() {
  return typeof window === "undefined" ? undefined : window.hermesDesktop;
}

function clone<T>(value: T): T {
  if (value === undefined || value === null) return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

export async function initUiStore(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const snapshot = await bridge()?.uiStoreSnapshot?.();
      kvCache = snapshot?.kv ?? {};

      // Web mode: native bridge unavailable, load from localStorage backup
      if (!bridge() && Object.keys(kvCache).length === 0) {
        try {
          const backup = localStorage.getItem(UI_STORE_BACKUP_KEY);
          if (backup) {
            const parsed = JSON.parse(backup);
            if (typeof parsed === "object" && parsed !== null) {
              kvCache = parsed as Record<string, unknown>;
            }
          }
        } catch {
          // Corrupted or missing backup — ignore
        }
      }
    } catch {
      kvCache = {};
    } finally {
      initialized = true;
      installGlobalUiStoreBridge();
      notify();
    }
  })();
  return initPromise;
}

export async function reloadUiStore(): Promise<void> {
  initPromise = null;
  initialized = false;
  await initUiStore();
}

export function readUiValue<T>(key: string, fallback: T): T {
  const value = kvCache[key];
  return value === undefined ? fallback : clone(value as T);
}

export function writeUiValue(key: string, value: unknown): void {
  kvCache[key] = clone(value);
  notify();
  void bridge()?.uiStoreSetKv?.({ key, value }).catch(() => {});
  // localStorage fallback for web mode (no native bridge)
  if (!bridge()) {
    try {
      localStorage.setItem(UI_STORE_BACKUP_KEY, JSON.stringify(kvCache));
    } catch {
      // localStorage full or unavailable — silently skip
    }
  }
}

export function removeUiValue(key: string): void {
  delete kvCache[key];
  notify();
  void bridge()?.uiStoreRemoveKv?.({ key }).catch(() => {});
  if (!bridge()) {
    try {
      localStorage.setItem(UI_STORE_BACKUP_KEY, JSON.stringify(kvCache));
    } catch {
      // localStorage full or unavailable — silently skip
    }
  }
}

export function subscribeUiStore(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function __resetUiStoreForTests(seed: Record<string, unknown> = {}): void {
  kvCache = clone(seed);
  initialized = true;
  initPromise = null;
  installGlobalUiStoreBridge();
  notify();
}

function installGlobalUiStoreBridge(): void {
  (globalThis as any).__HERMES_UI_STORE__ = {
    get: readUiValue,
    set: writeUiValue,
    remove: removeUiValue,
    subscribe: subscribeUiStore,
  };
}

installGlobalUiStoreBridge();
