import { atom } from "jotai";
import type { Board } from "@agentdeck/protocol";
import { boardPathKey } from "@/lib/board-path";

/** 各项目的看板（来自 board.get / board.changed，按规范化项目路径索引，design.md 4.28）。 */
export const boardsByPathAtom = atom<Record<string, Board>>({});

export const replaceBoardAtom = atom(null, (_get, set, board: Board) => {
  set(boardsByPathAtom, (state) => ({ ...state, [boardPathKey(board.projectPath)]: board }));
});
