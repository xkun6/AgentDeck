import os from "node:os";

import type { RemoteAddress, RemoteStatus } from "@agentdeck/protocol";
import { encodeOfferUrl, exportKey, type KeyPair } from "@agentdeck/remote";

import { AgentInvalidParamsError, AgentRpcError } from "../agent/errors.js";
import { createSilentLogger, type Logger } from "../logger.js";
import type { RpcClientConnection } from "../server/client-connection.js";
import type { RemoteController, RpcConnectionHandle } from "../server/rpc-server.js";
import type { SettingsStore } from "../settings/sidecar-settings.js";
import { listAddresses } from "./addresses.js";
import { RemoteGateway, type RemoteGatewayTuning } from "./gateway.js";
import { PairingManager } from "./pairing.js";
import { RemoteStore } from "./store.js";

export interface RemoteServiceOptions {
  settings: SettingsStore;
  /** 未设置时远程网关不可启用（status.error 给出原因） */
  dataDir?: string;
  logger?: Logger;
  hostname?: () => string;
  addresses?: (port: number) => RemoteAddress[];
  now?: () => number;
  /** 监听地址，默认 0.0.0.0（测试里用 127.0.0.1） */
  listenHost?: string;
  /** 测试用：缩短超时 / 冷却等 */
  gatewayTuning?: Partial<RemoteGatewayTuning>;
}

function describeListenError(error: unknown, port: number): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EADDRINUSE") {
    return `端口 ${port} 已被占用，请换一个端口`;
  }
  if (code === "EACCES") {
    return `没有权限监听端口 ${port}，请换一个端口`;
  }
  return `启动远程网关失败：${error instanceof Error ? error.message : String(error)}`;
}

/**
 * 远程网关的编排（design.md 4.31）：按 `settings.remote` 启停网关、管理配对与设备、
 * 向 RpcServer 提供 `remote.*` 的实现。端口被占用等启动失败只写入 status.error，不影响 sidecar。
 */
export class RemoteService implements RemoteController {
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly store: RemoteStore | null;
  private readonly pairing: PairingManager;
  private readonly listeners = new Set<(status: RemoteStatus) => void>();
  private gateway: RemoteGateway | null = null;
  private keyPair: KeyPair | null = null;
  private activePort = 0;
  private error: string | undefined;
  private attach: ((connection: RpcClientConnection) => RpcConnectionHandle) | null = null;
  private chain: Promise<void> = Promise.resolve();
  private unsubscribeSettings: (() => void) | null = null;

  constructor(private readonly options: RemoteServiceOptions) {
    this.logger = options.logger ?? createSilentLogger();
    this.now = options.now ?? Date.now;
    this.store = options.dataDir ? new RemoteStore({ dataDir: options.dataDir, logger: this.logger }) : null;
    this.pairing = new PairingManager(this.now);
  }

  /** 绑定 RpcServer（认证后的连接经它接入） */
  bind(rpc: { attachConnection(connection: RpcClientConnection): RpcConnectionHandle }): void {
    this.attach = (connection) => rpc.attachConnection(connection);
  }

  /** 读取设备表并按当前设置启动网关；之后随 settings 变化自动启停 */
  async start(): Promise<void> {
    await this.store?.load();
    this.unsubscribeSettings = this.options.settings.subscribe(() => {
      void this.reconcile();
    });
    await this.reconcile();
  }

  async stop(): Promise<void> {
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
    await this.settled();
    await this.stopGateway();
    // 断开连接时会异步更新 lastSeenAt，等它落盘后再返回
    await new Promise((resolve) => setImmediate(resolve));
    await this.store?.flush();
    this.listeners.clear();
  }

  /** 等待排队中的启停完成（settings.set 返回前调用，使紧随其后的 remote.status 准确） */
  settled(): Promise<void> {
    return this.chain;
  }

  // ---- RemoteController ---------------------------------------------------

