// 电脑列表：已配对电脑、连接状态、切换、删除（二次确认），以及「扫码配对」「粘贴配对链接」入口。
import { useState } from "react";
import { Laptop, QrCode } from "lucide-react";
import type { PairedHost } from "@/lib/remote/hosts";
import { AUTH_REASON_TEXT, type ConnectionSnapshot } from "./connection-manager";
import { isTauriShell } from "./platform";
import s from "./mobile.module.css";

export interface HostListProps {
  hosts: readonly PairedHost[];
  connection: ConnectionSnapshot;
  onOpenHost: (hostId: string) => void;
  onDeleteHost: (hostId: string) => void;
  onScan: () => void;
  onPaste: () => void;
}

export function hostStatusText(host: PairedHost, connection: ConnectionSnapshot): { text: string; state: string } {
  if (connection.hostId !== host.id) return { text: "未连接", state: "idle" };
  switch (connection.phase) {
    case "open":
      return { text: "已连接", state: "open" };
    case "connecting":
      return { text: "连接中…", state: "connecting" };
    case "auth_failed":
      return {
        text: connection.authReason ? AUTH_REASON_TEXT[connection.authReason] : "凭据已失效，请重新配对",
        state: "error",
      };
    case "failed":
      return { text: `连接失败：${connection.error ?? "无法连接电脑"}`, state: "error" };
    default:
      return { text: "未连接", state: "idle" };
  }
}

export function HostList({ hosts, connection, onOpenHost, onDeleteHost, onScan, onPaste }: HostListProps) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const canScan = isTauriShell();

  return (
    <div className={s.page}>
      <header className={s.header}>
        <h1 className={s.title}>我的电脑</h1>
      </header>
      <div className={s.body}>
        <div className={s.actionRow}>
          {canScan ? (
            <button type="button" className={s.primaryButton} onClick={onScan}>
              扫码配对
            </button>
          ) : null}
          <button type="button" className={canScan ? s.secondaryButton : s.primaryButton} onClick={onPaste}>
            粘贴配对链接
          </button>
        </div>
        {hosts.length === 0 ? (
          <div className={s.hero}>
            <span className={s.heroIcon} aria-hidden="true">
              <QrCode />
            </span>
            <div className={s.heroTitle}>连接你的电脑</div>
            <div className={s.heroText}>
              还没有配对过电脑。
              <br />
              在电脑 AgentDeck 的「手机连接」页生成配对二维码，用「扫码配对」扫描，或复制链接后粘贴。
            </div>
          </div>
        ) : (
          <ul className={s.list} aria-label="已配对电脑">
            {hosts.map((host) => {
              const status = hostStatusText(host, connection);
              const confirming = confirmingId === host.id;
              return (
                <li key={host.id} className={s.hostItem}>
                  <button type="button" className={s.hostMain} onClick={() => onOpenHost(host.id)}>
                    <span className={s.hostIcon} data-state={status.state} aria-hidden="true">
                      <Laptop />
                    </span>
                    <span className={s.rowBody}>
                      <span className={s.rowTitle}>{host.name}</span>
                      <span className={s.hostStatus} data-state={status.state}>
                        {status.text}
                      </span>
                      <span className={s.rowMeta}>
                        {host.lastAddress
                          ? `${host.lastAddress.host}:${host.lastAddress.port}`
                          : `${host.addresses.length} 个地址`}
                      </span>
                    </span>
                  </button>
                  {confirming ? (
                    <div className={s.confirmBox}>
                      <button
                        type="button"
                        className={s.dangerButton}
                        onClick={() => {
                          setConfirmingId(null);
                          onDeleteHost(host.id);
                        }}
                      >
                        确认删除
                      </button>
                      <button type="button" className={s.secondaryButton} onClick={() => setConfirmingId(null)}>
                        取消
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className={s.textButton}
                      aria-label={`删除 ${host.name}`}
                      onClick={() => setConfirmingId(host.id)}
                    >
                      删除
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
