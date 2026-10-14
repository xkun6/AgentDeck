import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { exportKey, generateKeyPair, importPublicKey, importSecretKey, type KeyPair } from "@agentdeck/remote";

import { writeFileAtomic } from "../agent/agent-store.js";
import { createSilentLogger, type Logger } from "../logger.js";

export const REMOTE_DIR = "remote";
export const KEYPAIR_FILE = "daemon-keypair.json";
export const DEVICES_FILE = "devices.json";

/** devices.json 里的条目：凭据只存 sha256；吊销保留墓碑（revokedAt），供认证时回复 revoked */
export interface StoredDevice {
  deviceId: string;
  name: string;
  pairedAt: number;
  lastSeenAt?: number;
  secretSha256: string;
  revokedAt?: number;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isStoredDevice(value: unknown): value is StoredDevice {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.deviceId === "string" &&
    typeof v.name === "string" &&
    typeof v.pairedAt === "number" &&
    typeof v.secretSha256 === "string" &&
    (v.lastSeenAt === undefined || typeof v.lastSeenAt === "number") &&
    (v.revokedAt === undefined || typeof v.revokedAt === "number")
  );
}

/**
 * 远程网关持久化（design.md 4.31）：`<dataDir>/remote/daemon-keypair.json` 与 `devices.json`，原子写入。
 * 写盘失败时抛出且不改变内存状态。
 */
export class RemoteStore {
  private readonly dir: string;
  private readonly logger: Logger;
  private devices: StoredDevice[] = [];
  private keyPair: KeyPair | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: { dataDir: string; logger?: Logger }) {
    this.dir = path.join(options.dataDir, REMOTE_DIR);
    this.logger = options.logger ?? createSilentLogger();
  }

  /** 读取设备表；首次需要密钥对时才生成（换钥匙 = 所有设备需重新配对，所以生成后不再变） */
  async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(this.dir, DEVICES_FILE), "utf8"));
      if (Array.isArray(parsed)) {
        this.devices = parsed.filter(isStoredDevice);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn("读取远程设备表失败，视为空表：%s", String(error));
      }
    }
  }

  async loadOrCreateKeyPair(): Promise<KeyPair> {
    if (this.keyPair) {
      return this.keyPair;
    }
    const file = path.join(this.dir, KEYPAIR_FILE);
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as { publicKey?: unknown; secretKey?: unknown };
      if (typeof parsed.publicKey === "string" && typeof parsed.secretKey === "string") {
        this.keyPair = {
          publicKey: importPublicKey(parsed.publicKey),
          secretKey: importSecretKey(parsed.secretKey),
        };
        return this.keyPair;
      }
      this.logger.warn("daemon-keypair.json 内容不完整，重新生成（已配对设备需要重新配对）");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn("读取 daemon-keypair.json 失败，重新生成（已配对设备需要重新配对）：%s", String(error));
      }
    }
    const fresh = generateKeyPair();
    await this.write(file, { publicKey: exportKey(fresh.publicKey), secretKey: exportKey(fresh.secretKey) });
    this.keyPair = fresh;
    return fresh;
  }

  /** 未吊销的设备 */
  listActive(): StoredDevice[] {
    return this.devices.filter((device) => device.revokedAt === undefined).map((device) => ({ ...device }));
  }

  find(deviceId: string): StoredDevice | undefined {
    const found = this.devices.find((device) => device.deviceId === deviceId);
    return found ? { ...found } : undefined;
  }

  async addDevice(input: { name: string; secretSha256: string; now: number }): Promise<StoredDevice> {
    const device: StoredDevice = {
      deviceId: randomUUID(),
      name: input.name,
      pairedAt: input.now,
      secretSha256: input.secretSha256,
    };
    await this.mutate((devices) => [...devices, device]);
    return { ...device };
  }

  /** 吊销：保留墓碑条目；设备不存在或已吊销返回 false */
  async revokeDevice(deviceId: string, now: number): Promise<boolean> {
    return this.mutate((devices) => {
      const target = devices.find((device) => device.deviceId === deviceId);
      if (!target || target.revokedAt !== undefined) {
        return null;
      }
      return devices.map((device) => (device === target ? { ...device, revokedAt: now } : device));
    });
  }

  async touch(deviceId: string, now: number): Promise<void> {
    await this.mutate((devices) => {
      const target = devices.find((device) => device.deviceId === deviceId);
      if (!target || target.revokedAt !== undefined) {
        return null;
      }
      return devices.map((device) => (device === target ? { ...device, lastSeenAt: now } : device));
    });
  }

  /** 等待已排队的写盘完成（关闭前调用） */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  /**
   * 设备表的读-改-写必须串行：改动基于「排到队时」的最新内存状态计算，
   * 否则并发的 touch 会用旧快照覆盖掉刚落盘的吊销（复活已吊销设备）。fn 返回 null 表示无需改动。
   */
  private mutate(fn: (devices: StoredDevice[]) => StoredDevice[] | null): Promise<boolean> {
    const run = this.writeChain.then(async () => {
      const next = fn(this.devices);
      if (next === null) {
        return false;
      }
      await mkdir(this.dir, { recursive: true });
      await writeFileAtomic(path.join(this.dir, DEVICES_FILE), `${JSON.stringify(next, null, 2)}\n`);
      this.devices = next;
      return true;
    });
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private write(file: string, data: unknown): Promise<void> {
    const write = this.writeChain.then(async () => {
      await mkdir(this.dir, { recursive: true });
      await writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
    });
    this.writeChain = write.catch(() => undefined);
    return write;
  }
}
