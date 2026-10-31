// 电脑列表：已配对电脑、连接状态、切换、删除（二次确认），以及「扫码配对」「粘贴配对链接」入口。
import { useState } from "react";
import { ClipboardPaste, Laptop, QrCode, Trash2 } from "lucide-react";
import type { PairedHost } from "@/lib/remote/hosts";
import { AUTH_REASON_TEXT, type ConnectionSnapshot } from "./connection-manager";
import { ListRow, ListSection } from "./list-row";
import { ConfirmDialog } from "./modal";
import { isTauriShell } from "./platform";
import { EmptyState } from "./visual";
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
  const confirming = hosts.find((host) => host.id === confirmingId);

  return (
    <div className={s.page}>
      <header className={s.header}>
        <h1 className={s.title}>我的电脑</h1>
      </header>
      {hosts.length === 0 ? (
        <div className={s.body}>
          <EmptyState
            icon={QrCode}
            title="连接你的电脑"
            actions={
              <>
                {canScan ? (
                  <button type="button" className={s.primaryButton} onClick={onScan}>
                    扫码配对
                  </button>
                ) : null}
                <button type="button" className={canScan ? s.tonalButton : s.primaryButton} onClick={onPaste}>
                  粘贴配对链接
                </button>
              </>
            }
          >
            还没有配对过电脑。在电脑 AgentDeck 的「手机连接」页生成配对二维码，用「扫码配对」扫描，或复制链接后粘贴。
          </EmptyState>
        </div>
      ) : (
        <div className={s.body} data-flush="true">
          <ul className={s.plainList} aria-label="已配对电脑">
            {hosts.map((host) => {
              const status = hostStatusText(host, connection);
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
                  <button
                    type="button"
                    className={s.iconButton}
                    aria-label={`删除 ${host.name}`}
                    onClick={() => setConfirmingId(host.id)}
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
          <ListSection title="添加电脑">
            {canScan ? <ListRow icon={<QrCode aria-hidden="true" />} title="扫码配对" onClick={onScan} /> : null}
            <ListRow icon={<ClipboardPaste aria-hidden="true" />} title="粘贴配对链接" onClick={onPaste} />
          </ListSection>
        </div>
      )}
      <ConfirmDialog
        open={confirming !== undefined}
        title="删除这台电脑？"
        body={`将删除与「${confirming?.name ?? ""}」的配对。之后需要在电脑上重新生成二维码才能连接。`}
        confirmLabel="确认删除"
        danger
        onConfirm={() => {
          if (confirmingId) onDeleteHost(confirmingId);
          setConfirmingId(null);
        }}
        onClose={() => setConfirmingId(null)}
      />
    </div>
  );
}
