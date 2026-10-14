// 后台运行：设置页小节（保持连接开关 / 通知与电池优化状态 / 厂商指引）与首次开启「后台保持连接」时的一次性引导。
// 国产 ROM 会冻结后台进程，前台服务也未必挡得住：这里能做的是引导用户放行，并说明被冻结后的兜底（回到 App 自动补齐）。
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  getBatteryOptimization,
  getNotificationsEnabled,
  nativeAvailable,
  openAppSettings,
  requestIgnoreBatteryOptimization,
  requestNotificationPermission,
  type BatteryOptimizationStatus,
} from "./native/native-plugin";
import type { PreferencesStore } from "./preferences";
import s from "./mobile.module.css";

export const FROZEN_NOTE = "被系统冻结时，回到 App 会自动重连并补齐，不会丢消息；只是 App 在后台被冻结期间收不到提醒。";

const VENDOR_TIPS: Array<{ vendor: string; steps: string[] }> = [
  {
    vendor: "华为 / 荣耀",
    steps: [
      "设置 → 应用和服务 → 应用启动管理 → AgentDeck：关闭「自动管理」，打开「允许自启动」「允许关联启动」「允许后台活动」。",
      "在最近任务里下拉 AgentDeck 的卡片，锁定它（锁形图标）。",
    ],
  },
  {
    vendor: "小米 / Redmi",
    steps: [
      "设置 → 应用设置 → 应用管理 → AgentDeck：打开「自启动」，省电策略选「无限制」。",
      "在最近任务里长按 AgentDeck 的卡片，选择锁定。",
    ],
  },
  {
    vendor: "OPPO / vivo / 一加",
    steps: [
      "设置 → 应用管理 → AgentDeck：允许自启动与关联启动；耗电管理里选「允许后台运行」。",
      "在最近任务里锁定 AgentDeck 的卡片。",
    ],
  },
];

export interface BackgroundStatus {
  /** 通知开关：null = 当前环境无法查询 */
  notifications: boolean | null;
  battery: BatteryOptimizationStatus;
  refresh(): Promise<void>;
}

/** 通知与电池优化状态；回到前台（比如刚从系统设置页回来）时自动重新查询 */
export function useBackgroundStatus(): BackgroundStatus {
  const [notifications, setNotifications] = useState<boolean | null>(null);
  const [battery, setBattery] = useState<BatteryOptimizationStatus>({ supported: false, ignoring: false });

  const refresh = useCallback(async () => {
    const [enabled, optimization] = await Promise.all([getNotificationsEnabled(), getBatteryOptimization()]);
    setNotifications(enabled);
    setBattery(optimization);
  }, []);

  useEffect(() => {
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  return { notifications, battery, refresh };
}

export function VendorTips() {
  return (
    <div className={s.vendorTips}>
      {VENDOR_TIPS.map((tip) => (
        <details key={tip.vendor} className={s.vendorTip}>
          <summary>{tip.vendor}</summary>
          <ul>
            {tip.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}

export function BackgroundSection({ prefs }: { prefs: PreferencesStore }) {
  const { keepAlive } = useSyncExternalStore(prefs.subscribe, prefs.getState);
  const status = useBackgroundStatus();
  const native = nativeAvailable();

  const enableNotifications = async () => {
    // 被拒过两次后系统不会再弹框：此时请求没有效果，直接带用户去应用设置里手动打开
    const result = await requestNotificationPermission();
    const enabled = await getNotificationsEnabled();
    if (result !== "granted" && enabled !== true) await openAppSettings();
    await status.refresh();
  };

  return (
    <section className={s.section} aria-label="后台运行">
      <h2 className={s.sectionTitle}>后台运行</h2>
      <label className={s.switchRow}>
        <input
          type="checkbox"
          role="switch"
          aria-label="后台保持连接"
          checked={keepAlive}
          onChange={(event) => prefs.setKeepAlive(event.target.checked)}
        />
        <span>后台保持连接</span>
      </label>
      <div className={s.hint}>连上电脑后保持一条常驻通知，让 App 切到后台或锁屏时仍能收到任务完成 / 待审批提醒。</div>

      {native ? (
        <>
          <div className={s.card}>
            <div className={s.rowTitle}>通知</div>
            <div className={s.hostStatus} data-state={status.notifications ? "open" : "error"}>
              {status.notifications === null ? "检测中…" : status.notifications ? "已开启" : "未开启：后台收不到提醒"}
            </div>
            {status.notifications === false ? (
              <button type="button" className={s.secondaryButton} onClick={() => void enableNotifications()}>
                开启通知
              </button>
            ) : null}
          </div>

          <div className={s.card}>
            <div className={s.rowTitle}>电池优化</div>
            <div className={s.hostStatus} data-state={status.battery.ignoring ? "open" : "error"}>
              {!status.battery.supported ? "检测中…" : status.battery.ignoring ? "已忽略（不受电池优化限制）" : "受系统电池优化限制"}
            </div>
            {status.battery.supported && !status.battery.ignoring ? (
              <button type="button" className={s.secondaryButton} onClick={() => void requestIgnoreBatteryOptimization()}>
                请求忽略电池优化
              </button>
            ) : null}
          </div>

          <button type="button" className={s.secondaryButton} onClick={() => void openAppSettings()}>
            打开应用设置
          </button>
        </>
      ) : null}

      <div className={s.hint}>
        国产手机系统会限制后台应用。请在系统里为 AgentDeck 放行自启动、后台活动，并在最近任务里锁定：
      </div>
      <VendorTips />
      <div className={s.hint}>{FROZEN_NOTE}</div>
    </section>
  );
}

/** 首次开启「后台保持连接」后弹一次：说明用途、给出放行入口；点「知道了」后不再弹 */
export function BackgroundGuideDialog({ prefs }: { prefs: PreferencesStore }) {
  const { keepAlive, keepAliveGuided } = useSyncExternalStore(prefs.subscribe, prefs.getState);
  const status = useBackgroundStatus();
  // 引导内容针对 Android 原生壳；浏览器 / 桌面 dev 里不弹
  if (!keepAlive || keepAliveGuided || !nativeAvailable()) return null;

  return (
    <div className={s.guideOverlay} role="dialog" aria-modal="true" aria-label="后台保持连接引导">
      <div className={s.guideBox}>
        <h2 className={s.guideTitle}>让 AgentDeck 在后台保持连接</h2>
        <div className={s.hint}>
          已开启「后台保持连接」：切到后台或锁屏后，仍会通知你任务完成和待审批。要让它稳定生效，请放行下面的限制。
        </div>
        {status.battery.supported && !status.battery.ignoring ? (
          <button type="button" className={s.primaryButton} onClick={() => void requestIgnoreBatteryOptimization()}>
            请求忽略电池优化
          </button>
        ) : null}
        <button type="button" className={s.secondaryButton} onClick={() => void openAppSettings()}>
          打开应用设置（自启动 / 后台活动）
        </button>
        <VendorTips />
        <div className={s.hint}>{FROZEN_NOTE}</div>
        <button type="button" className={s.primaryButton} onClick={() => prefs.markKeepAliveGuided()}>
          知道了
        </button>
      </div>
    </div>
  );
}
