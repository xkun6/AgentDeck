// 后台任务展示的纯函数（design.md 4.15）：药丸文案、状态文字、耗时格式化。
import type { AgentBackgroundTask, AgentBackgroundTaskStatus } from "@agentdeck/protocol";

/** 药丸文案：有运行中显示「N 运行中」，否则「N 个已结束」。 */
export function backgroundTaskPillLabel(tasks: readonly Pick<AgentBackgroundTask, "status">[]): string {
  const running = tasks.filter((task) => task.status === "running").length;
  return running > 0 ? `${running} 运行中` : `${tasks.length} 个已结束`;
}

export function backgroundTaskStatusText(status: AgentBackgroundTaskStatus): string {
  switch (status) {
    case "running":
      return "运行中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "stopped":
      return "已停止";
  }
}

/** 状态点 / 行弱化用的通用状态：已完成、已停止弱化，失败标红。 */
export function backgroundTaskDotStatus(status: AgentBackgroundTaskStatus): "running" | "done" | "error" | "stopped" {
  switch (status) {
    case "running":
      return "running";
    case "completed":
      return "done";
    case "failed":
      return "error";
    case "stopped":
      return "stopped";
  }
}

/** 耗时文本：mm:ss，满一小时为 h:mm:ss。 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** 运行中按 now 计时，结束后用 endedAt（缺失时按开始时间计 0）。 */
export function taskElapsedMs(task: Pick<AgentBackgroundTask, "status" | "startedAt" | "endedAt">, now: number): number {
  const end = task.status === "running" ? now : (task.endedAt ?? task.startedAt);
  return Math.max(0, end - task.startedAt);
}

/** 行 / 面板标题：描述；没有描述时取命令首行。 */
export function taskDisplayLabel(task: Pick<AgentBackgroundTask, "description" | "command">): string {
  const description = task.description.trim();
  if (description) return description;
  const firstLine = task.command?.split(/\r?\n/).find((line) => line.trim())?.trim();
  return firstLine ?? "后台命令";
}
