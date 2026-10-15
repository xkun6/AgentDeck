// 手机端应用壳：电脑列表 / 配对（无需连接）→ 会话列表 / 会话详情 / 新建 / 设置（需要已连接的电脑，带底部导航）。
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { Provider as JotaiProvider } from "jotai";
import type { HostStore, PairedHost } from "@/lib/remote/hosts";
import type { PairOverrides } from "@/lib/remote/pairing";
import { useSidecarBridge } from "@/hooks/use-agent-session";
import { AUTH_REASON_TEXT, type ConnectionManager, type ConnectionSnapshot } from "./connection-manager";
import { AttentionBanner, useAttentionNotice } from "./attention-banner";
import { BackgroundGuideDialog } from "./background-section";
import { HostList } from "./host-list";
import { NewSession } from "./new-session";
import { PairScreen } from "./pair-screen";
import type { PreferencesStore } from "./preferences";
import { detectDeviceName } from "./platform";
import { useNotificationClicks } from "./native/use-notification-clicks";
import { navTabOf, type MobileRoute } from "./route";
import { SessionDetail } from "./session-detail";
import { SessionList } from "./session-list";
import { Settings } from "./settings";
import { SyncBanner, useClientSyncing } from "./sync-indicator";
import { useHashRoute } from "./use-route";
import { DEFAULT_DEVICE_NAME } from "@/lib/remote/hosts";
import s from "./mobile.module.css";

export interface MobileAppProps {
  hosts: HostStore;
  manager: ConnectionManager;
  prefs: PreferencesStore;
  /** 测试注入：替换配对时的底层 socket */
  pairOverrides?: PairOverrides;
}

const NAV_ITEMS: Array<{ tab: "sessions" | "new" | "settings"; label: string }> = [
  { tab: "sessions", label: "会话" },
  { tab: "new", label: "新建" },
  { tab: "settings", label: "设置" },
];

export function MobileApp({ hosts, manager, prefs, pairOverrides }: MobileAppProps) {
  const hostsState = useSyncExternalStore(hosts.subscribe, hosts.getState);
  const connection = useSyncExternalStore(manager.subscribe, manager.getSnapshot);
  const { route, navigate, back } = useHashRoute();
  useNotificationClicks(navigate);
  const autoScanNext = useRef(false);
  const autoConnected = useRef(false);

  // 启动时自动进入上次使用的电脑
  useEffect(() => {
    if (autoConnected.current) return;
    if (route.name === "hosts" || route.name === "pair") return;
    const active = hostsState.activeHostId;
    if (active && connection.phase === "idle") {
      autoConnected.current = true;
      manager.connect(active);
    }
  }, [route.name, hostsState.activeHostId, connection.phase, manager]);

  const openHost = useCallback(
    async (hostId: string) => {
      if (connection.hostId === hostId && connection.phase === "auth_failed") {
        navigate({ name: "pair" });
        return;
      }
      await hosts.setActive(hostId);
      manager.connect(hostId);
      navigate({ name: "sessions" });
    },
    [connection.hostId, connection.phase, hosts, manager, navigate],
  );

  const deleteHost = useCallback(
    async (hostId: string) => {
      if (manager.getSnapshot().hostId === hostId) manager.disconnect();
      await hosts.remove(hostId);
    },
    [hosts, manager],
  );

  const onPaired = useCallback(
    async (host: PairedHost, deviceName: string) => {
      // 同一台电脑重新配对：替换旧记录，避免列表里出现两份
      for (const old of hosts.getState().hosts) {
        if (old.daemonPublicKey === host.daemonPublicKey && old.id !== host.id) await deleteHost(old.id);
      }
      await hosts.upsert(host);
      await hosts.setDeviceName(deviceName);
      await hosts.setActive(host.id);
      manager.connect(host.id);
      navigate({ name: "sessions" }, { replace: true });
    },
    [deleteHost, hosts, manager, navigate],
  );

  const deviceName = hostsState.deviceName === DEFAULT_DEVICE_NAME ? detectDeviceName() : hostsState.deviceName;
  const needsHost = connection.hostId === null || connection.client === null;

  if (route.name === "pair") {
    const autoScan = autoScanNext.current;
    autoScanNext.current = false;
    return (
      <PairScreen
        deviceName={deviceName}
        onPaired={onPaired}
        onBack={() => back({ name: "hosts" })}
        autoScan={autoScan}
        pairOverrides={pairOverrides}
      />
    );
  }

  if (route.name === "hosts" || needsHost) {
    return (
      <HostList
        hosts={hostsState.hosts}
        connection={connection}
        onOpenHost={(id) => void openHost(id)}
        onDeleteHost={(id) => void deleteHost(id)}
        onScan={() => {
          autoScanNext.current = true;
          navigate({ name: "pair" });
        }}
        onPaste={() => navigate({ name: "pair" })}
      />
    );
  }

  const host = hosts.get(connection.hostId!);
  return (
    <JotaiProvider store={connection.store!}>
      <ConnectedShell
        key={connection.hostId}
        connection={connection}
        prefs={prefs}
        route={route}
        navigate={navigate}
        content={
          <ShellContent
            route={route}
            navigate={navigate}
            back={back}
            host={host}
            connection={connection}
            deviceName={deviceName}
            hosts={hosts}
            manager={manager}
            prefs={prefs}
            deleteHost={deleteHost}
          />
        }
      />
    </JotaiProvider>
  );
}

