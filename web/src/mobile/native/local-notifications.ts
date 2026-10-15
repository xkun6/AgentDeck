// 后台本地通知（design.md 4.31：App 在后台收到 client.attention → Android 本地通知，点击跳转到对应会话）。
// 前台的忽略 / 提示条规则在 attention.ts；这里只负责「后台」这一支：去重、权限、按 kind 选 channel、发出通知。
import type { AttentionNotice } from "@agentdeck/protocol";
import {
  getNotificationsEnabled,
  requestNotificationPermission,
  cancelAttentionNotification,
  showAttentionNotification,
  type AttentionNotification,
  type NotificationPermissionResult,
} from "./native-plugin";

export interface NotifierDeps {
  /** 系统层面的通知开关；null = 无法查询（非 Android） */
  enabled(): Promise<boolean | null>;
  request(): Promise<NotificationPermissionResult | "unsupported">;
  show(notification: AttentionNotification): Promise<boolean>;
  /** 取消指定 id 的系统通知 */
  cancel(id: number): Promise<boolean>;
}

export const defaultNotifierDeps: NotifierDeps = {
  enabled: getNotificationsEnabled,
  request: requestNotificationPermission,
  show: showAttentionNotification,
  cancel: cancelAttentionNotification,
};

const SEEN_LIMIT = 200;

/** AttentionNotice.id（字符串）→ Android 通知 id（32 位整数）；同 id 同结果，相当于系统层再去重一次 */
export function notificationIdOf(noticeId: string): number {
  let hash = 0;
  for (let i = 0; i < noticeId.length; i += 1) hash = (Math.imul(hash, 31) + noticeId.charCodeAt(i)) | 0;
  return hash;
}

/**
 * 一条 attention 对应的系统通知 id。审批类（带 requestId 与 agentId）按 agentId + requestId 算，
 * 这样 permission 通知与之后的 resolved 撤回信号（各有自己的 notice.id）能指向同一条系统通知；其余按 notice.id。
 */
export function notificationIdFor(notice: Pick<AttentionNotice, "id" | "agentId" | "requestId">): number {
  return notice.requestId && notice.agentId
    ? notificationIdOf(`${notice.agentId}:${notice.requestId}`)
    : notificationIdOf(notice.id);
}

export class BackgroundNotifier {
  private readonly seen = new Set<string>();
  /** 已撤回的通知 id：撤回信号可能先于「正在异步发出」的通知到达，发出前再核对一次 */
  private readonly cancelled = new Set<number>();
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

  /** 后台收到 attention：按 id 去重后发本地通知；通知权限没开则放弃（后台无法申请）。撤回信号（resolved）不弹通知 */
  async notify(notice: AttentionNotice): Promise<boolean> {
    if (notice.kind === "resolved") return false;
    if (this.seen.has(notice.id)) return false;
    this.seen.add(notice.id);
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value as string);
    if ((await this.deps.enabled()) !== true) return false;
    const id = notificationIdFor(notice);
    if (this.cancelled.delete(id)) return false;
    return this.deps.show({
      id,
      title: notice.title,
      body: notice.body,
      kind: notice.kind,
      ...(notice.agentId ? { agentId: notice.agentId } : {}),
    });
  }

  /** 收到撤回信号（别处已处理审批）：取消对应的系统通知；不看通知档位与前后台，通知不存在时无副作用 */
  async cancel(notice: Pick<AttentionNotice, "id" | "agentId" | "requestId">): Promise<boolean> {
    const id = notificationIdFor(notice);
    this.cancelled.add(id);
    if (this.cancelled.size > SEEN_LIMIT) this.cancelled.delete(this.cancelled.values().next().value as number);
    return this.deps.cancel(id);
  }
}
