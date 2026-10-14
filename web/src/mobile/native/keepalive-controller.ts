// 后台保持连接的启停时机（docs/mobile.md 第 5 节 M3）。
//
// 选「连上就启动、断开就停」而不是「进后台再启动」：Android 12+ 禁止 App 在后台启动前台服务，
// 而 visibilitychange→hidden 触发时 Activity 已经 stop，此时 startForegroundService 会抛
// ForegroundServiceStartNotAllowedException。App 在前台、连接刚建立时启动最可靠，代价只是前台期间也有一条静音常驻通知。
//
// 规则（开关打开为前提）：
// - 本次运行中第一次连上（phase=open）才启动，避免电脑关机 / 地址不可达时白白常驻；
// - 启动后短暂断线（connecting / failed，自动重连中）保持服务，只改常驻通知文案；
// - 用户断开 / 删除电脑（idle）、凭据失效（auth_failed）、关闭开关、切换电脑时停止。
import type { ConnectionSnapshot } from "../connection-manager";
import type { MobilePreferences } from "../preferences";

export interface KeepAliveNative {
  start(text: string): Promise<unknown>;
  stop(): Promise<unknown>;
}

export interface KeepAliveSources {
  getConnection(): ConnectionSnapshot;
  subscribeConnection(listener: () => void): () => void;
  getPreferences(): MobilePreferences;
  subscribePreferences(listener: () => void): () => void;
  hostName(hostId: string): string | undefined;
}

export function keepAliveText(hostName: string | undefined, connected: boolean): string {
  const name = hostName || "电脑";
  return connected ? `AgentDeck 已连接：${name}` : `AgentDeck 重连中：${name}`;
}

export class KeepAliveController {
  private running = false;
  private lastText = "";
  /** 本次运行中已经连上过的电脑 */
  private openedHostId: string | null = null;
  private readonly offs: Array<() => void>;

  constructor(
    private readonly sources: KeepAliveSources,
    private readonly native: KeepAliveNative,
  ) {
    const sync = () => this.sync();
    this.offs = [sources.subscribeConnection(sync), sources.subscribePreferences(sync)];
    this.sync();
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    if (this.running) this.stop();
  }

  private sync(): void {
    const connection = this.sources.getConnection();
    if (connection.hostId !== this.openedHostId) this.openedHostId = null;
    if (connection.phase === "open" && connection.hostId) this.openedHostId = connection.hostId;

    const enabled = this.sources.getPreferences().keepAlive;
    const alive =
      enabled &&
      connection.hostId !== null &&
      connection.client !== null &&
      this.openedHostId === connection.hostId &&
      connection.phase !== "idle" &&
      connection.phase !== "auth_failed";
    if (!alive) {
      if (this.running) this.stop();
      return;
    }
    const text = keepAliveText(this.sources.hostName(connection.hostId!), connection.phase === "open");
    if (this.running && text === this.lastText) return;
    this.running = true;
    this.lastText = text;
    void this.native.start(text);
  }

  private stop(): void {
    this.running = false;
    this.lastText = "";
    void this.native.stop();
  }
}
