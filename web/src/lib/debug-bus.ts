import { redact, redactSummary } from "./debug-redact";

export type DebugEntryType = "gateway" | "rest" | "console" | "exception" | "backend";
export type DebugEntryLevel = "info" | "warn" | "error";

export interface DebugEntry {
  id: number;
  ts: number;
  type: DebugEntryType;
  level: DebugEntryLevel;
  summary: string;
  payload?: unknown;
}

const MAX_ENTRIES = 500;

class DebugBus {
  private entries: DebugEntry[] = [];
  private cachedSnapshot: DebugEntry[] = [];
  private listeners = new Set<(entries: DebugEntry[]) => void>();
  private nextId = 1;
  private notifyScheduled = false;
  private paused = false;

  push(entry: Omit<DebugEntry, "id" | "ts"> & { ts?: number }): void {
    if (this.paused) return;
    const next: DebugEntry = {
      id: this.nextId++,
      ts: entry.ts ?? Date.now(),
      type: entry.type,
      level: entry.level,
      // Sanitize before storing — payloads may contain api_key/Bearer/session
      // tokens; users routinely "Export JSON" from the Debug tab to share
      // bug reports, so the stored snapshot must already be clean.
      summary: redactSummary(entry.summary),
      payload: entry.payload === undefined ? undefined : redact(entry.payload),
    };
    this.entries.push(next);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    this.cachedSnapshot = this.entries.slice();
    this.scheduleNotify();
  }

  snapshot(): DebugEntry[] {
    return this.cachedSnapshot;
  }

  clear(): void {
    this.entries = [];
    this.cachedSnapshot = [];
    this.scheduleNotify();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  isPaused(): boolean {
    return this.paused;
  }

  subscribe(listener: (entries: DebugEntry[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private scheduleNotify(): void {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      const snap = this.snapshot();
      for (const cb of this.listeners) {
        try {
          cb(snap);
        } catch {
          // ignore subscriber errors
        }
      }
    });
  }
}

export const debugBus = new DebugBus();
export const DEBUG_BUS_MAX_ENTRIES = MAX_ENTRIES;
