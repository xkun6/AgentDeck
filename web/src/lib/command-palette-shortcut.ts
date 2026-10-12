import { detectHostOS, type HostOS } from "./runtime";

export interface CommandPaletteShortcutEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
}

export function isCommandPaletteShortcut(event: CommandPaletteShortcutEvent): boolean {
  if (event.isComposing) return false;
  if (event.key.toLowerCase() !== "k") return false;
  if (event.altKey || event.shiftKey) return false;
  return Boolean(event.metaKey || event.ctrlKey);
}

/** 顶栏搜索框里的快捷键提示：macOS 为 ⌘K，其余平台为 Ctrl K。 */
export function commandPaletteShortcutLabel(os: HostOS = detectHostOS()): string {
  return os === "macos" ? "⌘K" : "Ctrl K";
}
