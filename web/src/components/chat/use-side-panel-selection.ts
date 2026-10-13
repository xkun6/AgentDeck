// 右侧面板的选中状态：子代理面板与后台任务面板互斥（打开一个关闭另一个），换会话时全部关闭。
import { useCallback, useEffect, useState } from "react";

type Selection = { kind: "subagent" | "task"; id: string } | null;

export function useSidePanelSelection(resetKey: string | null | undefined) {
  const [selection, setSelection] = useState<Selection>(null);
  useEffect(() => setSelection(null), [resetKey]);

  const openSubagent = useCallback((id: string) => setSelection({ kind: "subagent", id }), []);
  const openTask = useCallback((id: string) => setSelection({ kind: "task", id }), []);
  const close = useCallback(() => setSelection(null), []);

  return {
    openSubagentId: selection?.kind === "subagent" ? selection.id : null,
    openTaskId: selection?.kind === "task" ? selection.id : null,
    openSubagent,
    openTask,
    close,
  };
}
