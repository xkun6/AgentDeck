// 点击后台提醒通知 → 跳转到对应会话：App 在后台 / 前台时经 notificationClicked 事件，进程被杀后冷启动经 takeLaunchTarget。
import { useEffect, useRef } from "react";
import type { MobileRoute } from "../route";
import { onNotificationClicked, takeLaunchTarget, type NotificationClickTarget } from "./native-plugin";

/** 有 agentId 去该会话，调度类通知（无 agentId）去会话列表 */
export function routeOfClickTarget(target: NotificationClickTarget): MobileRoute {
  return target.agentId ? { name: "session", agentId: target.agentId } : { name: "sessions" };
}

export function useNotificationClicks(navigate: (route: MobileRoute) => void): void {
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    let disposed = false;
    let off: (() => void) | null = null;
    const open = (target: NotificationClickTarget) => navigateRef.current(routeOfClickTarget(target));
    void onNotificationClicked(open).then((unlisten) => {
      if (disposed) unlisten();
      else off = unlisten;
    });
    void takeLaunchTarget().then((target) => {
      if (target && !disposed) open(target);
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, []);
}
