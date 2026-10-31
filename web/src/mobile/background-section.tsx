// 后台运行：设置页的保持连接开关、子页（通知与电池优化状态 / 厂商指引）与首次开启「后台保持连接」时的一次性引导。
// 国产 ROM 会冻结后台进程，前台服务也未必挡得住：这里能做的是引导用户放行，并说明被冻结后的兜底（回到 App 自动补齐）。
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { BatteryCharging, Bell, ChevronRight, ExternalLink, Radio } from "lucide-react";
import {
  getBatteryOptimization,
  getNotificationsEnabled,
  nativeAvailable,
  openAppSettings,
  openAppNotificationSettings,
  requestIgnoreBatteryOptimization,
  requestNotificationPermission,
  type BatteryOptimizationStatus,
} from "./native/native-plugin";
import { subscribeAppForeground } from "./native/app-state";
import { ListRow, ListSection, SwitchRow } from "./list-row";
import { Modal } from "./modal";
import type { NotifyMode, PreferencesStore } from "./preferences";
import s from "./mobile.module.css";

/** 华为 / 荣耀的「应用启动管理」不会写入 AOSP 白名单，即使用户在那里放行了这里也显示未加入，所以文案保持中性、不标红 */
export const BATTERY_NOT_WHITELISTED = "未加入系统电池优化白名单（华为等机型请以「应用启动管理」中的设置为准）";

/** 部分厂商（如华为）会把「待审批」channel 降为不弹横幅，需要用户在系统通知设置里手动调回；各机型开关名称不同，文案保持通用 */
export const BANNER_HINT =
  "若审批通知没有弹出横幅，请在系统的 AgentDeck 通知设置里开启「横幅通知」或「悬浮通知」（不同机型名称不同）";

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
    return subscribeAppForeground((foreground) => {
      if (foreground) void refresh();
    });
  }, [refresh]);

  return { notifications, battery, refresh };
}

