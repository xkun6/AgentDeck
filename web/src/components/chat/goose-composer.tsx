import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useAtomValue } from "jotai";
import { Folder, ImagePlus, Plus, X } from "lucide-react";
import { fileNameFromPath } from "@/lib/composer-prompt";
import {
  composerSubmitShortcutHint,
  shouldSubmitComposerKey,
  type ComposerSubmitShortcut,
} from "@/lib/composer-submit-shortcut";
import { composerSubmitShortcutAtom } from "@/stores/ui";
import {
  normalizeWorkspacePath,
  readWorkspacePath,
  rememberWorkspaceProject,
  writeWorkspacePath,
} from "@/lib/workspaces";
import {
  ComposerAttachmentError,
  type ComposerAttachment,
  type ComposerSlashCommand,
  type ComposerSubmitControls,
  type ComposerSubmitPayload,
} from "./composer-types";
import {
  AttachmentTray,
  attachmentIdentity,
  createFileAttachment,
  createPathAttachment,
  isAttachmentBusy,
  MAX_ATTACHMENT_BYTES,
  revokeAttachmentPreview,
  uniquePaths,
} from "./goose-composer-attachments";
import { SendIcon, StopIcon } from "./goose-composer-icons";
import {
  filterSlashCommands,
  SLASH_MENU_LIMIT,
  SlashCommandMenu,
  slashOptionId,
  slashQueryFromInput,
} from "./slash-command-menu";
import { WorkspacePickerModal } from "@/components/composer/workspace-picker";
import { filesFromClipboardData, imageFileFromClipboardData, readClipboardImageAsFile } from "@/lib/clipboard-image";
import s from "./goose-composer.module.css";

export interface ComposerHint {
  kbd?: string;
  label: string;
}

export function isComposerComposing({
  tracked,
  native,
}: {
  tracked: boolean;
  native: boolean;
}): boolean {
  return tracked || native;
}

interface GooseComposerProps {
  onSend?: (
    payload: ComposerSubmitPayload,
    controls: ComposerSubmitControls,
  ) => void | Promise<void>;
  onStop?: () => void | Promise<void>;
  placeholder?: string;
  initial?: string;
  initialNonce?: number;
  autoFocus?: boolean;
  disabled?: boolean;
  loading?: boolean;
  showMeta?: boolean;
  compact?: boolean;
  /** Remove the lower corner radius when the composer sits flush with a page edge. */
  flushBottom?: boolean;
  /** "big" makes the composer the page hero: shows a header bar (label + char count);
   * textarea is taller. */
  variant?: "default" | "big";
  /** Label shown on the left of the big-variant header bar. Default "新任务". */
  headerLabel?: string;
  /** Empty-state hints shown when the textarea is empty. */
  hints?: ComposerHint[];
  /** Keyboard shortcut for submitting; defaults to the global composer setting. */
  submitShortcut?: ComposerSubmitShortcut;
  loadingPlaceholder?: string;
  onDraftChange?: (text: string) => void;
  initialWorkspacePath?: string;
  /** 工具栏里工作区按钮之后的额外控件（AgentDeck 的 Agent / 模型 / 模式选择器）；
   * 与左侧工具以细分隔线隔开，窄宽度时整体换到第二行。 */
  toolbarExtra?: ReactNode;
  /** 右侧工具区发送 / 中止按钮之前的控件（AgentDeck 的上下文用量指示器）。 */
  toolbarTrailing?: ReactNode;
  /** 工作区变化时回调（宿主据此按 cwd 拉取模型列表等）。 */
  onWorkspaceChange?: (path: string) => void;
  /** 斜杠命令补全候选；不传时输入 `/` 不弹菜单。 */
  slashCommands?: ComposerSlashCommand[];
  /** 斜杠命令菜单打开时回调（宿主可借此刷新命令列表）。 */
  onSlashMenuOpen?: () => void;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "发送失败");
}

export function ComposerErrorMessage({ message }: { message: string }) {
  return (
    <div className={s.errorText}>
      <span>{message}</span>
    </div>
  );
}

