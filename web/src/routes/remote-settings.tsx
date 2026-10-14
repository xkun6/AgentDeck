// 「手机连接」设置页（design.md 4.31）：启用开关、端口、可用地址、配对二维码、已配对设备。
// 与 sidecar 通信只走 use-agent-session；remote.changed 由 useSidecarBridge 写入 remote.status 缓存。
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { Button } from "@agentdeck/shared-ui";
import type { RemoteAddress, RemoteStatus, SidecarSettings, SidecarSettingsPatch } from "@agentdeck/protocol";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import { AGENT_QUERY_KEYS } from "@/lib/agent-query-keys";
import { buildQrSvg, formatCountdown } from "@/lib/qr-svg";
import { useConfirm } from "@/lib/use-confirm";
import { sidecarConnectionAtom } from "@/stores/agents";
import settingsStyles from "./settings.module.css";
import s from "./remote-settings.module.css";

const SETTINGS_KEY = ["agentdeck", "sidecar-settings"] as const;
const MIN_PORT = 1024;
const MAX_PORT = 65_535;

/** design.md 4.31「网络类别检测」给出的提示原文 */
export const PUBLIC_NETWORK_HINT =
  "该网络被 Windows 标为「公用」，防火墙会阻止手机连接。请在 设置 → 网络和 Internet → 该网络 中改为「专用网络」";

const ADDRESS_LABELS: Record<RemoteAddress["kind"], string> = {
  lan: "局域网",
  tailscale: "Tailscale",
};

function Row({ label, sub, right }: { label: string; sub?: string; right: ReactNode }) {
  return (
    <div className={settingsStyles.row}>
      <div className={settingsStyles.rowLeft}>
        <div className={settingsStyles.rowLabel}>{label}</div>
        {sub ? <div className={settingsStyles.rowSub}>{sub}</div> : null}
      </div>
      <div className={settingsStyles.rowRight}>{right}</div>
    </div>
  );
}

function PortField({ value, disabled, onCommit, onInvalid }: { value: number; disabled: boolean; onCommit: (port: number) => void; onInvalid: () => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const parsed = Number(text);
    if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
      setText(String(value));
      onInvalid();
      return;
    }
    if (parsed !== value) onCommit(parsed);
  };
  return (
    <span className={s.numberField}>
      <input
        className={s.numberInput}
        type="text"
        inputMode="numeric"
        aria-label="监听端口"
        value={text}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
    </span>
  );
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

function QrCode({ text, expired }: { text: string; expired: boolean }) {
  const qr = useMemo(() => buildQrSvg(text), [text]);
  return (
    <div className={s.qrBox} data-expired={expired ? "true" : undefined}>
      <svg
        className={s.qrSvg}
        viewBox={`0 0 ${qr.size} ${qr.size}`}
        shapeRendering="crispEdges"
        role="img"
        aria-label="配对二维码"
      >
        <path d={qr.path} fill="currentColor" />
      </svg>
    </div>
  );
}

interface PairingState {
  offerUrl: string;
  expiresAt: number;
  /** 签发时已有的设备数，用于发现新设备配对成功 */
  deviceCount: number;
}

