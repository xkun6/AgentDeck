// 设置页：一级页只放当前取值与入口；选项走底部面板，长内容（后台运行、连接诊断）进子页。
import { useState, useSyncExternalStore } from "react";
import {
  Activity,
  ArrowLeftRight,
  BatteryCharging,
  Bell,
  ChevronLeft,
  Info,
  Laptop,
  Smartphone,
  Trash2,
  Unplug,
} from "lucide-react";
import type { PairedHost } from "@/lib/remote/hosts";
import { DESKTOP_VERSION, BUILD_COMMIT, versionLabel } from "@/lib/build-info";
import { getMobileConnectionLog } from "@/lib/connection-log";
import { BackgroundSection, KeepAliveRow, NOTIFY_MODE_OPTIONS, NotifyModeSection } from "./background-section";
import { ConnectionDiagnosticsSection } from "./connection-diagnostics";
import { hostStatusText } from "./host-list";
import { ListRow, ListSection } from "./list-row";
import { ConfirmDialog, Modal } from "./modal";
import type { ConnectionSnapshot } from "./connection-manager";
import type { PreferencesStore } from "./preferences";
import type { SettingsPage } from "./route";
import s from "./mobile.module.css";

export interface SettingsProps {
  host: PairedHost | undefined;
  connection: ConnectionSnapshot;
  deviceName: string;
  prefs: PreferencesStore;
  onOpenPage: (page: SettingsPage) => void;
  onRenameDevice: (name: string) => void;
  onSwitchHost: () => void;
  onDisconnect: () => void;
  onDeleteHost: () => void;
}

export function Settings({
  host,
  connection,
  deviceName,
  prefs,
  onOpenPage,
  onRenameDevice,
  onSwitchHost,
  onDisconnect,
  onDeleteHost,
}: SettingsProps) {
  const { notifyMode } = useSyncExternalStore(prefs.subscribe, prefs.getState);
  const log = getMobileConnectionLog();
  const logEntries = useSyncExternalStore(log.subscribe, log.getSnapshot);
  const [overlay, setOverlay] = useState<"notify" | "rename" | "delete" | null>(null);
  const [name, setName] = useState(deviceName);
  const status = host ? hostStatusText(host, connection) : null;
  const closeOverlay = () => setOverlay(null);

  return (
    <div className={s.page}>
      <header className={s.header}>
        <h1 className={s.title}>设置</h1>
      </header>
      <div className={s.body} data-flush="true">
        <ListSection title="电脑">
          {host ? (
            <ListRow
              icon={<Laptop aria-hidden="true" />}
              title={host.name}
              supporting={
                <>
                  <span className={s.hostStatus} data-state={status?.state}>
                    {status?.text}
                  </span>
                  {host.lastAddress ? ` · ${host.lastAddress.host}:${host.lastAddress.port}` : ` · ${host.addresses.length} 个地址`}
                </>
              }
            />
          ) : (
            <ListRow icon={<Laptop aria-hidden="true" />} title="未连接电脑" />
          )}
          <ListRow icon={<ArrowLeftRight aria-hidden="true" />} title="切换 / 添加电脑" chevron onClick={onSwitchHost} />
          {host ? <ListRow icon={<Unplug aria-hidden="true" />} title="断开连接" onClick={onDisconnect} /> : null}
          {host ? (
            <ListRow icon={<Trash2 aria-hidden="true" />} title="删除配对" danger onClick={() => setOverlay("delete")} />
          ) : null}
        </ListSection>

        <ListSection title="通知与后台">
          <ListRow
            icon={<Bell aria-hidden="true" />}
            title="通知提醒"
            supporting={NOTIFY_MODE_OPTIONS.find((option) => option.mode === notifyMode)?.label}
            chevron
            onClick={() => setOverlay("notify")}
          />
          <KeepAliveRow prefs={prefs} />
          <ListRow
            icon={<BatteryCharging aria-hidden="true" />}
            title="后台运行设置"
            supporting="通知权限、电池优化与各品牌手机的放行方法"
            chevron
            onClick={() => onOpenPage("background")}
          />
        </ListSection>

        <ListSection title="本机">
          <ListRow
            icon={<Smartphone aria-hidden="true" />}
            title="本机名称"
            supporting={deviceName}
            chevron
            onClick={() => {
              setName(deviceName);
              setOverlay("rename");
            }}
          />
          <ListRow
            icon={<Activity aria-hidden="true" />}
            title="连接诊断"
            supporting={logEntries.length > 0 ? `${logEntries.length} 条记录` : "暂无记录"}
            chevron
            onClick={() => onOpenPage("diagnostics")}
          />
        </ListSection>

        <ListSection title="关于">
          <ListRow
            icon={<Info aria-hidden="true" />}
            title="AgentDeck 手机端"
            supporting={`${versionLabel(DESKTOP_VERSION)}（${BUILD_COMMIT}）`}
          />
          <div className={s.hint}>手机只是遥控器：Agent 仍运行在电脑上，连接全程端到端加密。</div>
        </ListSection>
      </div>

      <Modal open={overlay === "notify"} onClose={closeOverlay} label="通知提醒" title="通知提醒">
        <NotifyModeSection prefs={prefs} onPicked={closeOverlay} />
      </Modal>

      <Modal open={overlay === "rename"} onClose={closeOverlay} label="本机名称" title="本机名称" variant="dialog">
        <form
          className={s.dialogForm}
          onSubmit={(event) => {
            event.preventDefault();
            onRenameDevice(name);
            closeOverlay();
          }}
        >
          <input
            className={s.control}
            value={name}
            aria-label="本机名称"
            onChange={(event) => setName(event.target.value)}
          />
          <p className={s.dialogText}>下次配对时上报给电脑的设备名。</p>
          <div className={s.dialogActions}>
            <button type="button" className={s.textButton} onClick={closeOverlay}>
              取消
            </button>
            <button type="submit" className={s.textButton}>
              保存
            </button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={overlay === "delete"}
        title="删除配对？"
        body={`将删除与「${host?.name ?? ""}」的配对。之后需要在电脑上重新生成二维码才能连接。`}
        confirmLabel="确认删除配对"
        danger
        onConfirm={() => {
          closeOverlay();
          onDeleteHost();
        }}
        onClose={closeOverlay}
      />
    </div>
  );
}

const SUBPAGE_TITLES: Record<SettingsPage, string> = {
  background: "后台运行设置",
  diagnostics: "连接诊断",
};

export function SettingsSubpage({ page, onBack }: { page: SettingsPage; onBack: () => void }) {
  return (
    <div className={s.page} data-motion="push">
      <header className={s.header}>
        <button type="button" className={s.iconButton} onClick={onBack} aria-label="返回">
          <ChevronLeft aria-hidden="true" />
        </button>
        <h1 className={s.titleSmall}>{SUBPAGE_TITLES[page]}</h1>
      </header>
      <div className={s.body} data-flush="true">
        {page === "background" ? <BackgroundSection /> : <ConnectionDiagnosticsSection />}
      </div>
    </div>
  );
}
