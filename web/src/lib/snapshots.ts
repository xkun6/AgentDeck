// 按回合文件快照（design.md 4.24）的纯函数：回合与助手消息的对应、回滚预览、占用格式化。
import type { SnapshotChangedFile, SnapshotTurn } from "@agentdeck/protocol";

/** 「有变化的已结束回合」：回合后快照已生成且有文件改动，且影子仓库未被清理。 */
export function hasSnapshotChanges(turn: SnapshotTurn): boolean {
  return turn.after !== null && turn.changedFiles.length > 0 && !turn.pruned;
}

/**
 * 助手消息 → 它所属回合的快照：消息的 firstSeq 即该回合 turn_started 的 seq（stores/chat.ts）。
 * 没有变化（或没找到）返回 undefined，调用方据此决定是否显示「本回合修改了 N 个文件」。
 */
export function snapshotForMessage(
  turns: readonly SnapshotTurn[] | undefined,
  firstSeq: number | undefined,
): SnapshotTurn | undefined {
  if (!turns || firstSeq === undefined) return undefined;
  const turn = turns.find((item) => item.seq === firstSeq);
  return turn && hasSnapshotChanges(turn) ? turn : undefined;
}

export interface RollbackPreview {
  /** 将从回合前的内容恢复的文件（回合内被修改或删除） */
  restore: string[];
  /** 将被删除的文件（回合内及之后新增） */
  remove: string[];
}

/**
 * 「回滚到本回合之前」会处理的文件：sidecar 按「回合前快照 → 当前工作区」的差异恢复，
 * 所以包含该回合及其后各回合的改动。这里按回合顺序折叠 changedFiles 得到预计结果（仅供确认弹窗展示）。
 */
export function rollbackPreview(turns: readonly SnapshotTurn[], turnId: string): RollbackPreview {
  const start = turns.findIndex((turn) => turn.turnId === turnId);
  if (start < 0) return { restore: [], remove: [] };
  const net = new Map<string, SnapshotChangedFile["status"]>();
  for (const turn of turns.slice(start)) {
    for (const file of turn.changedFiles) {
      const previous = net.get(file.path);
      if (file.status === "A") {
        net.set(file.path, previous === "D" ? "M" : "A");
      } else if (file.status === "D") {
        if (previous === "A") net.delete(file.path);
        else net.set(file.path, "D");
      } else {
        net.set(file.path, previous === "A" ? "A" : file.status === "R" ? "R" : "M");
      }
    }
  }
  const restore: string[] = [];
  const remove: string[] = [];
  for (const [path, status] of net) {
    (status === "A" ? remove : restore).push(path);
  }
  return { restore: restore.sort(), remove: remove.sort() };
}

export const SNAPSHOT_STATUS_LABEL: Record<SnapshotChangedFile["status"], string> = {
  A: "新增",
  M: "修改",
  D: "删除",
  R: "重命名",
};

export function snapshotSkipLabel(turn: SnapshotTurn): string | null {
  switch (turn.skipped) {
    case "too_many_files":
      return "文件过多，已跳过快照";
    case "git_unavailable":
      return "未找到 git，未生成快照";
    case "disabled":
      return "文件快照未启用";
    default:
      return turn.pruned ? "快照已清理" : null;
  }
}

/** 设置页展示的体积 */
export function formatSnapshotBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
