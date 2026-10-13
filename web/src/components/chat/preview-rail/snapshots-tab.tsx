// 右侧预览栏「快照」面板（design.md 4.24）：按回合列出文件快照、查看 diff、回滚到回合之前。
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, ChevronDown, ChevronRight, RefreshCw, Undo2 } from "lucide-react";
import type { SnapshotChangedFile, SnapshotTurn } from "@agentdeck/protocol";
import { LoadingState } from "@agentdeck/shared-ui";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import { SNAPSHOT_QUERY_KEY, useSnapshotTurns } from "@/hooks/use-snapshots";
import {
  SNAPSHOT_STATUS_LABEL,
  hasSnapshotChanges,
  rollbackPreview,
  snapshotSkipLabel,
} from "@/lib/snapshots";
import { DiffView } from "./review-tab";
import s from "./preview-rail.module.css";

interface SnapshotsTabProps {
  agentId: string;
  /** 默认展开的回合（来自「本回合修改了 N 个文件」小条） */
  selectedTurnId?: string | null;
  onSelectTurn?: (turnId: string | null) => void;
}

function formatTime(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function SnapshotsTab({ agentId, selectedTurnId = null, onSelectTurn }: SnapshotsTabProps) {
  const { turns, isLoading, isFetching, refetch, error } = useSnapshotTurns(agentId);
  const [localSelected, setLocalSelected] = useState<string | null>(null);
  const selected = selectedTurnId ?? localSelected;
  const select = (turnId: string | null) => {
    setLocalSelected(turnId);
    onSelectTurn?.(turnId);
  };

  // 最新回合在最前；没有变化也没有跳过原因的回合不列出
  const rows = useMemo(
    () =>
      turns
        .map((turn, index) => ({ turn, index }))
        .filter(({ turn }) => hasSnapshotChanges(turn) || snapshotSkipLabel(turn) !== null)
        .reverse(),
    [turns],
  );

  return (
    <div className={s.reviewLayout}>
      <div className={s.reviewToolbar}>
        <span className={s.reviewToolbarTitle}>文件快照</span>
        <button
          type="button"
          className={s.iconBtn}
          onClick={() => void refetch()}
          title="刷新快照列表"
          aria-label="刷新快照列表"
        >
          <RefreshCw size={12} aria-hidden />
        </button>
      </div>
      <div className={s.reviewTree}>
        {isLoading ? (
          <LoadingState variant="block" label="正在读取快照…" />
        ) : error ? (
          <div className={s.reviewHint} role="alert">
            读取快照失败：{humanizeSidecarError(error)}
          </div>
        ) : rows.length === 0 ? (
          <div className={s.empty}>
            <Camera size={24} aria-hidden />
            <p>还没有带文件改动的回合。每个回合开始与结束时会自动记录工作目录的文件快照。</p>
          </div>
        ) : (
          rows.map(({ turn, index }) => (
            <SnapshotTurnRow
              key={turn.turnId}
              agentId={agentId}
              turns={turns}
              turn={turn}
              ordinal={index + 1}
              open={selected === turn.turnId}
              onToggle={() => select(selected === turn.turnId ? null : turn.turnId)}
            />
          ))
        )}
        {isFetching && !isLoading ? <div className={s.reviewHint}>正在刷新…</div> : null}
      </div>
    </div>
  );
}

function SnapshotTurnRow({
  agentId,
  turns,
  turn,
  ordinal,
  open,
  onToggle,
}: {
  agentId: string;
  turns: readonly SnapshotTurn[];
  turn: SnapshotTurn;
  ordinal: number;
  open: boolean;
  onToggle: () => void;
}) {
  const skip = snapshotSkipLabel(turn);
  const changed = hasSnapshotChanges(turn);
  return (
    <div className={s.snapshotTurn} data-open={open ? "true" : undefined}>
      <button
        type="button"
        className={s.reviewRow}
        onClick={onToggle}
        aria-expanded={open}
        disabled={!changed}
        title={changed ? undefined : (skip ?? undefined)}
      >
        {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
        <span className={s.reviewRowName}>回合 {ordinal}</span>
        <span className={s.reviewRowDir}>{formatTime(turn.startedAt)}</span>
        <span className={s.snapshotCount}>
          {changed ? `${turn.changedFiles.length} 个文件` : (skip ?? "")}
        </span>
      </button>
      {open && changed ? <SnapshotTurnDetail agentId={agentId} turns={turns} turn={turn} /> : null}
    </div>
  );
}

function SnapshotTurnDetail({
  agentId,
  turns,
  turn,
}: {
  agentId: string;
  turns: readonly SnapshotTurn[];
  turn: SnapshotTurn;
}) {
  const actions = useAgentSession();
  const queryClient = useQueryClient();
  const [path, setPath] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const diff = useQuery({
    queryKey: [...SNAPSHOT_QUERY_KEY, agentId, "diff", turn.turnId, path],
    queryFn: () => actions.snapshotDiff(agentId, turn.turnId, path ? { path } : {}),
    retry: false,
    staleTime: Infinity,
  });

  const restore = useMutation({
    mutationFn: () => actions.restoreSnapshot(agentId, turn.turnId),
    onSuccess: (result) => {
      setNotice({
        tone: "ok",
        text: `已回滚：恢复 ${result.restored.length} 个文件，删除 ${result.deleted.length} 个文件（回滚前状态已备份为提交 ${result.backupCommit.slice(0, 8)}）。`,
      });
      void queryClient.invalidateQueries({ queryKey: SNAPSHOT_QUERY_KEY });
    },
    onError: (error) => setNotice({ tone: "error", text: `回滚失败：${humanizeSidecarError(error)}` }),
  });

  const preview = useMemo(() => rollbackPreview(turns, turn.turnId), [turns, turn.turnId]);
  const canRollback = turn.before !== null && !turn.pruned;

  return (
    <div className={s.snapshotDetail}>
      <ul className={s.snapshotFiles}>
        {turn.changedFiles.map((file: SnapshotChangedFile) => (
          <li key={file.path}>
            <button
              type="button"
              className={s.reviewRow}
              data-selected={path === file.path ? "true" : undefined}
              onClick={() => setPath(path === file.path ? null : file.path)}
              title={file.path}
            >
              <span
                className={s.reviewStatus}
                data-tone={file.status === "A" ? "added" : file.status === "D" ? "removed" : "modified"}
                title={SNAPSHOT_STATUS_LABEL[file.status]}
              >
                {file.status}
              </span>
              <span className={s.reviewRowName}>{file.path}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className={s.snapshotDiff}>
        {diff.isLoading ? (
          <LoadingState variant="block" label="正在读取差异…" />
        ) : diff.error ? (
          <div className={s.reviewHint} role="alert">
            读取差异失败：{humanizeSidecarError(diff.error)}
          </div>
        ) : diff.data?.diff ? (
          <>
            <DiffView diff={diff.data.diff} />
            {diff.data.truncated ? <div className={s.reviewHint}>差异过大，已截断显示（上限 512 KB）。</div> : null}
          </>
        ) : (
          <div className={s.reviewHint}>没有差异内容。</div>
        )}
      </div>

      {notice ? (
        <div className={s.snapshotNotice} data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>
          {notice.text}
        </div>
      ) : null}

      <div className={s.snapshotActions}>
        <button
          type="button"
          className={s.reviewModalBtn}
          disabled={!canRollback || restore.isPending}
          onClick={() => {
            setNotice(null);
            setConfirming(true);
          }}
          title={canRollback ? undefined : "该回合没有可用的快照"}
        >
          <Undo2 size={12} aria-hidden /> 回滚到本回合之前
        </button>
      </div>

      {confirming ? (
        <div className={s.reviewModalBackdrop} onClick={() => setConfirming(false)}>
          <div
            className={s.reviewModal}
            role="dialog"
            aria-modal="true"
            aria-label="回滚到本回合之前"
            onClick={(event) => event.stopPropagation()}
          >
            <div className={s.reviewModalTitle}>回滚到本回合之前</div>
            <div className={s.reviewModalBody}>
              会把工作目录恢复到本回合开始前的状态（含之后回合的改动），回滚前的状态会先备份。预计：
              <div className={s.snapshotPreviewGroup}>
                将恢复 {preview.restore.length} 个文件
                <ul className={s.snapshotPreviewList}>
                  {preview.restore.map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
              </div>
              <div className={s.snapshotPreviewGroup}>
                将删除 {preview.remove.length} 个文件
                <ul className={s.snapshotPreviewList}>
                  {preview.remove.map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
              </div>
            </div>
            <div className={s.reviewModalActions}>
              <button type="button" className={s.reviewModalBtn} onClick={() => setConfirming(false)}>
                取消
              </button>
              <button
                type="button"
                className={s.reviewModalBtn}
                data-variant="danger"
                onClick={() => {
                  setConfirming(false);
                  restore.mutate();
                }}
              >
                确认回滚
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
