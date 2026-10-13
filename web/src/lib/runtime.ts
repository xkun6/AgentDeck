import type {
  CodingAgentPaths,
  CodingAgentsCheckResult,
  DebugPaths,
  EnvironmentCheckResult,
  EnvironmentInstallResult,
  ExportDebugBundleInput,
  ExportDebugBundleResult,
  ExportLogSnapshotInput,
  ExportLogSnapshotResult,
  LogTailResult,
} from "@agentdeck/protocol";
import type { SidecarStatusPayload } from "./sidecar-client";
import type { UiEventInput, UiStoreSnapshot, UiTurnStats } from "./ui-store";

export type { UiEventInput, UiStoreSnapshot, UiTurnStats } from "./ui-store";

export type RuntimePlatform = "web" | "electron" | "tauri";
export type HostOS = "macos" | "windows" | "linux" | "unknown";

export interface ExternalRequestResult {
  ok: boolean;
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body: string;
}

export interface FilePickerResult {
  canceled: boolean;
  paths: string[];
}

export interface SimpleResult {
  ok: boolean;
  message?: string | null;
}

export interface DesktopNotifyInput {
  kind: "approval" | "complete" | "error" | "test";
  title: string;
  body: string;
  /** 设置「系统通知」开关；false 时仅做焦点判定与注意力请求。 */
  showSystemNotification: boolean;
  /** 系统通知自带的原生提示音。 */
  withSound: boolean;
  /** 「仅窗口在后台时通知」；测试按钮传 false。 */
  respectFocus: boolean;
  requestAttention: boolean;
}

export interface DesktopNotifyResult {
  /** 系统通知已实际发出。 */
  delivered: boolean;
  /** 调用时主窗口是否在前台。 */
  focused: boolean;
  attentionRequested: boolean;
  /** 系统通知发送失败原因（非致命）。 */
  error?: string;
}

export interface TerminalStartInput {
  cwd?: string;
  cols?: number;
  rows?: number;
  initialInput?: string;
}

export interface TerminalOpenExternalInput {
  cwd?: string;
}

export interface TerminalStartResult {
  terminalId: string;
  cwd: string;
  shell: string;
}

export interface ExternalTerminalResult {
  ok: boolean;
  terminal: string;
  cwd: string;
  command: string;
}

export interface TerminalEventPayload {
  terminalId: string;
  kind: "data" | "exit" | "error";
  data?: string;
  exitCode?: number | null;
  message?: string | null;
}

// Right-rail rich preview (issue #233). Mirrors the Rust commands in
// src/commands/preview.rs and the upstream Electron preload API.
export interface ReadWorkspaceFileInput {
  /** Absolute path, or relative to `root`. Must resolve inside `root`. */
  path: string;
  /** Session workspace root; reads are confined to this directory. */
  root: string;
}

export interface FilePreview {
  /** UTF-8 text content, when the file is textual. */
  text?: string;
  /** `data:<mime>;base64,...` for previewable images. */
  dataUrl?: string;
  /** Full size on disk in bytes. */
  byteSize: number;
  /** True when the content is binary (no text preview). */
  binary: boolean;
  /** True when `text` was cut at the 512 KB cap. */
  truncated: boolean;
  /**
   * True when the on-disk bytes were not valid UTF-8 and `text` is a lossy
   * (�-substituted) rendering — display-only, never editable (writing it back
   * as UTF-8 would corrupt the original encoding). Optional so older bridges
   * that don't report it stay compatible.
   */
  lossyUtf8?: boolean;
}

export interface WriteWorkspaceFileInput {
  /** Absolute path, or relative to `root`. Must resolve inside `root`. */
  path: string;
  /** Session workspace root; writes are confined to this directory. */
  root: string;
  /** New UTF-8 file content. */
  content: string;
}

export interface WriteWorkspaceFileResult {
  /** Canonical path actually written. */
  path: string;
}

export interface WatchPreviewFileResult {
  watchId: string;
}

export interface PreviewFileChangedPayload {
  watchId: string;
  path: string;
}

export interface DesktopFileDropPayload {
  phase: "enter" | "over" | "drop" | "leave";
  paths: string[];
  position?: {
    x: number;
    y: number;
  };
}

// ── Git review pane (issue #328) ─────────────────────────────────────────────

export type ReviewScope = "uncommitted" | "branch" | "lastTurn";

export interface ReviewFile {
  path: string;
  added: number;
  removed: number;
  /** Single-letter git status (`M`/`A`/`D`/`R`/`?` …). */
  status: string;
  staged: boolean;
}

export interface ReviewList {
  files: ReviewFile[];
  /** merge-base for `branch` scope, else null. */
  base: string | null;
  /** Whether the path is inside a git work tree (backend `rev-parse` verdict). */
  isRepo: boolean;
}

