import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { LoadingState } from "@agentdeck/shared-ui";
import { ArrowUp, Folder, X } from "lucide-react";
import type { FsEntry } from "@agentdeck/protocol";
import { useFsList } from "@/hooks/use-fs-list";
import { buildBreadcrumbs, parentDir } from "@/lib/preview-rail";
import s from "./workspace-picker-modal.module.css";

interface WorkspacePickerModalProps {
  open: boolean;
  initialPath?: string;
  onConfirm(absPath: string): void;
  onCancel(): void;
}

function prettyFsError(err: unknown): string {
  if (!(err instanceof Error)) return "无法读取目录";
  const match = err.message.match(/^HTTP \d+: (.+)$/);
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed && typeof parsed === "object" && typeof parsed.detail === "string") {
        return parsed.detail;
      }
    } catch {
      // body wasn't JSON; fall through
    }
    return match[1];
  }
  return err.message;
}

const DRIVE_LIST_LABEL = "此电脑";

function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path);
}

/** Windows 盘符根目录（`C:\`）：fs_list 返回的 parent 为 null，「上一级」回到盘符列表。 */
function isWindowsDriveRoot(path: string): boolean {
  return /^[A-Za-z]:[\\/]?$/.test(path.trim());
}

/**
 * 「上一级」的目标：优先用 fs_list 返回的 parent；Windows 盘符根目录回到盘符列表（空字符串）；
 * 读取失败（无 parent）时按路径推导；盘符列表与 POSIX 根目录没有上一级（null）。
 */
export function workspaceParentTarget(path: string, parent: string | null | undefined): string | null {
  if (parent) return parent;
  if (!path) return null;
  if (isWindowsDriveRoot(path)) return "";
  return parentDir(path);
}

/** `~` 开头的手动输入按主目录展开（fs_list 不认 `~`）。 */
export function expandHomePath(input: string, home: string): string {
  if (!home || !input.startsWith("~")) return input;
  if (input === "~") return home;
  if (input.startsWith("~/") || input.startsWith("~\\")) return `${home}${input.slice(1)}`;
  return input;
}

export function splitBreadcrumb(
  absPath: string,
  home: string,
): Array<{ label: string; path: string }> {
  // Windows：「此电脑」（盘符列表）+ 盘符 + 各级目录
  if (absPath === "" && isWindowsPath(home)) return [{ label: DRIVE_LIST_LABEL, path: "" }];
  if (isWindowsPath(absPath)) {
    return [{ label: DRIVE_LIST_LABEL, path: "" }, ...buildBreadcrumbs(absPath)];
  }
  if (!home) {
    return absPath ? [{ label: absPath, path: absPath }] : [];
  }
  const root = { label: "~", path: home };
  if (!absPath || absPath === home) return [root];
  if (!absPath.startsWith(`${home}/`)) {
    // Path outside home (error case). Keep ~ as a "back to home" anchor so the user can recover.
    return [root, { label: absPath, path: absPath }];
  }
  const rel = absPath.slice(home.length + 1);
  const segments = rel.split("/").filter(Boolean);
  const out = [root];
  let acc = home;
  for (const seg of segments) {
    acc += `/${seg}`;
    out.push({ label: seg, path: acc });
  }
  return out;
}

