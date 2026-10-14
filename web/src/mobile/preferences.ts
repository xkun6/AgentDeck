// 手机端本地偏好（localStorage 持久化）：后台保持连接开关、首次引导标记与通知提醒档位。
// 与配对信息（HostStore，plugin-store）分开：这里只是界面级开关，丢了也只是回到默认值。

export interface MobilePreferences {
  /** 后台保持连接（前台服务 + 常驻通知），默认开 */
  keepAlive: boolean;
  /** 已弹过「后台保持连接」首次引导 */
  keepAliveGuided: boolean;
  /** 通知提醒（design.md 4.31）：总是通知 / 仅在前台时 / 从不通知，默认总是通知 */
  notifyMode: NotifyMode;
}

export type NotifyMode = "always" | "foreground" | "never";

export const NOTIFY_MODES: readonly NotifyMode[] = ["always", "foreground", "never"];

export const PREFERENCES_KEY = "agentdeck.mobile.preferences";

const DEFAULTS: MobilePreferences = { keepAlive: true, keepAliveGuided: false, notifyMode: "always" };

type PreferencesStorage = Pick<Storage, "getItem" | "setItem">;

export class PreferencesStore {
  private state: MobilePreferences;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: PreferencesStorage | null) {
    this.state = this.read();
  }

  getState = (): MobilePreferences => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setKeepAlive(keepAlive: boolean): void {
    this.update({ keepAlive });
  }

  setNotifyMode(notifyMode: NotifyMode): void {
    this.update({ notifyMode });
  }

  markKeepAliveGuided(): void {
    this.update({ keepAliveGuided: true });
  }

  private update(patch: Partial<MobilePreferences>): void {
    const next = { ...this.state, ...patch };
    if (
      next.keepAlive === this.state.keepAlive &&
      next.keepAliveGuided === this.state.keepAliveGuided &&
      next.notifyMode === this.state.notifyMode
    ) {
      return;
    }
    this.state = next;
    try {
      this.storage?.setItem(PREFERENCES_KEY, JSON.stringify(next));
    } catch {
      // 存储不可用（隐私模式等）：本次运行内仍然生效
    }
    for (const listener of [...this.listeners]) listener();
  }

  private read(): MobilePreferences {
    try {
      const raw = this.storage?.getItem(PREFERENCES_KEY);
      if (!raw) return DEFAULTS;
      const parsed = JSON.parse(raw) as Partial<MobilePreferences> | null;
      return {
        keepAlive: typeof parsed?.keepAlive === "boolean" ? parsed.keepAlive : DEFAULTS.keepAlive,
        keepAliveGuided: parsed?.keepAliveGuided === true,
        notifyMode: NOTIFY_MODES.find((mode) => mode === parsed?.notifyMode) ?? DEFAULTS.notifyMode,
      };
    } catch {
      return DEFAULTS;
    }
  }
}

export function createPreferencesStore(): PreferencesStore {
  return new PreferencesStore(typeof localStorage === "undefined" ? null : localStorage);
}