export interface ReviewPrInfo {
  url: string;
  state: string;
  number: number;
}

export interface ReviewShipInfo {
  /** gh is installed AND authenticated (the PR action can run). */
  ghReady: boolean;
  pr: ReviewPrInfo | null;
}

/** Bridge to the Rust git commands backing the review pane. Reads degrade to
 *  empty/null on a non-repo / missing tool; mutations reject so the UI can toast. */
export interface AgentGitReviewBridge {
  list(input: { repoPath: string; scope: ReviewScope; baseRef: string | null }): Promise<ReviewList>;
  diff(input: {
    repoPath: string;
    filePath: string;
    scope: ReviewScope;
    baseRef: string | null;
    staged: boolean;
  }): Promise<string>;
  stage(input: { repoPath: string; filePath: string | null }): Promise<{ ok: boolean }>;
  unstage(input: { repoPath: string; filePath: string | null }): Promise<{ ok: boolean }>;
  revert(input: { repoPath: string; filePath: string | null }): Promise<{ ok: boolean }>;
  commit(input: { repoPath: string; message: string; push: boolean }): Promise<{ ok: boolean }>;
  push(input: { repoPath: string }): Promise<{ ok: boolean }>;
  shipInfo(input: { repoPath: string }): Promise<ReviewShipInfo>;
  createPr(input: { repoPath: string }): Promise<{ url: string }>;
}

// ── Worktree / branch / status (issue #327) ──────────────────────────────────

export interface Worktree {
  path: string;
  branch: string | null;
  isMain: boolean;
  detached: boolean;
  locked: boolean;
}

export interface WorktreeAddResult {
  path: string;
  branch: string;
  repoRoot: string;
}

export interface GitBranch {
  name: string;
  checkedOut: boolean;
  isDefault: boolean;
  worktreePath: string | null;
}

export interface RepoStatus {
  branch: string | null;
  defaultBranch: string | null;
  detached: boolean;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  changed: number;
  added: number;
  removed: number;
}

export interface AgentGitWorktreeBridge {
  list(input: { repoPath: string }): Promise<Worktree[]>;
  add(input: {
    repoPath: string;
    name?: string | null;
    branch?: string | null;
    base?: string | null;
    existingBranch?: string | null;
  }): Promise<WorktreeAddResult>;
  remove(input: { repoPath: string; worktreePath: string; force?: boolean }): Promise<{
    removed: string;
  }>;
}

export interface AgentGitBranchBridge {
  list(input: { repoPath: string }): Promise<GitBranch[]>;
  switch(input: { repoPath: string; branch: string }): Promise<{ branch: string }>;
}

export interface AgentGitBridge {
  review: AgentGitReviewBridge;
  worktree: AgentGitWorktreeBridge;
  branch: AgentGitBranchBridge;
  repoStatus(input: { repoPath: string }): Promise<RepoStatus | null>;
}

/** Rust `fs_list` 命令的入参与返回（docs/design.md 4.6）。 */
export interface FsListInput {
  /** 缺省列主目录；Windows 下空字符串列盘符（非 Windows 列 `/`）。 */
  path?: string;
  showHidden?: boolean;
}

export interface FsListResult {
  path: string;
  parent: string | null;
  home: string;
  entries: { name: string; path: string; isDir: boolean }[];
  /** 读取失败（不存在 / 无权限）时的中文说明，此时 entries 为空 */
  error?: string;
}

