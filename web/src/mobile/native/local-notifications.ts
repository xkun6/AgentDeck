// 后台本地通知（design.md 4.31：App 在后台收到 client.attention → Android 本地通知，点击跳转到对应会话）。
// 前台的忽略 / 提示条规则在 attention.ts；这里只负责「后台」这一支：去重、权限、按 kind 选 channel、发出通知。
import type { AttentionNotice } from "@agentdeck/protocol";
import {
  getNotificationsEnabled,
  requestNotificationPermission,
  showAttentionNotification,
  type AttentionNotification,
  type NotificationPermissionResult,
} from "./native-plugin";

export interface NotifierDeps {
  /** 系统层面的通知开关；null = 无法查询（非 Android） */
  enabled(): Promise<boolean | null>;
  request(): Promise<NotificationPermissionResult | "unsupported">;
  show(notification: AttentionNotification): Promise<boolean>;
}

export const defaultNotifierDeps: NotifierDeps = {
  enabled: getNotificationsEnabled,
  request: requestNotificationPermission,
  show: showAttentionNotification,
};

const SEEN_LIMIT = 200;

/** AttentionNotice.id（字符串）→ Android 通知 id（32 位整数）；同 id 同结果，相当于系统层再去重一次 */
export function notificationIdOf(noticeId: string): number {
  let hash = 0;
  for (let i = 0; i < noticeId.length; i += 1) hash = (Math.imul(hash, 31) + noticeId.charCodeAt(i)) | 0;
  return hash;
}

export class BackgroundNotifier {
  private readonly seen = new Set<string>();
  private permissionAsked = false;

  constructor(private readonly deps: NotifierDeps = defaultNotifierDeps) {}

  /**
   * 首次连上电脑（App 在前台）时调用：通知开关未开就弹一次系统权限框。
   * 只问一次——被拒后 Android 不会再弹，由设置页引导去系统设置；后台时系统也不允许弹框，所以不能等到通知到来时再问。
   */
  async ensurePermission(): Promise<void> {
    if (this.permissionAsked) return;
    const enabled = await this.deps.enabled();
    if (enabled !== false) return;
    this.permissionAsked = true;
    await this.deps.request();
  }

  /** 后台收到 attention：按 id 去重后发本地通知；通知权限没开则放弃（后台无法申请） */
  async notify(notice: AttentionNotice): Promise<boolean> {
    if (this.seen.has(notice.id)) return false;
    this.seen.add(notice.id);
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value as string);
    if ((await this.deps.enabled()) !== true) return false;
    return this.deps.show({
      id: notificationIdOf(notice.id),
      title: notice.title,
      body: notice.body,
      kind: notice.kind,
      ...(notice.agentId ? { agentId: notice.agentId } : {}),
    });
  }
}
