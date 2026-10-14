// client.attention 的前台处理（design.md 4.31）：
// 前台且正停在该会话 → 忽略；前台在其它页面 → 应用内提示条（点击跳转）；后台 → 交给本地通知处理器（M3 接入，M2 只预留）。
import type { AttentionNotice } from "@agentdeck/protocol";
import type { MobileRoute } from "./route";

export type AttentionDecision = "ignore" | "banner" | "background";

export function decideAttention(
  notice: AttentionNotice,
  route: MobileRoute,
  foreground: boolean,
): AttentionDecision {
  if (!foreground) return "background";
  if (notice.agentId && route.name === "session" && route.agentId === notice.agentId) return "ignore";
  return "banner";
}

export type BackgroundAttentionHandler = (notice: AttentionNotice) => void;

let backgroundHandler: BackgroundAttentionHandler | null = null;

/** M3：前台服务 + 本地通知在这里注册；未注册时后台收到的 attention 直接丢弃 */
export function setBackgroundAttentionHandler(handler: BackgroundAttentionHandler | null): void {
  backgroundHandler = handler;
}

export function dispatchBackgroundAttention(notice: AttentionNotice): void {
  backgroundHandler?.(notice);
}

/** 提示条上的跳转目标：有 agentId 去该会话，调度类通知去会话列表 */
export function attentionTarget(notice: AttentionNotice): MobileRoute {
  return notice.agentId ? { name: "session", agentId: notice.agentId } : { name: "sessions" };
}