export function VendorTips() {
  return (
    <div className={s.vendorTips}>
      {VENDOR_TIPS.map((tip) => (
        <details key={tip.vendor} className={s.vendorTip}>
          <summary>
            {tip.vendor}
            <ChevronRight className={s.vendorChevron} aria-hidden="true" />
          </summary>
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

export const NOTIFY_MODE_OPTIONS: Array<{ mode: NotifyMode; label: string; hint: string }> = [
  { mode: "always", label: "总是通知", hint: "切到后台或锁屏时弹本地通知；在前台时，不在该会话页会弹提示条。" },
  { mode: "foreground", label: "仅在前台时", hint: "只在 App 打开时提示，后台不通知。" },
  { mode: "never", label: "从不通知", hint: "任务完成、待审批都不提醒。" },
];

/** 通知提醒档位（design.md 4.31）：存手机本地，默认总是通知 */
export function NotifyModeSection({ prefs, onPicked }: { prefs: PreferencesStore; onPicked?: () => void }) {
  const { notifyMode } = useSyncExternalStore(prefs.subscribe, prefs.getState);
  return (
    <div role="radiogroup" aria-label="通知提醒">
      {NOTIFY_MODE_OPTIONS.map((option) => (
        <label key={option.mode} className={s.listRow}>
          <input
            type="radio"
            className={s.radio}
            name="notify-mode"
            value={option.mode}
            aria-label={option.label}
            checked={notifyMode === option.mode}
            onChange={() => {
              prefs.setNotifyMode(option.mode);
              onPicked?.();
            }}
          />
          <span className={s.listText}>
            <span className={s.listTitle}>{option.label}</span>
            <span className={s.listSupporting}>{option.hint}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

/** 后台保持连接开关（设置一级页） */
export function KeepAliveRow({ prefs }: { prefs: PreferencesStore }) {
  const { keepAlive } = useSyncExternalStore(prefs.subscribe, prefs.getState);
  return (
    <SwitchRow
      icon={<Radio aria-hidden="true" />}
      title="后台保持连接"
      supporting="常驻一条通知，切到后台或锁屏时仍能收到任务完成 / 待审批提醒"
      checked={keepAlive}
      onChange={(checked) => prefs.setKeepAlive(checked)}
    />
  );
}

/** 后台运行设置子页：权限状态与各品牌手机的放行方法 */
export function BackgroundSection() {
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
    <>
      {native ? (
        <ListSection title="权限状态">
          <ListRow
            icon={<Bell aria-hidden="true" />}
            title="通知"
            supporting={
              <span className={s.hostStatus} data-state={status.notifications ? "open" : "error"}>
                {status.notifications === null ? "检测中…" : status.notifications ? "已开启" : "未开启：后台收不到提醒"}
              </span>
            }
            trailing={
              status.notifications === false ? (
                <button type="button" className={s.tonalButton} onClick={() => void enableNotifications()}>
                  开启通知
                </button>
              ) : undefined
            }
          />
          <ListRow
            icon={<BatteryCharging aria-hidden="true" />}
            title="电池优化"
            supporting={
              <span className={s.hostStatus} data-state={status.battery.ignoring ? "open" : undefined}>
                {!status.battery.supported ? "检测中…" : status.battery.ignoring ? "已忽略（不受电池优化限制）" : BATTERY_NOT_WHITELISTED}
              </span>
            }
          />
          {status.battery.supported && !status.battery.ignoring ? (
            <div className={s.rowAction}>
              <button type="button" className={s.tonalButton} onClick={() => void requestIgnoreBatteryOptimization()}>
                请求忽略电池优化
              </button>
            </div>
          ) : null}
          <ListRow
            title="打开应用设置"
            trailing={<ExternalLink className={s.listChevron} aria-hidden="true" />}
            onClick={() => void openAppSettings()}
          />
          <ListRow
            title="打开通知设置"
            trailing={<ExternalLink className={s.listChevron} aria-hidden="true" />}
            onClick={() => void openAppNotificationSettings()}
          />
          <div className={s.hint}>{BANNER_HINT}</div>
        </ListSection>
      ) : null}

      <ListSection title="各品牌手机的放行方法">
        <div className={s.hint}>国产手机系统会限制后台应用。请在系统里为 AgentDeck 放行自启动、后台活动，并在最近任务里锁定：</div>
        <VendorTips />
        <div className={s.hint}>{FROZEN_NOTE}</div>
      </ListSection>
    </>
  );
}

/**
 * 首次开启「后台保持连接」后弹一次：说明用途、给出放行入口；点「知道了」后不再弹。
 * 点遮罩 / 返回键可能是误触，只关这一次，下次进入再弹。断线重连时组件不卸载，不会因此重新弹出。
 */
export function BackgroundGuideDialog({ prefs, connected = true }: { prefs: PreferencesStore; connected?: boolean }) {
  const { keepAlive, keepAliveGuided } = useSyncExternalStore(prefs.subscribe, prefs.getState);
  const status = useBackgroundStatus();
  const [dismissed, setDismissed] = useState(false);
  // 引导内容针对 Android 原生壳；浏览器 / 桌面 dev 里不弹
  const open = connected && keepAlive && !keepAliveGuided && !dismissed && nativeAvailable();

  return (
    <Modal open={open} onClose={() => setDismissed(true)} label="后台保持连接引导" title="让 AgentDeck 在后台保持连接">
      <div className={s.guideBody}>
        <div className={s.hint}>
          已开启「后台保持连接」：切到后台或锁屏后，仍会通知你任务完成和待审批。要让它稳定生效，请放行下面的限制。
        </div>
        {status.battery.supported && !status.battery.ignoring ? (
          <button type="button" className={s.tonalButton} onClick={() => void requestIgnoreBatteryOptimization()}>
            请求忽略电池优化
          </button>
        ) : null}
        <button type="button" className={s.tonalButton} onClick={() => void openAppSettings()}>
          打开应用设置（自启动 / 后台活动）
        </button>
      </div>
      <VendorTips />
      <div className={s.guideBody}>
        <div className={s.hint}>{FROZEN_NOTE}</div>
        <button type="button" className={s.primaryButton} onClick={() => prefs.markKeepAliveGuided()}>
          知道了
        </button>
      </div>
    </Modal>
  );
}