export function WorkspacePickerModal({
  open,
  initialPath,
  onConfirm,
  onCancel,
}: WorkspacePickerModalProps) {
  const titleId = useId();
  const modalRef = useRef<HTMLDivElement>(null);
  const manualInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // null = 用户主目录；Windows 下空字符串 = 盘符列表
  const [currentPath, setCurrentPath] = useState<string | null>(initialPath?.trim() || null);
  const [manualInput, setManualInput] = useState("");
  const [selectedName, setSelectedName] = useState<string | null>(null);

  const query = useFsList(currentPath, { enabled: open });
  const data = query.data;
  const directoryEntries = useMemo<FsEntry[]>(
    () => (data?.entries ?? []).filter((e) => e.is_dir),
    [data],
  );

  const resolvedPath = data?.path ?? currentPath ?? "";
  const parentPath = workspaceParentTarget(resolvedPath, data?.parent);
  const [lastKnownHome, setLastKnownHome] = useState("");
  const home = data?.home ?? lastKnownHome;
  const breadcrumb = useMemo(() => splitBreadcrumb(resolvedPath, home), [resolvedPath, home]);

  // After first fetch, normalize state so breadcrumb / footer immediately reflect the resolved abs path.
  useEffect(() => {
    if (data?.path !== undefined && data.path !== currentPath) {
      setCurrentPath(data.path);
    }
  }, [data?.path, currentPath]);

  // Cache home so we can still render a "back to ~" breadcrumb even when the
  // current query errors out (e.g. user pasted /etc).
  useEffect(() => {
    if (data?.home && data.home !== lastKnownHome) {
      setLastKnownHome(data.home);
    }
  }, [data?.home, lastKnownHome]);

  // Reset selection when directory changes.
  useEffect(() => {
    setSelectedName(null);
  }, [resolvedPath]);

  const navigateTo = useCallback((next: string) => {
    setCurrentPath(next);
  }, []);

  const handleConfirm = useCallback(() => {
    if (!resolvedPath) return;
    onConfirm(resolvedPath);
  }, [onConfirm, resolvedPath]);

  const handleManualSubmit = useCallback(() => {
    const next = manualInput.trim();
    if (!next) return;
    setCurrentPath(expandHomePath(next, home));
    setManualInput("");
  }, [home, manualInput]);

  const handleManualKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      handleManualSubmit();
    }
  };

  const moveSelection = useCallback((delta: 1 | -1) => {
    if (!directoryEntries.length) return;
    setSelectedName((current) => {
      const idx = current ? directoryEntries.findIndex((e) => e.name === current) : -1;
      const next = idx === -1
        ? (delta === 1 ? 0 : directoryEntries.length - 1)
        : (idx + delta + directoryEntries.length) % directoryEntries.length;
      const target = directoryEntries[next];
      if (target && listRef.current) {
        const el = listRef.current.querySelector<HTMLButtonElement>(
          `[data-entry-name="${CSS.escape(target.name)}"]`,
        );
        el?.scrollIntoView({ block: "nearest" });
      }
      return target?.name ?? null;
    });
  }, [directoryEntries]);

  // Modal lifecycle: focus trap, body lock, keyboard.
  useEffect(() => {
    if (!open) return undefined;
    const previousActiveElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusTimer = window.requestAnimationFrame(() => {
      manualInputRef.current?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      const focusInsideManualInput = document.activeElement === manualInputRef.current;
      if (event.key === "ArrowDown" && !focusInsideManualInput) {
        event.preventDefault();
        moveSelection(1);
        return;
      }
      if (event.key === "ArrowUp" && !focusInsideManualInput) {
        event.preventDefault();
        moveSelection(-1);
        return;
      }
      if (event.key === "Enter" && !focusInsideManualInput) {
        if (selectedName) {
          const target = directoryEntries.find((e) => e.name === selectedName);
          if (target) {
            event.preventDefault();
            navigateTo(target.path);
            return;
          }
        }
        event.preventDefault();
        handleConfirm();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        modalRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusTimer);
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousActiveElement?.focus();
    };
  }, [
    open,
    onCancel,
    moveSelection,
    selectedName,
    directoryEntries,
    navigateTo,
    handleConfirm,
  ]);

  if (!open || typeof document === "undefined") return null;

  const errorText = data?.error ?? (query.isError ? prettyFsError(query.error) : null);
  const isInitialLoad = query.isPending;

  return createPortal(
    <div
      className={s.wpBackdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={modalRef}
        className={s.wpModal}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className={s.wpTitleBar}>
          <h2 id={titleId}>选择工作区目录</h2>
          <button
            type="button"
            className={s.wpClose}
            onClick={onCancel}
            aria-label="关闭目录选择"
          >
            <X aria-hidden="true" />
          </button>
        </div>

        <div className={s.wpManualRow}>
          <input
            ref={manualInputRef}
            type="text"
            className={s.wpManualInput}
            placeholder="粘贴目录路径，回车跳转（如 ~/projects/foo）"
            value={manualInput}
            onChange={(event) => setManualInput(event.target.value)}
            onKeyDown={handleManualKey}
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="button"
            className={s.wpManualGo}
            onClick={handleManualSubmit}
            disabled={!manualInput.trim()}
          >
            跳转
          </button>
        </div>

        <div className={s.wpBreadcrumbRow}>
          <button
            type="button"
            className={s.wpUpButton}
            onClick={() => parentPath !== null && navigateTo(parentPath)}
            disabled={parentPath === null}
            aria-label="上一级"
            title="上一级"
          >
            <ArrowUp aria-hidden="true" />
          </button>
          <div className={s.wpBreadcrumb}>
            {breadcrumb.map((crumb, idx) => (
              <span key={crumb.path} className={s.wpCrumbWrap}>
                <button
                  type="button"
                  className={s.wpCrumb}
                  data-current={crumb.path === resolvedPath}
                  onClick={() => navigateTo(crumb.path)}
                >
                  {crumb.label}
                </button>
                {idx < breadcrumb.length - 1 ? <span className={s.wpCrumbSep}>/</span> : null}
              </span>
            ))}
          </div>
        </div>

        <div ref={listRef} className={s.wpList}>
          {isInitialLoad ? (
            <LoadingState variant="block" label="正在加载目录…" />
          ) : errorText ? (
            <div className={s.wpError}>{errorText}</div>
          ) : directoryEntries.length === 0 ? (
            <div className={s.wpEmpty}>没有子目录</div>
          ) : (
            directoryEntries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className={s.wpEntry}
                data-entry-name={entry.name}
                data-selected={selectedName === entry.name}
                onClick={() => setSelectedName(entry.name)}
                onDoubleClick={() => navigateTo(entry.path)}
              >
                <Folder className={s.wpEntryIcon} aria-hidden="true" />
                <span className={s.wpEntryName}>{entry.name}</span>
              </button>
            ))
          )}
        </div>

        <div className={s.wpFooter}>
          <div className={s.wpFooterPath} title={resolvedPath}>
            {resolvedPath || "—"}
          </div>
          <div className={s.wpFooterButtons}>
            <button type="button" className={s.wpButtonGhost} onClick={onCancel}>
              取消
            </button>
            <button
              type="button"
              className={s.wpButtonPrimary}
              onClick={handleConfirm}
              disabled={!resolvedPath || query.isPending}
            >
              选择此目录
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
