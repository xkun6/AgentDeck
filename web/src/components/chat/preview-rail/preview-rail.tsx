import { useAtom, useAtomValue } from "jotai";
import { useSearchParams } from "react-router-dom";
import {
  Camera,
  FileText,
  GitPullRequest,
  Globe,
  Package,
  TerminalSquare,
  X,
} from "lucide-react";
import {
  PREVIEW_PANEL_QUERY_KEY,
  SNAPSHOT_TURN_QUERY_KEY,
  UNSAVED_DISCARD_CONFIRM,
  normalizePreviewPanel,
  type PreviewPanel,
} from "@/lib/preview-rail";
import {
  EMPTY_PREVIEW_RAIL_SELECTION,
  previewEditorDirtyAtom,
  previewRailSelectionMapAtom,
  type PreviewRailSelection,
} from "@/stores/preview-rail";
import { useConfirm } from "@/lib/use-confirm";
import { WebPreviewTab } from "./web-preview-tab";
import { FilePreviewTab } from "./file-preview-tab";
import { ReviewTab } from "./review-tab";
import { TerminalTab } from "./terminal-tab";
import { SnapshotsTab } from "./snapshots-tab";
import { PanelResizeHandle, usePanelWidth } from "../panel-resize";
import s from "./preview-rail.module.css";

interface PreviewRailProps {
  /** Resolved session id; scopes the per-session selection. */
  sessionId: string;
  /** Session workspace root for file reads (may be empty). */
  workspaceRoot: string;
  onClose: () => void;
}

const TABS: Array<{ key: PreviewPanel; label: string; icon: typeof Globe; hidden?: boolean }> = [
  // 网页预览暂时隐藏（用处不大）。保留代码与 WebPreviewTab，方便后续按需重启用。
  { key: "web", label: "网页", icon: Globe, hidden: true },
  { key: "files", label: "文件", icon: FileText },
  { key: "review", label: "改动", icon: GitPullRequest },
  { key: "snapshots", label: "快照", icon: Camera },
  { key: "terminal", label: "终端", icon: TerminalSquare },
];

// Tabs planned but blocked on backend (PRD §5 P0: artifact manifest). Shown
// disabled so the layout matches the target spec.
const PENDING_TABS: Array<{ key: string; label: string; icon: typeof Globe }> = [
  { key: "artifacts", label: "产物", icon: Package },
];

export function PreviewRail({ sessionId, workspaceRoot, onClose }: PreviewRailProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const active = normalizePreviewPanel(searchParams.get(PREVIEW_PANEL_QUERY_KEY));
  const editorDirty = useAtomValue(previewEditorDirtyAtom);
  const { confirm } = useConfirm();

  // 不在挂载时往 URL 补写默认 ?panel=：React Router v7 的 setSearchParams 走 transition，
  // 「本回合修改了 N 个文件」小条同时打开右栏并写入 panel=snapshots 时，右栏先以旧 URL 挂载，
  // 补写会用旧参数覆盖成 panel=files（design.md 4.24）。缺省时 normalizePreviewPanel 已回落到默认页。

  const setActive = async (panel: PreviewPanel) => {
    if (panel === active) return;
    // Leaving 文件 unmounts FilePreviewTab and drops any unsaved draft —
    // confirm first instead of losing it silently.
    if (active === "files" && editorDirty) {
      const confirmed = await confirm({
        title: "放弃未保存的修改",
        body: UNSAVED_DISCARD_CONFIRM,
        confirmLabel: "放弃修改",
        danger: true,
      });
      if (!confirmed) return;
    }
    const next = new URLSearchParams(searchParams);
    next.set(PREVIEW_PANEL_QUERY_KEY, panel);
    setSearchParams(next, { replace: true });
  };
  const [selectionMap, setSelectionMap] = useAtom(previewRailSelectionMapAtom);
  const selection = selectionMap[sessionId] ?? EMPTY_PREVIEW_RAIL_SELECTION;
  const patchSelection = (patch: Partial<PreviewRailSelection>) => {
    setSelectionMap((map) => ({
      ...map,
      [sessionId]: { ...(map[sessionId] ?? EMPTY_PREVIEW_RAIL_SELECTION), ...patch },
    }));
  };

  const { width, onResizeStart } = usePanelWidth(460, 360, 840);

  return (
    <aside className={s.panel} aria-label="预览面板" style={{ width, flexBasis: width }}>
      <PanelResizeHandle ariaLabel="调整预览面板宽度" onPointerDown={onResizeStart} />
      <header className={s.header}>
        <div className={s.tabs} role="tablist">
          {TABS.filter((tab) => !tab.hidden).map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={active === key}
              className={s.tab}
              data-active={active === key ? "true" : undefined}
              onClick={() => void setActive(key)}
            >
              <Icon size={12} aria-hidden />
              {label}
              {key === "files" && editorDirty ? (
                <span className={s.tabDirtyDot} aria-label="有未保存的修改" title="有未保存的修改" />
              ) : null}
            </button>
          ))}
          {PENDING_TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              className={s.tab}
              disabled
              title="依赖后端能力，后续提供"
            >
              <Icon size={12} aria-hidden />
              {label}
            </button>
          ))}
        </div>
        <button className={s.close} type="button" onClick={onClose} aria-label="关闭预览面板">
          <X size={16} aria-hidden />
        </button>
      </header>

      <div className={s.body}>
        {active === "web" ? (
          <WebPreviewTab url={selection.webUrl} onUrlChange={(url) => patchSelection({ webUrl: url })} />
        ) : null}
        {active === "files" ? (
          <FilePreviewTab
            workspaceRoot={workspaceRoot}
            filePath={selection.filePath}
            onSelectFile={(path) => patchSelection({ filePath: path })}
          />
        ) : null}
        {active === "review" ? (
          <ReviewTab workspaceRoot={workspaceRoot} active={active === "review"} />
        ) : null}
        {active === "snapshots" ? (
          <SnapshotsTab
            agentId={sessionId}
            selectedTurnId={searchParams.get(SNAPSHOT_TURN_QUERY_KEY)}
            onSelectTurn={(turnId) => {
              const next = new URLSearchParams(searchParams);
              if (turnId) next.set(SNAPSHOT_TURN_QUERY_KEY, turnId);
              else next.delete(SNAPSHOT_TURN_QUERY_KEY);
              setSearchParams(next, { replace: true });
            }}
          />
        ) : null}
        {active === "terminal" ? <TerminalTab cwd={workspaceRoot} /> : null}
      </div>
    </aside>
  );
}