export function GooseComposer({
  onSend,
  onStop,
  placeholder,
  initial = "",
  initialNonce = 0,
  autoFocus = false,
  disabled = false,
  loading = false,
  showMeta = true,
  compact = false,
  flushBottom = false,
  variant = "default",
  headerLabel = "新任务",
  loadingPlaceholder,
  hints,
  submitShortcut,
  onDraftChange,
  initialWorkspacePath = "",
  toolbarExtra,
  toolbarTrailing,
  onWorkspaceChange,
  slashCommands,
  onSlashMenuOpen,
}: GooseComposerProps) {
  const configuredSubmitShortcut = useAtomValue(composerSubmitShortcutAtom);
  const effectiveSubmitShortcut = submitShortcut ?? configuredSubmitShortcut;
  const submitHint = composerSubmitShortcutHint(effectiveSubmitShortcut);
  const isBig = variant === "big";
  const [value, setValue] = useState(initial);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [workspacePath, setWorkspacePath] = useState(
    () => normalizeWorkspacePath(initialWorkspacePath) || readWorkspacePath(),
  );
  const onWorkspaceChangeRef = useRef(onWorkspaceChange);
  onWorkspaceChangeRef.current = onWorkspaceChange;
  useEffect(() => {
    onWorkspaceChangeRef.current?.(workspacePath.trim());
  }, [workspacePath]);
  const [submitError, setSubmitError] = useState("");
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const dragDepthRef = useRef(0);
  const hasProcessingAttachment = attachments.some(isAttachmentBusy);
  const controlsDisabled = disabled || loading;
  const submitText = value.trim();
  const displayedTextLength = value.length;
  const canSend =
    (submitText.length > 0 || attachments.length > 0) &&
    !controlsDisabled &&
    !hasProcessingAttachment;
  const resolvedPlaceholder = placeholder ?? `发送消息，${submitHint}…`;

  // ---- 斜杠命令补全 ----
  const slashMenuId = useId();
  const [caret, setCaret] = useState<number | null>(null);
  const [textareaFocused, setTextareaFocused] = useState(false);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const pendingCaretRef = useRef<number | null>(null);
  const slashQuery = slashCommands && textareaFocused && !slashDismissed && caret !== null
    ? slashQueryFromInput(value, caret)
    : null;
  const slashMatches = useMemo(
    () => (slashCommands && slashQuery !== null
      ? filterSlashCommands(slashCommands, slashQuery).slice(0, SLASH_MENU_LIMIT)
      : []),
    [slashCommands, slashQuery],
  );
  const slashMenuOpen = slashMatches.length > 0 && !disabled;
  const slashActive = Math.min(slashActiveIndex, Math.max(0, slashMatches.length - 1));

  useEffect(() => {
    setSlashActiveIndex(0);
  }, [slashQuery]);

  const onSlashMenuOpenRef = useRef(onSlashMenuOpen);
  onSlashMenuOpenRef.current = onSlashMenuOpen;
  useEffect(() => {
    if (slashMenuOpen) onSlashMenuOpenRef.current?.();
  }, [slashMenuOpen]);

  // 补全后把光标放到末尾（受控 value 更新后再设置选区）
  useLayoutEffect(() => {
    const position = pendingCaretRef.current;
    const textarea = textareaRef.current;
    if (position === null || !textarea) return;
    pendingCaretRef.current = null;
    textarea.setSelectionRange(position, position);
  }, [value]);

  const applySlashCommand = (command: ComposerSlashCommand) => {
    const next = `/${command.name} `;
    pendingCaretRef.current = next.length;
    setValue(next);
    setCaret(next.length);
    textareaRef.current?.focus();
  };

  // Make `initial` reactive so external prefill (e.g. quick-start recipes) takes
  // effect after mount. We focus the textarea on non-empty external pushes so
  // the user can keep typing without an extra click.
  useEffect(() => {
    setValue(initial);
    if (initial) {
      window.requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial, initialNonce]);

  useEffect(() => {
    if (autoFocus) {
      textareaRef.current?.focus();
    }
  }, [autoFocus]);

  useEffect(() => {
    const nextPath = normalizeWorkspacePath(initialWorkspacePath);
    if (!nextPath) return;
    setWorkspacePath(nextPath);
    writeWorkspacePath(nextPath);
    rememberWorkspaceProject(nextPath);
  }, [initialWorkspacePath]);

  useEffect(() => {
    onDraftChange?.(value);
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 196)}px`;
  }, [onDraftChange, value]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach(revokeAttachmentPreview);
    };
  }, []);

  useEffect(() => {
    if (!controlsDisabled) return;
    setWorkspacePickerOpen(false);
    setDragActive(false);
    dragDepthRef.current = 0;
  }, [controlsDisabled]);

  const appendAttachmentDrafts = useCallback((drafts: ComposerAttachment[]) => {
    if (!drafts.length) return;
    setAttachments((current) => {
      const existing = new Set(current.map(attachmentIdentity));
      const additions: ComposerAttachment[] = [];
      for (const draft of drafts) {
        const identity = attachmentIdentity(draft);
        if (existing.has(identity)) {
          revokeAttachmentPreview(draft);
          continue;
        }
        existing.add(identity);
        additions.push(draft);
      }
      return additions.length ? [...current, ...additions] : current;
    });
  }, []);

  const addPathAttachments = useCallback((paths: string[]) => {
    const nextPaths = uniquePaths(paths);
    if (!nextPaths.length) return;
    setSubmitError("");
    appendAttachmentDrafts(nextPaths.map((path, index) => createPathAttachment(path, index)));
  }, [appendAttachmentDrafts]);

  const addBrowserFiles = useCallback((files: File[] | FileList) => {
    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const file of Array.from(files)) {
      if (file.size === 0) {
        rejected.push(`${file.name || "未命名文件"} 为空文件`);
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        rejected.push(`${file.name || "未命名文件"} 超过 50 MB`);
        continue;
      }
      accepted.push(file);
    }

    if (rejected.length) {
      setSubmitError(rejected.slice(0, 2).join("；"));
    } else {
      setSubmitError("");
    }
    appendAttachmentDrafts(accepted.map((file, index) => createFileAttachment(file, index)));
  }, [appendAttachmentDrafts]);

  useEffect(() => {
    const onFileDrop = window.hermesDesktop?.onFileDrop;
    if (!onFileDrop) return;

    return onFileDrop((payload) => {
      if (payload.phase === "leave") {
        dragDepthRef.current = 0;
        setDragActive(false);
        return;
      }

      if (controlsDisabled) {
        dragDepthRef.current = 0;
        setDragActive(false);
        return;
      }

      if (payload.phase === "enter" || payload.phase === "over") {
        setDragActive(true);
        return;
      }

      if (payload.phase === "drop") {
        dragDepthRef.current = 0;
        setDragActive(false);
        if (payload.paths.length) {
          addPathAttachments(payload.paths);
        } else {
          setSubmitError("未能读取拖拽文件路径，请使用 + 按钮添加附件。");
        }
      }
    });
  }, [addPathAttachments, controlsDisabled]);

  const pickFiles = async () => {
    if (controlsDisabled) return;
    setSubmitError("");
    try {
      if (window.hermesDesktop?.pickFiles) {
        const result = await window.hermesDesktop.pickFiles();
        if (!result.canceled) addPathAttachments(result.paths);
        return;
      }
      fileInputRef.current?.click();
    } catch (error) {
      setSubmitError(messageFromError(error));
    }
  };

  const handleFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (!controlsDisabled && event.target.files) {
      addBrowserFiles(event.target.files);
    }
    event.target.value = "";
  };

  const attachClipboardImage = async () => {
    if (controlsDisabled) return;
    setSubmitError("");
    try {
      const file = await readClipboardImageAsFile();
      if (!file) {
        setSubmitError("剪贴板中没有可读取的图片。");
        return;
      }
      addBrowserFiles([file]);
    } catch (error) {
      setSubmitError(messageFromError(error));
    }
  };

  const applyWorkspacePath = (path: string) => {
    const nextPath = normalizeWorkspacePath(path);
    if (!nextPath) return;
    setWorkspacePath(nextPath);
    writeWorkspacePath(nextPath);
    rememberWorkspaceProject(nextPath);
  };

  const clearWorkspacePath = () => {
    if (controlsDisabled) return;
    setSubmitError("");
    setWorkspacePath("");
    writeWorkspacePath("");
    setWorkspacePickerOpen(false);
  };

  const pickWorkspace = async () => {
    if (controlsDisabled) return;
    setSubmitError("");
    try {
      if (window.hermesDesktop?.pickDirectory) {
        const result = await window.hermesDesktop.pickDirectory();
        if (!result.canceled) applyWorkspacePath(result.paths[0] ?? "");
        return;
      }
      setWorkspacePickerOpen(true);
    } catch (error) {
      setSubmitError(messageFromError(error));
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((current) => {
      const target = current.find((item) => item.id === id);
      if (target) revokeAttachmentPreview(target);
      return current.filter((item) => item.id !== id);
    });
  };

  const markAttachmentsProcessing = () => {
    setAttachments((current) =>
      current.map((item) => ({
        ...item,
        status: isAttachmentBusy(item) ? item.status : "processing",
        error: undefined,
        progress: item.status === "uploading" ? item.progress : undefined,
      })),
    );
  };

  const restoreAttachmentState = (error: unknown) => {
    const message = messageFromError(error);
    if (error instanceof ComposerAttachmentError && error.attachmentId) {
      setAttachments((current) =>
        current.map((item) =>
          item.id === error.attachmentId
            ? { ...item, status: "error", error: message }
            : { ...item, status: "ready", error: undefined, progress: undefined },
        ),
      );
      setSubmitError(message);
      return;
    }

    setAttachments((current) =>
      current.map((item) => ({ ...item, status: "ready", error: undefined, progress: undefined })),
    );
    setSubmitError(message);
  };

  const updateAttachment: ComposerSubmitControls["updateAttachment"] = (id, patch) => {
    setAttachments((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  };

  const send = async () => {
    if (!canSend) return;
    const payload: ComposerSubmitPayload = {
      text: submitText,
      attachments,
      workspacePath: workspacePath.trim() || undefined,
    };

    setSubmitError("");
    markAttachmentsProcessing();
    try {
      await onSend?.(payload, { updateAttachment });
      onDraftChange?.("");
      setValue("");
      setAttachments((current) => {
        current.forEach(revokeAttachmentPreview);
        return [];
      });
    } catch (error) {
      restoreAttachmentState(error);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const isComposing = isComposerComposing({
      tracked: composingRef.current,
      native: event.nativeEvent.isComposing,
    });
    if (isComposing) return;

    if (slashMenuOpen) {
      const count = slashMatches.length;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setSlashActiveIndex((slashActive + step + count) % count);
        return;
      }
      if ((event.key === "Tab" || event.key === "Enter") && !event.shiftKey) {
        // 菜单打开时 Enter / Tab 只补全，不发送
        event.preventDefault();
        const command = slashMatches[slashActive];
        if (command) applySlashCommand(command);
        return;
      }
      if (event.key === "Escape") {
        // 阻止冒泡，避免关掉外层弹层
        event.preventDefault();
        event.stopPropagation();
        setSlashDismissed(true);
        return;
      }
    }

    const shouldSubmit = shouldSubmitComposerKey({
      key: event.key,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      isComposing,
    }, effectiveSubmitShortcut);

    if (shouldSubmit) {
      event.preventDefault();
      void send();
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (controlsDisabled) return;
    const clipboardData = event.clipboardData;
    const text = clipboardData.getData("text/plain");
    const pastedFiles = filesFromClipboardData(clipboardData);
    if (pastedFiles.length) {
      event.preventDefault();
      addBrowserFiles(pastedFiles);
      return;
    }
    const pastedImage = imageFileFromClipboardData(clipboardData);
    if (pastedImage) {
      event.preventDefault();
      addBrowserFiles([pastedImage]);
      return;
    }
    if (!text) {
      event.preventDefault();
      void readClipboardImageAsFile(null).then((file) => {
        if (!file) return;
        addBrowserFiles([file]);
      });
      return;
    }
  };

  const hasDroppableData = (event: DragEvent<HTMLDivElement>): boolean => {
    const types = Array.from(event.dataTransfer.types);
    return types.includes("Files") || types.includes("text/plain") || types.includes("text/uri-list");
  };

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (controlsDisabled || !hasDroppableData(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!dragActive) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setDragActive(false);
    }
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (controlsDisabled || !hasDroppableData(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    if (controlsDisabled) return;

    const paths: string[] = [];
    const text = event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain");
    if (text) paths.push(...text.split(/\r?\n/));
    for (const file of Array.from(event.dataTransfer.files)) {
      const path = (file as File & { path?: string }).path;
      if (path) paths.push(path);
    }

    if (paths.length) {
      addPathAttachments(paths);
    } else {
      addBrowserFiles(event.dataTransfer.files);
    }
  };

  return (
    <div className={s.wrapper} data-compact={compact} data-variant={variant}>
      <div
        className={s.box}
        data-disabled={disabled}
        data-drag-active={dragActive}
        data-flush-bottom={flushBottom}
        data-variant={variant}
        onDrop={handleDrop}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className={s.hiddenFileInput}
          onChange={handleFileInputChange}
          tabIndex={-1}
        />
        {dragActive ? <div className={s.dropOverlay}>释放以添加到当前消息</div> : null}
        {slashMenuOpen ? (
          <SlashCommandMenu
            id={slashMenuId}
            commands={slashMatches}
            activeIndex={slashActive}
            onSelect={applySlashCommand}
            onActiveIndexChange={setSlashActiveIndex}
          />
        ) : null}

        {isBig ? (
          <div className={s.bigHeader}>
            <span className={s.bigHeaderLabel}>
              <span className={s.bigHeaderDot} aria-hidden="true" />
              {headerLabel}
            </span>
            <span className={s.bigHeaderRight}>
              <span className={s.bigHeaderChars}>{displayedTextLength} 字</span>
            </span>
          </div>
        ) : null}

        <AttachmentTray attachments={attachments} onRemove={removeAttachment} />

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setCaret(event.target.selectionStart);
            setSlashDismissed(false);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onFocus={(event) => {
            setTextareaFocused(true);
            setCaret(event.currentTarget.selectionStart);
          }}
          onBlur={() => setTextareaFocused(false)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { setTimeout(() => { composingRef.current = false; }, 0); }}
          placeholder={loading ? (loadingPlaceholder || "Agent 正在响应…") : resolvedPlaceholder}
          rows={1}
          className={s.textarea}
          disabled={disabled}
          aria-label="输入消息"
          aria-autocomplete={slashCommands ? "list" : undefined}
          aria-controls={slashMenuOpen ? slashMenuId : undefined}
          aria-activedescendant={slashMenuOpen ? slashOptionId(slashMenuId, slashActive) : undefined}
        />

        {hints && hints.length > 0 && value.length === 0 ? (
          <div className={s.hintRow}>
            {hints.map((hint, idx) => (
              <span key={`${hint.label}-${idx}`} className={s.hintItem}>
                {hint.kbd ? <span className={s.hintKbd}>{hint.kbd}</span> : null}
                {hint.label}
              </span>
            ))}
          </div>
        ) : null}

        {submitError ? <ComposerErrorMessage message={submitError} /> : null}

        <div className={s.toolbar}>
          <div className={s.leftTools}>
            <button
              className={s.iconButton}
              type="button"
              onClick={() => void pickFiles()}
              disabled={controlsDisabled}
              title="添加附件"
              aria-label="添加附件"
            >
              <Plus className={s.toolIcon} aria-hidden="true" />
            </button>
            <button
              className={s.iconButton}
              type="button"
              onClick={() => void attachClipboardImage()}
              disabled={controlsDisabled}
              title="添加剪贴板图片"
              aria-label="添加剪贴板图片"
            >
              <ImagePlus className={s.toolIcon} aria-hidden="true" />
            </button>
            <button
              className={s.toolButton}
              type="button"
              onClick={() => void pickWorkspace()}
              disabled={controlsDisabled}
              data-active={Boolean(workspacePath)}
              title={workspacePath ? `工作区：${workspacePath}` : "选择工作区"}
              aria-label={workspacePath ? `工作区：${workspacePath}` : "选择工作区"}
            >
              <Folder className={s.toolIcon} aria-hidden="true" />
              <span>{workspacePath ? fileNameFromPath(workspacePath) : "工作区"}</span>
            </button>
            {workspacePath ? (
              <button
                className={s.workspaceClearButton}
                type="button"
                onClick={clearWorkspacePath}
                disabled={controlsDisabled}
                title="不指定默认工作区"
                aria-label={`不指定默认工作区：${workspacePath}`}
              >
                <X aria-hidden="true" />
              </button>
            ) : null}
            {showMeta && <span className={s.pill}>本地模式</span>}
          </div>

          {toolbarExtra ? (
            <>
              <span className={s.toolbarDivider} aria-hidden="true" />
              <div className={s.toolbarExtra}>{toolbarExtra}</div>
            </>
          ) : null}

          <div className={s.rightTools}>
            {toolbarTrailing}
            {loading ? <span className={s.liveDot} aria-hidden="true" /> : null}
            {loading && onStop ? (
              <button
                className={s.sendButton}
                type="button"
                data-mode="stop"
                onClick={() => void onStop()}
                disabled={disabled}
                aria-label="中止响应"
                title="中止响应"
              >
                <StopIcon />
              </button>
            ) : (
              <button
                className={s.sendButton}
                type="button"
                data-ready={canSend}
                onClick={() => void send()}
                disabled={!canSend}
                aria-label="发送消息"
                title={`发送消息（${submitHint}）`}
              >
                <SendIcon />
                <span>发送</span>
              </button>
            )}
          </div>
        </div>
      </div>
      {workspacePickerOpen ? (
        <WorkspacePickerModal
          open
          initialPath={workspacePath}
          onCancel={() => setWorkspacePickerOpen(false)}
          onConfirm={(path) => {
            setWorkspacePickerOpen(false);
            applyWorkspacePath(path);
          }}
        />
      ) : null}
    </div>
  );
}
