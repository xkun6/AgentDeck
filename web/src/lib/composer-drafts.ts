import { readUiValue, removeUiValue, writeUiValue } from "@/lib/ui-store";

const STORAGE_KEY_PREFIX = "agentdeck-cn-ui.composerDraft";

export type ComposerDraftTarget =
  | { kind: "new"; profile?: string | null }
  | { kind: "session"; sessionId?: string | null; profile?: string | null };

function cleanPart(value: string | null | undefined, fallback: string): string {
  const text = (value ?? "").trim();
  return encodeURIComponent(text || fallback);
}

export function composerDraftStorageKey(target: ComposerDraftTarget | null | undefined): string | null {
  if (!target) return null;
  const profile = cleanPart(target.profile, "default");
  if (target.kind === "new") {
    return [STORAGE_KEY_PREFIX, profile, "new"].join(":");
  }

  const sessionId = (target.sessionId ?? "").trim();
  if (!sessionId) return null;
  return [
    STORAGE_KEY_PREFIX,
    profile,
    "session",
    encodeURIComponent(sessionId),
  ].join(":");
}

export function readComposerDraftByKey(key: string | null | undefined): string {
  if (!key) return "";
  const value = readUiValue<unknown>(key, "");
  return typeof value === "string" ? value : "";
}

export function writeComposerDraftByKey(key: string | null | undefined, text: string): void {
  if (!key) return;
  if (!text.trim()) {
    removeUiValue(key);
    return;
  }
  writeUiValue(key, text);
}

export function forgetComposerDraftByKey(key: string | null | undefined): void {
  if (!key) return;
  removeUiValue(key);
}

export function readComposerDraft(target: ComposerDraftTarget | null | undefined): string {
  return readComposerDraftByKey(composerDraftStorageKey(target));
}

export function writeComposerDraft(target: ComposerDraftTarget | null | undefined, text: string): void {
  writeComposerDraftByKey(composerDraftStorageKey(target), text);
}
