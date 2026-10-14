import type { ClientKind } from "@agentdeck/protocol";

import type { RpcClientConnection } from "../server/client-connection.js";

/** design.md 4.31：最近 120 秒内有可见的 desktop 心跳 = 用户在电脑前 */
export const DESKTOP_ACTIVE_WINDOW_MS = 120_000;

interface PresenceRecord {
  kind: ClientKind;
  visible: boolean;
  lastBeatAt: number;
}

/** 按连接记录 `client.presence`（kind / visible / 最近心跳）；连接断开即移除 */
export class PresenceTracker {
  private readonly records = new Map<RpcClientConnection, PresenceRecord>();

  constructor(private readonly now: () => number = Date.now) {}

  /** 远程连接的 kind 一律按 mobile 处理，不信任客户端自报 */
  update(connection: RpcClientConnection, kind: ClientKind, visible: boolean): void {
    this.records.set(connection, {
      kind: connection.kind === "remote" ? "mobile" : kind,
      visible,
      lastBeatAt: this.now(),
    });
  }

  forget(connection: RpcClientConnection): void {
    this.records.delete(connection);
  }

  /** 是否有 desktop 在窗口期内报告过「可见」 */
  isDesktopActive(): boolean {
    const now = this.now();
    for (const record of this.records.values()) {
      if (record.kind === "desktop" && record.visible && now - record.lastBeatAt <= DESKTOP_ACTIVE_WINDOW_MS) {
        return true;
      }
    }
    return false;
  }
}
