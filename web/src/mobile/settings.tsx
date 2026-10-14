// 设置页：当前电脑与设备名、断开、删除配对（二次确认）、关于。
import { useState } from "react";
import type { PairedHost } from "@/lib/remote/hosts";
import { DESKTOP_VERSION, BUILD_COMMIT, versionLabel } from "@/lib/build-info";
import { BackgroundSection, NotifyModeSection } from "./background-section";
import { ConnectionDiagnosticsSection } from "./connection-diagnostics";
import { hostStatusText } from "./host-list";
import type { ConnectionSnapshot } from "./connection-manager";
import type { PreferencesStore } from "./preferences";
import s from "./mobile.module.css";

export interface SettingsProps {
  host: PairedHost | undefined;
  connection: ConnectionSnapshot;
  deviceName: string;
  prefs: PreferencesStore;
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
  onRenameDevice,
  onSwitchHost,
  onDisconnect,
  onDeleteHost,
}: SettingsProps) {
  const [name, setName] = useState(deviceName);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const status = host ? hostStatusText(host, connection) : null;

  return (
    <div className={s.page}>
      <header className={s.header}>
        <h1 className={s.title}>设置</h1>
      </header>
      <div className={s.body}>
        <section className={s.section} aria-label="当前电脑">
          <h2 className={s.sectionTitle}>当前电脑</h2>
          {host ? (
            <div className={s.card}>
              <div className={s.rowTitle}>{host.name}</div>
              <div className={s.hostStatus} data-state={status?.state}>
                {status?.text}
              </div>
              <div className={s.rowMeta}>
                {host.lastAddress ? `${host.lastAddress.host}:${host.lastAddress.port}` : `${host.addresses.length} 个地址`}
              </div>
            </div>
          ) : (
            <div className={s.hint}>未连接电脑</div>
          )}
          <button type="button" className={s.secondaryButton} onClick={onSwitchHost}>
            切换 / 添加电脑
          </button>
          {host ? (
            <button type="button" className={s.secondaryButton} onClick={onDisconnect}>
              断开连接
            </button>
          ) : null}
          {host ? (
            confirmingDelete ? (
              <div className={s.confirmBox}>
                <button
                  type="button"
                  className={s.dangerButton}
                  onClick={() => {
                    setConfirmingDelete(false);
                    onDeleteHost();
                  }}
                >
                  确认删除配对
                </button>
                <button type="button" className={s.secondaryButton} onClick={() => setConfirmingDelete(false)}>
                  取消
                </button>
              </div>
            ) : (
              <button type="button" className={s.dangerOutlineButton} onClick={() => setConfirmingDelete(true)}>
                删除配对
              </button>
            )
          ) : null}
        </section>

        <NotifyModeSection prefs={prefs} />

        <BackgroundSection prefs={prefs} />

        <ConnectionDiagnosticsSection />

        <section className={s.section} aria-label="本机">
          <h2 className={s.sectionTitle}>本机名称</h2>
          <label className={s.field}>
            <span>下次配对时上报给电脑的设备名</span>
            <input
              className={s.control}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => onRenameDevice(name)}
            />
          </label>
        </section>

        <section className={s.section} aria-label="关于">
          <h2 className={s.sectionTitle}>关于</h2>
          <div className={s.card}>
            <div className={s.rowTitle}>AgentDeck 手机端</div>
            <div className={s.rowMeta}>
              {versionLabel(DESKTOP_VERSION)} · {BUILD_COMMIT}
            </div>
            <div className={s.hint}>手机只是遥控器：Agent 仍运行在电脑上，连接全程端到端加密。</div>
          </div>
        </section>
      </div>
    </div>
  );
}
