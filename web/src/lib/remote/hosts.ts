// 已配对电脑的存取（docs/mobile.md 第 4 节）。存储接口可注入：Android 用 tauri-plugin-store，浏览器 / 测试用 localStorage。
import type { RemoteAddressRef } from "./e2ee-socket";

export interface PairedHostAddress extends RemoteAddressRef {
  kind: "lan" | "tailscale";
}

export interface PairedHost {
  /** 本地生成的主机 id（等于配对时电脑返回的 deviceId，同一台电脑重新配对会得到新的） */
  id: string;
  name: string;
  daemonPublicKey: string;
  addresses: PairedHostAddress[];
  deviceId: string;
  deviceSecret: string;
  /** 上次认证成功的地址，下次优先尝试 */
  lastAddress?: RemoteAddressRef;
  pairedAt: number;
}

export interface HostsState {
  hosts: PairedHost[];
  /** 上次使用的电脑，启动时自动进入 */
  activeHostId: string | null;
  /** 配对时上报给电脑的设备名 */
  deviceName: string;
}

export interface HostStorage {
  read(): Promise<HostsState | null>;
  write(state: HostsState): Promise<void>;
}

export const DEFAULT_DEVICE_NAME = "安卓手机";

const LOCAL_STORAGE_KEY = "agentdeck-mobile-hosts";
const TAURI_STORE_FILE = "hosts.json";
const TAURI_STORE_KEY = "state";

function emptyState(): HostsState {
  return { hosts: [], activeHostId: null, deviceName: DEFAULT_DEVICE_NAME };
}

function isHost(value: unknown): value is PairedHost {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    typeof v.daemonPublicKey === "string" &&
    Array.isArray(v.addresses) &&
    typeof v.deviceId === "string" &&
    typeof v.deviceSecret === "string" &&
    typeof v.pairedAt === "number"
  );
}

/** 从持久化的未知数据恢复状态；损坏的条目直接丢弃 */
export function normalizeHostsState(raw: unknown): HostsState {
  const state = emptyState();
  if (typeof raw !== "object" || raw === null) return state;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.hosts)) state.hosts = r.hosts.filter(isHost);
  if (typeof r.activeHostId === "string" && state.hosts.some((h) => h.id === r.activeHostId)) {
    state.activeHostId = r.activeHostId;
  }
  if (typeof r.deviceName === "string" && r.deviceName.trim()) state.deviceName = r.deviceName.trim();
  return state;
}

export function createLocalStorageHostStorage(key = LOCAL_STORAGE_KEY, storage: Storage = localStorage): HostStorage {
  return {
    async read() {
      try {
        const text = storage.getItem(key);
        return text ? normalizeHostsState(JSON.parse(text)) : null;
      } catch {
        return null;
      }
    },
    async write(state) {
      storage.setItem(key, JSON.stringify(state));
    },
  };
}

/** Android：应用私有目录里的 tauri-plugin-store（docs/mobile.md 第 6 节：root 设备可读，M4 改 Keystore） */
export function createTauriStoreHostStorage(): HostStorage {
  const open = async () => {
    const { load } = await import("@tauri-apps/plugin-store");
    return load(TAURI_STORE_FILE, { defaults: {}, autoSave: false });
  };
  return {
    async read() {
      const store = await open();
      const raw = await store.get(TAURI_STORE_KEY);
      return raw === undefined ? null : normalizeHostsState(raw);
    },
    async write(state) {
      const store = await open();
      await store.set(TAURI_STORE_KEY, state);
      await store.save();
    },
  };
}

type Listener = () => void;

/** 内存缓存 + 持久化 + 订阅（配合 useSyncExternalStore） */
export class HostStore {
  private state: HostsState = emptyState();
  private loaded = false;
  private readonly listeners = new Set<Listener>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly storage: HostStorage) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      this.state = (await this.storage.read()) ?? emptyState();
    } catch {
      this.state = emptyState();
    }
    this.loaded = true;
    this.emit();
  }

  getState = (): HostsState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get(id: string): PairedHost | undefined {
    return this.state.hosts.find((h) => h.id === id);
  }

  /** 新增或按 id 替换 */
  async upsert(host: PairedHost): Promise<void> {
    const exists = this.state.hosts.some((h) => h.id === host.id);
    const hosts = exists ? this.state.hosts.map((h) => (h.id === host.id ? host : h)) : [...this.state.hosts, host];
    await this.commit({ ...this.state, hosts });
  }

  /** 记住上次认证成功的地址 */
  async setLastAddress(id: string, address: RemoteAddressRef): Promise<void> {
    const host = this.get(id);
    if (!host || (host.lastAddress && host.lastAddress.host === address.host && host.lastAddress.port === address.port)) {
      return;
    }
    await this.upsert({ ...host, lastAddress: { host: address.host, port: address.port } });
  }

  async remove(id: string): Promise<void> {
    await this.commit({
      ...this.state,
      hosts: this.state.hosts.filter((h) => h.id !== id),
      activeHostId: this.state.activeHostId === id ? null : this.state.activeHostId,
    });
  }

  async setActive(id: string | null): Promise<void> {
    if (id !== null && !this.get(id)) return;
    await this.commit({ ...this.state, activeHostId: id });
  }

  async setDeviceName(name: string): Promise<void> {
    await this.commit({ ...this.state, deviceName: name.trim() || DEFAULT_DEVICE_NAME });
  }

  private commit(next: HostsState): Promise<void> {
    this.state = next;
    this.emit();
    const snapshot = next;
    this.writeChain = this.writeChain.then(() => this.storage.write(snapshot)).catch((error: unknown) => {
      console.warn("[hosts] 保存已配对电脑失败", error);
    });
    return this.writeChain;
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
