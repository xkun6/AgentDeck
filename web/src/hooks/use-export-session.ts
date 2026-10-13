// 导出会话为 JSON / Markdown（design.md 4.17）：agent.timeline 取全量条目 → 前端生成内容 →
// Rust export_session_file 弹保存对话框并写文件。结果用应用内提示框反馈。
import { useCallback } from "react";
import type { AgentSnapshot } from "@agentdeck/protocol";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import { useConfirm } from "@/lib/use-confirm";
import type { SessionExportFormat } from "@/lib/runtime";
import { buildSessionJson, buildSessionMarkdown, sessionExportFileName } from "@/lib/session-export";

export function useExportSession() {
  const actions = useAgentSession();
  const { confirm } = useConfirm();

  return useCallback(
    async (
      agent: AgentSnapshot,
      title: string,
      format: SessionExportFormat,
      providerLabel?: string,
    ): Promise<void> => {
      const notify = (heading: string, body: string) =>
        confirm({ title: heading, body, confirmLabel: "知道了", cancelLabel: "关闭" });
      const bridge = window.agentdeckDesktop;
      if (!bridge?.exportSessionFile) {
        await notify("导出失败", "仅桌面版支持导出会话文件");
        return;
      }
      try {
        const entries = await actions.fetchAllTimelineEntries(agent.id);
        const content =
          format === "json"
            ? buildSessionJson(agent, entries)
            : buildSessionMarkdown(agent, entries, { title, providerLabel });
        const result = await bridge.exportSessionFile({
          fileName: sessionExportFileName(title),
          content,
          format,
        });
        if (result.canceled) return;
        if (result.ok) await notify("导出成功", result.path ? `已导出到 ${result.path}` : "已导出会话文件");
        else await notify("导出失败", result.error || "写入文件失败");
      } catch (error) {
        await notify("导出失败", humanizeSidecarError(error));
      }
    },
    [actions, confirm],
  );
}