function ConnectedShell({
  connection,
  prefs,
  route,
  navigate,
  content,
}: {
  connection: ConnectionSnapshot;
  prefs: PreferencesStore;
  route: MobileRoute;
  navigate: (route: MobileRoute, options?: { replace?: boolean }) => void;
  content: React.ReactNode;
}) {
  useSidecarBridge();
  const [notice, dismiss] = useAttentionNotice(connection.client, route, undefined, () => prefs.getState().notifyMode);
  const syncing = useClientSyncing(connection.client);
  const tab = navTabOf(route);

  // 凭据失效（含被吊销）：旧会话数据已不可信也不能再操作，整页只留说明与重新配对入口
  if (connection.phase === "auth_failed") {
    return (
      <div className={s.app}>
        <AuthFailedPanel reason={connection.authReason} onRepair={() => navigate({ name: "pair" })} />
      </div>
    );
  }

  return (
    <div className={s.app}>
      {connection.phase === "open" ? <BackgroundGuideDialog prefs={prefs} /> : null}
      {notice ? <AttentionBanner notice={notice} onOpen={(target) => navigate(target)} onDismiss={dismiss} /> : null}
      {connection.phase !== "open" ? (
        <div className={s.connBanner} data-state={connection.phase} role="status">
          <span>
            {connection.phase === "connecting"
              ? "正在连接电脑…"
              : `连接已断开：${connection.error ?? "无法连接电脑"}，自动重试中`}
          </span>
        </div>
      ) : syncing ? (
        <SyncBanner />
      ) : null}
      {content}
      {tab ? (
        <nav className={s.nav} aria-label="主导航">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.tab}
              type="button"
              className={s.navItem}
              data-active={tab === item.tab ? "true" : undefined}
              aria-current={tab === item.tab ? "page" : undefined}
              onClick={() => navigate({ name: item.tab })}
            >
              {item.label}
            </button>
          ))}
        </nav>
      ) : null}
    </div>
  );
}

export function AuthFailedPanel({
  reason,
  onRepair,
}: {
  reason: ConnectionSnapshot["authReason"];
  onRepair: () => void;
}) {
  return (
    <div className={s.page}>
      <header className={s.header}>
        <h1 className={s.title}>需要重新配对</h1>
      </header>
      <div className={s.body}>
        <div className={s.error} role="alert">
          {reason === "revoked" ? "此设备已被吊销，请重新配对" : reason ? AUTH_REASON_TEXT[reason] : AUTH_REASON_TEXT.invalid}
        </div>
        <div className={s.hint}>电脑上的会话不会显示在这里，重新扫码配对后即可继续使用。</div>
        <button type="button" className={s.primaryButton} onClick={onRepair}>
          重新配对
        </button>
      </div>
    </div>
  );
}

function ShellContent({
  route,
  navigate,
  back,
  host,
  connection,
  deviceName,
  hosts,
  manager,
  prefs,
  deleteHost,
}: {
  route: MobileRoute;
  navigate: (route: MobileRoute, options?: { replace?: boolean }) => void;
  back: (fallback: MobileRoute) => void;
  host: PairedHost | undefined;
  connection: ConnectionSnapshot;
  deviceName: string;
  hosts: HostStore;
  manager: ConnectionManager;
  prefs: PreferencesStore;
  deleteHost: (hostId: string) => Promise<void>;
}) {
  switch (route.name) {
    case "session":
      return (
        <SessionDetail
          key={route.agentId}
          agentId={route.agentId}
          onBack={() => back({ name: "sessions" })}
          openSubagentId={route.subagentId ?? null}
          onOpenSubagent={(id) => navigate({ name: "session", agentId: route.agentId, subagentId: id })}
          onCloseSubagent={() => back({ name: "session", agentId: route.agentId })}
        />
      );
    case "new":
      return <NewSession onCreated={(agentId) => navigate({ name: "session", agentId })} />;
    case "settings":
      return (
        <Settings
          host={host}
          connection={connection}
          deviceName={deviceName}
          prefs={prefs}
          onRenameDevice={(name) => void hosts.setDeviceName(name)}
          onSwitchHost={() => navigate({ name: "hosts" })}
          onDisconnect={() => {
            manager.disconnect();
            void hosts.setActive(null);
            navigate({ name: "hosts" });
          }}
          onDeleteHost={() => {
            if (host) void deleteHost(host.id);
            navigate({ name: "hosts" });
          }}
        />
      );
    default:
      return <SessionList onOpen={(agentId) => navigate({ name: "session", agentId })} />;
  }
}
