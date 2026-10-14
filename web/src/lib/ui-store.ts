export interface UiStoreSnapshot {
  kv: Record<string, unknown>;
}

type Listener = () => void;

const UI_STORE_BACKUP_KEY = "agentdeck_ui_backup";

const listeners = new Set<Listener>();
let kvCache: Record<string, unknown> = {};
let initialized = false;
let initPromise: Promise<void> | null = null;

function notify(): void {
  listeners.forEach((listener) => listener());
}

/** "desktop" = 桌面桥（无桥时 localStorage 兜底，浏览器开发模式）；"local-storage" = 手机入口，恒用 localStorage。 */
export type UiStoreBackend = "desktop" | "local-storage";

let backend: UiStoreBackend = "desktop";

/** 入口在 initUiStore 之前调用，决定持久化走桌面 Rust ui_store 还是 localStorage。 */
export function configureUiStoreBackend(next: UiStoreBackend): void {
  backend = next;
}

function bridge() {
  if (backend === "local-storage") return undefined;
  return typeof window === "undefined" ? undefined : window.agentdeckDesktop;
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
  (globalThis as any).__AGENTDECK_UI_STORE__ = {
    get: readUiValue,
    set: writeUiValue,
    remove: removeUiValue,
    subscribe: subscribeUiStore,
  };
}

installGlobalUiStoreBridge();