  status(): RemoteStatus {
    const { enabled, port } = this.options.settings.get().remote;
    const gateway = this.gateway;
    return {
      enabled,
      port,
      listening: gateway !== null,
      ...(this.error !== undefined ? { error: this.error } : {}),
      addresses: (this.options.addresses ?? listAddresses)(port),
      devices: (this.store?.listActive() ?? []).map((device) => ({
        deviceId: device.deviceId,
        name: device.name,
        pairedAt: device.pairedAt,
        ...(device.lastSeenAt !== undefined ? { lastSeenAt: device.lastSeenAt } : {}),
        connected: gateway?.isDeviceConnected(device.deviceId) ?? false,
      })),
    };
  }

  createPairing(): { offerUrl: string; expiresAt: number } {
    if (!this.gateway || !this.keyPair) {
      throw new AgentRpcError("NOT_SUPPORTED", "远程网关未启用或未在监听");
    }
    const addresses = (this.options.addresses ?? listAddresses)(this.activePort);
    if (addresses.length === 0) {
      throw new AgentRpcError("NOT_SUPPORTED", "未找到可用的局域网或 Tailscale 地址");
    }
    const { pairingSecret, expiresAt } = this.pairing.issue();
    const offerUrl = encodeOfferUrl({
      v: 1,
      name: (this.options.hostname ?? os.hostname)(),
      daemonPublicKey: exportKey(this.keyPair.publicKey),
      addresses,
      pairingSecret,
      expiresAt,
    });
    return { offerUrl, expiresAt };
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const revoked = (await this.store?.revokeDevice(deviceId, this.now())) ?? false;
    if (!revoked) {
      throw new AgentInvalidParamsError(`设备不存在或已吊销：${deviceId}`);
    }
    this.gateway?.disconnectDevice(deviceId);
    this.logger.info("已吊销远程设备 %s", deviceId);
    this.emit();
  }

  subscribe(listener: (status: RemoteStatus) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---- 内部 ---------------------------------------------------------------

  private emit(): void {
    if (this.listeners.size === 0) {
      return;
    }
    const status = this.status();
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch (error) {
        this.logger.error("remote.changed 监听器出错：%s", String(error));
      }
    }
  }

  private reconcile(): Promise<void> {
    this.chain = this.chain
      .then(() => this.apply())
      .catch((error: unknown) => {
        this.logger.error("应用远程网关设置出错：%s", String(error));
      });
    return this.chain;
  }

  private async apply(): Promise<void> {
    const { enabled, port } = this.options.settings.get().remote;
    const before = JSON.stringify({ l: this.gateway !== null, e: this.error, p: this.activePort });
    if (this.gateway && (!enabled || this.activePort !== port)) {
      await this.stopGateway();
    }
    if (!enabled) {
      this.error = undefined;
    } else if (!this.gateway) {
      await this.startGateway(port);
    }
    if (JSON.stringify({ l: this.gateway !== null, e: this.error, p: this.activePort }) !== before) {
      this.emit();
    }
  }

  private async startGateway(port: number): Promise<void> {
    if (!this.store || !this.attach) {
      this.error = "未设置数据目录（AGENTDECK_DATA_DIR），无法启用远程网关";
      return;
    }
    try {
      const keyPair = await this.store.loadOrCreateKeyPair();
      const gateway = new RemoteGateway({
        keyPair,
        store: this.store,
        pairing: this.pairing,
        computerName: this.options.hostname ?? os.hostname,
        attach: this.attach,
        onChange: () => this.emit(),
        logger: this.logger,
        now: this.now,
        ...(this.options.gatewayTuning ? { tuning: this.options.gatewayTuning } : {}),
      });
      try {
        this.activePort = await gateway.listen(port, this.options.listenHost ?? "0.0.0.0");
      } catch (error) {
        await gateway.close().catch(() => undefined);
        throw error;
      }
      this.gateway = gateway;
      this.keyPair = keyPair;
      this.error = undefined;
      this.logger.info("远程网关已监听 :%d", this.activePort);
    } catch (error) {
      this.error = describeListenError(error, port);
      this.logger.warn("远程网关启动失败：%s", this.error);
    }
  }

  private async stopGateway(): Promise<void> {
    const gateway = this.gateway;
    if (!gateway) {
      return;
    }
    this.gateway = null;
    this.pairing.clear();
    await gateway.close().catch((error: unknown) => {
      this.logger.warn("关闭远程网关出错：%s", String(error));
    });
    this.logger.info("远程网关已停止");
  }
}