export function RemoteSettingsSection({ showHeading = true }: { showHeading?: boolean }) {
  const actions = useAgentSession();
  const queryClient = useQueryClient();
  const { confirm } = useConfirm();
  const connected = useAtomValue(sidecarConnectionAtom) === "open";
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [firewallHint, setFirewallHint] = useState(false);
  const [pairing, setPairing] = useState<PairingState | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const settings = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => actions.getSidecarSettings(),
    enabled: connected,
    retry: false,
  });
  const status = useQuery({
    queryKey: AGENT_QUERY_KEYS.remoteStatus,
    queryFn: () => actions.getRemoteStatus(),
    enabled: connected,
    retry: false,
  });

  const save = useMutation({
    mutationFn: (patch: SidecarSettingsPatch) => actions.setSidecarSettings(patch),
    onSuccess: (next: SidecarSettings, patch) => {
      queryClient.setQueryData(SETTINGS_KEY, next);
      void queryClient.invalidateQueries({ queryKey: AGENT_QUERY_KEYS.remoteStatus });
      setMessage(null);
      if (patch.remote?.enabled === true) setFirewallHint(true);
      if (patch.remote?.enabled === false) setFirewallHint(false);
    },
    onError: (error) => setMessage({ tone: "error", text: `保存失败：${humanizeSidecarError(error)}` }),
  });

  const createPairing = useMutation({
    mutationFn: () => actions.createRemotePairing(),
    onSuccess: ({ offerUrl, expiresAt }) => {
      setMessage(null);
      setNow(Date.now());
      setPairing({ offerUrl, expiresAt, deviceCount: status.data?.devices.length ?? 0 });
    },
    onError: (error) => setMessage({ tone: "error", text: `生成二维码失败：${humanizeSidecarError(error)}` }),
  });

  const revoke = useMutation({
    mutationFn: (deviceId: string) => actions.revokeRemoteDevice(deviceId),
    onSuccess: () => {
      setMessage({ tone: "ok", text: "已吊销该设备。" });
      void queryClient.invalidateQueries({ queryKey: AGENT_QUERY_KEYS.remoteStatus });
    },
    onError: (error) => setMessage({ tone: "error", text: `吊销失败：${humanizeSidecarError(error)}` }),
  });

  const remote: RemoteStatus | undefined = status.data;
  const listening = remote?.listening === true;

  // 网络类别（仅 Windows 桌面壳有；其它环境 / 检测失败 = 空，不提示）。回到窗口时重新检测，方便改完立刻看到结果
  const addressKey = remote?.addresses.map((address) => address.host).join(",") ?? "";
  const categories = useQuery({
    queryKey: ["agentdeck", "network-categories", addressKey],
    queryFn: async () => (await window.agentdeckDesktop?.networkCategories?.()) ?? [],
    enabled: remote?.enabled === true && addressKey !== "",
    retry: false,
  });
  const publicHosts = useMemo(
    () => new Set((categories.data ?? []).filter((row) => row.category === "public").map((row) => row.address)),
    [categories.data],
  );

  // 二维码倒计时：只在有二维码时每秒刷新
  useEffect(() => {
    if (!pairing) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pairing]);

  // 网关停止后二维码失效；有新设备配对成功后收起二维码
  const deviceCount = remote?.devices.length ?? 0;
  useEffect(() => {
    if (pairing && !listening) {
      setPairing(null);
    } else if (pairing && deviceCount > pairing.deviceCount) {
      setPairing(null);
      setMessage({ tone: "ok", text: "已配对新设备。" });
    }
  }, [pairing, listening, deviceCount]);

  const onRevoke = async (deviceId: string, name: string) => {
    const confirmed = await confirm({
      title: "吊销设备",
      body: `吊销「${name}」后，该手机会立即断开且无法再连接，需要重新扫码配对。`,
      confirmLabel: "吊销",
      danger: true,
    });
    if (confirmed) revoke.mutate(deviceId);
  };

  const current = settings.data?.remote;
  const toggleOptions = [
    { value: "off", label: "关闭" },
    { value: "on", label: "开启" },
  ];
  const remaining = pairing ? pairing.expiresAt - now : 0;
  const expired = pairing !== null && remaining <= 0;

  return (
    <div>
      {showHeading ? <h2 className={settingsStyles.heading}>手机连接</h2> : null}
      {!connected ? (
        <p className={settingsStyles.desc}>Agent 服务未连接，暂时无法读取或修改手机连接设置。</p>
      ) : settings.error ? (
        <p className={settingsStyles.desc} role="alert">
          读取设置失败：{humanizeSidecarError(settings.error)}
        </p>
      ) : null}

      {current ? (
        <>
          <Row
            label="允许手机连接"
            sub="开启后，电脑会在局域网 / Tailscale 上监听一个加密端口，只有扫码配对过的手机才能连接；手机不能修改这里的设置。默认关闭。"
            right={
              <div className={settingsStyles.radioGroup}>
                {toggleOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={settingsStyles.radioBtn}
                    data-active={(option.value === "on") === current.enabled}
                    onClick={() => save.mutate({ remote: { enabled: option.value === "on" } })}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            }
          />
          <Row
            label="监听端口"
            sub={`范围 ${MIN_PORT}–${MAX_PORT}，默认 47631。修改后会立即在新端口重新监听，已连接的手机需要重连。`}
            right={
              <PortField
                value={current.port}
                disabled={save.isPending}
                onCommit={(port) => save.mutate({ remote: { port } })}
                onInvalid={() => setMessage({ tone: "error", text: `端口需为 ${MIN_PORT}–${MAX_PORT} 之间的整数。` })}
              />
            }
          />
        </>
      ) : null}

      {firewallHint ? (
        <p className={s.notice} role="status">
          首次开启时，Windows 防火墙会弹出对 node.exe 的访问提示，请勾选「专用网络」并点击「允许访问」，否则手机无法连上。
        </p>
      ) : null}
      {remote?.error ? (
        <p className={s.message} data-tone="error" role="alert">
          {remote.error}
        </p>
      ) : null}
      {message ? (
        <p className={s.message} data-tone={message.tone} role={message.tone === "error" ? "alert" : "status"}>
          {message.text}
        </p>
      ) : null}

      {remote?.enabled ? (
        <>
          <h3 className={s.subheading}>连接地址</h3>
          {remote.addresses.length > 0 ? (
            <ul className={s.addressList}>
              {remote.addresses.map((address) => (
                <li
                  key={`${address.host}:${address.port}`}
                  className={s.addressRow}
                  data-public={publicHosts.has(address.host) ? "true" : undefined}
                >
                  <span className={s.address}>
                    {address.host}:{address.port}
                  </span>
                  {publicHosts.has(address.host) ? (
                    <span className={s.tag} data-tone="danger">
                      公用网络
                    </span>
                  ) : null}
                  <span className={s.tag}>{ADDRESS_LABELS[address.kind]}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className={s.empty}>没有找到局域网或 Tailscale 地址，请确认电脑已连上 Wi-Fi / 有线网络或已登录 Tailscale。</p>
          )}
          {publicHosts.size > 0 ? (
            <p className={s.message} data-tone="error" role="alert">
              {PUBLIC_NETWORK_HINT}
            </p>
          ) : null}

          <h3 className={s.subheading}>配对新手机</h3>
          {pairing ? (
            <div className={s.pairing}>
              <QrCode text={pairing.offerUrl} expired={expired} />
              <div className={s.pairingSide}>
                <span className={s.countdown} data-expired={expired ? "true" : undefined} aria-live="off">
                  {expired ? "二维码已过期" : formatCountdown(remaining)}
                </span>
                <p className={s.hint}>在手机 AgentDeck 里选择「扫码配对」。二维码 5 分钟内有效、只能使用一次，请勿发给他人。</p>
                <Button variant="outline" size="xs" disabled={createPairing.isPending} onClick={() => createPairing.mutate()}>
                  {expired ? "重新生成" : "重新生成（作废当前二维码）"}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="solid"
              size="xs"
              disabled={!listening || createPairing.isPending}
              onClick={() => createPairing.mutate()}
            >
              生成配对二维码
            </Button>
          )}
          {!listening && !remote.error ? <p className={s.empty}>网关正在启动……</p> : null}

          <h3 className={s.subheading}>已配对设备</h3>
          {remote.devices.length > 0 ? (
            <ul className={s.deviceList}>
              {remote.devices.map((device) => (
                <li key={device.deviceId} className={s.deviceRow}>
                  <div className={s.deviceInfo}>
                    <div className={s.deviceName}>{device.name}</div>
                    <div className={s.deviceMeta}>
                      配对于 {formatTime(device.pairedAt)}
                      {device.lastSeenAt !== undefined ? `　最近在线 ${formatTime(device.lastSeenAt)}` : "　尚未连接过"}
                    </div>
                  </div>
                  <span className={s.tag} data-on={device.connected ? "true" : undefined}>
                    {device.connected ? "在线" : "离线"}
                  </span>
                  <Button
                    variant="outline"
                    size="xs"
                    tone="danger"
                    disabled={revoke.isPending}
                    onClick={() => void onRevoke(device.deviceId, device.name)}
                  >
                    吊销
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={s.empty}>还没有配对过的手机。</p>
          )}
        </>
      ) : null}
    </div>
  );
}
