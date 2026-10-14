// client.attention 的应用内提示条（design.md 4.31）：前台且在其它页面时弹出，点击跳转到对应会话。
// App 在后台时交给 attention.ts 里注册的本地通知处理器（native/local-notifications.ts）。
import { useEffect, useRef, useState } from "react";
import type { AttentionNotice } from "@agentdeck/protocol";
import type { SidecarClient } from "@/lib/sidecar-client";
import { attentionTarget, decideAttention, dispatchBackgroundAttention } from "./attention";
import { isAppForeground } from "./native/app-state";
import type { NotifyMode } from "./preferences";
import type { MobileRoute } from "./route";
import s from "./mobile.module.css";

export const ATTENTION_BANNER_MS = 8_000;

const KIND_LABEL: Record<AttentionNotice["kind"], string> = {
  finished: "已完成",
  failed: "失败",
  permission: "待审批",
  schedule: "定时任务",
};

/** 订阅 client.attention，按当前路由 / 前后台决定忽略、弹条或交给后台处理器；返回当前要显示的提示 */
export function useAttentionNotice(
  client: Pick<SidecarClient, "onAttention"> | null,
  route: MobileRoute,
  isForeground: () => boolean = isAppForeground,
  getNotifyMode: () => NotifyMode = () => "always",
): [AttentionNotice | null, () => void] {
  const [notice, setNotice] = useState<AttentionNotice | null>(null);
  const routeRef = useRef(route);
  routeRef.current = route;
  // 回调放进 ref：调用方每次渲染传新函数也不会重新订阅
  const foregroundRef = useRef(isForeground);
  foregroundRef.current = isForeground;
  const modeRef = useRef(getNotifyMode);
  modeRef.current = getNotifyMode;
  const seen = useRef(new Set<string>());

  useEffect(() => {
    if (!client) return;
    return client.onAttention((incoming) => {
      if (seen.current.has(incoming.id)) return;
      seen.current.add(incoming.id);
      const decision = decideAttention(incoming, routeRef.current, foregroundRef.current(), modeRef.current());
      if (decision === "banner") setNotice(incoming);
      else if (decision === "background") dispatchBackgroundAttention(incoming);
    });
  }, [client]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), ATTENTION_BANNER_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  // 用户走进了该会话：提示不再需要
  useEffect(() => {
    if (notice?.agentId && route.name === "session" && route.agentId === notice.agentId) setNotice(null);
  }, [notice, route]);

  return [notice, () => setNotice(null)];
}

export function AttentionBanner({
  notice,
  onOpen,
  onDismiss,
}: {
  notice: AttentionNotice;
  onOpen: (target: MobileRoute) => void;
  onDismiss: () => void;
}) {
  return (
    <div className={s.attention} role="status" data-kind={notice.kind}>
      <button
        type="button"
        className={s.attentionMain}
        onClick={() => {
          onOpen(attentionTarget(notice));
          onDismiss();
        }}
      >
        <span className={s.attentionTitle}>
          {notice.title} · {KIND_LABEL[notice.kind]}
        </span>
        <span className={s.attentionBody}>{notice.body}</span>
      </button>
      <button type="button" className={s.iconButton} aria-label="关闭提示" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}