/** 自绘标题栏的窗口控制（仅无原生标题栏的 Windows / Linux 主窗口由 tauri-bridge 挂载）。 */
export interface DesktopWindowControls {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  /** 走 CloseRequested，与原生关闭按钮一致（托盘可用时隐藏到托盘）。 */
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  /** 窗口尺寸变化（含最大化 / 还原）时回调；返回取消订阅函数。 */
  onResized(handler: () => void): () => void;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    /** 启动时由 main.tsx / tauri-bridge 写入的运行环境信息。 */
    __AGENTDECK_RUNTIME__?: {
      platform?: RuntimePlatform;
    };
    /** Tauri 下由 lib/tauri-bridge.ts 挂载的本地能力桥（字段名沿用历史命名）。 */
    agentdeckDesktop?: {
      windowType: "electron" | "tauri";
      /** Fatal compatibility/error dialog + force-quit the app. */
      pickFiles?(): Promise<FilePickerResult>;
      pickDirectory?(): Promise<FilePickerResult>;
      /** 选择单个可执行文件（Windows 过滤 .exe / .cmd） */
      pickExecutableFile?(input?: { title?: string }): Promise<FilePickerResult>;
      openWorkspacePath?(input: { path: string }): Promise<ExternalRequestResult>;
      openExternalUrl?(input: { url: string }): Promise<SimpleResult>;
      toggleDevtools?(): Promise<void>;
      exportLogSnapshot?(input: ExportLogSnapshotInput): Promise<ExportLogSnapshotResult>;
      /** Debug 面板（design.md 4.18）：sidecar 日志尾部、目录、诊断包导出、sidecar 状态与重启。 */
      logTail?(input?: { maxBytes?: number }): Promise<LogTailResult>;
      debugPaths?(): Promise<DebugPaths>;
      exportDebugBundle?(input: ExportDebugBundleInput): Promise<ExportDebugBundleResult>;
      sidecarStatus?(): Promise<SidecarStatusPayload>;
      restartSidecar?(): Promise<SidecarStatusPayload>;
      environmentCheck?(): Promise<EnvironmentCheckResult>;
      /** 一键安装缺失工具（Rust environment_install；只传检测项 id，命令由 Rust 白名单决定） */
      environmentInstall?(id: string): Promise<EnvironmentInstallResult>;
      codingAgentsCheck?(): Promise<CodingAgentsCheckResult>;
      /** 「编程 Agent」页配置的 Claude / Codex 可执行文件路径（Rust coding_agent_paths_get / set） */
      codingAgentPathsGet?(): Promise<CodingAgentPaths>;
      codingAgentPathsSet?(paths: CodingAgentPaths): Promise<CodingAgentPaths>;
      uiStoreSnapshot?(): Promise<UiStoreSnapshot>;
      uiStoreSetKv?(input: { key: string; value: unknown }): Promise<boolean>;
      uiStoreRemoveKv?(input: { key: string }): Promise<boolean>;
      uiStoreRecordTurnStats?(input: UiTurnStats): Promise<boolean>;
      uiStoreGetTurnStats?(input: { sessionId: string }): Promise<UiTurnStats[]>;
      uiStoreGetTurnStatsWindow?(input: { sinceMs?: number; limit?: number }): Promise<UiTurnStats[]>;
      uiStoreRecordEvent?(input: UiEventInput): Promise<boolean>;
      desktopNotify?(input: DesktopNotifyInput): Promise<DesktopNotifyResult>;
      terminalStart?(input: TerminalStartInput): Promise<TerminalStartResult>;
      terminalOpenExternal?(input: TerminalOpenExternalInput): Promise<ExternalTerminalResult>;
      terminalWrite?(input: { terminalId: string; data: string }): Promise<boolean>;
      terminalResize?(input: { terminalId: string; cols: number; rows: number }): Promise<boolean>;
      terminalClose?(input: { terminalId: string }): Promise<boolean>;
      onTerminalOutput?(handler: (event: TerminalEventPayload) => void): () => void;
      readFileDataUrl?(path: string): Promise<string>;
      readWorkspaceFile?(input: ReadWorkspaceFileInput): Promise<FilePreview>;
      /** 本地目录列表（Rust `fs_list`）。 */
      fsList?(input: FsListInput): Promise<FsListResult>;
      writeWorkspaceFile?(input: WriteWorkspaceFileInput): Promise<WriteWorkspaceFileResult>;
      /** Git ops backing the review pane (issue #328). */
      git?: AgentGitBridge;
      watchPreviewFile?(input: { path: string }): Promise<WatchPreviewFileResult>;
      stopPreviewFileWatch?(input: { watchId: string }): Promise<boolean>;
      onPreviewFileChanged?(handler: (payload: PreviewFileChangedPayload) => void): () => void;
      onFileDrop?(handler: (payload: DesktopFileDropPayload) => void): () => void;
      onSystemResume?(handler: () => void): () => void;
      /** Native webview page zoom (reflows layout + viewport) for the interface
       *  scale setting. Fire-and-forget; far better than CSS `zoom`, which leaves
       *  viewport units un-scaled and overflows the fixed window. */
      setUiZoom?(factor: number): void;
      /** 主窗口无原生标题栏时才存在（macOS 保留原生红绿灯，不挂载）。 */
      windowControls?: DesktopWindowControls;
    };
  }
}

export function detectHostOS(): HostOS {
  if (typeof navigator === "undefined") return "unknown";
  const platform = navigator.platform || "";
  const userAgent = navigator.userAgent || "";
  const probe = `${platform} ${userAgent}`.toLowerCase();
  if (probe.includes("mac")) return "macos";
  if (probe.includes("win")) return "windows";
  if (probe.includes("linux") || probe.includes("x11")) return "linux";
  return "unknown";
}

export function applyHostOSToDOM(os: HostOS = detectHostOS()): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.agentdeckHostOs = os;
  if (document.body) document.body.dataset.agentdeckHostOs = os;
}

export const runtime = {
  get platform(): RuntimePlatform {
    if (window.__AGENTDECK_RUNTIME__?.platform) return window.__AGENTDECK_RUNTIME__.platform;
    if (window.__TAURI_INTERNALS__) return "tauri";
    return "web";
  },
};
