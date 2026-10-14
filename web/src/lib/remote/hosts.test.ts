// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DEVICE_NAME,
  HostStore,
  createLocalStorageHostStorage,
  normalizeHostsState,
  type PairedHost,
} from "./hosts";

function host(id: string, overrides: Partial<PairedHost> = {}): PairedHost {
  return {
    id,
    name: `电脑-${id}`,
    daemonPublicKey: `key-${id}`,
    addresses: [{ host: "192.168.1.8", port: 47631, kind: "lan" }],
    deviceId: `dev-${id}`,
    deviceSecret: `secret-${id}`,
    pairedAt: 1,
    ...overrides,
  };
}

afterEach(() => localStorage.clear());

describe("HostStore", () => {
  it("增删改与激活项都会持久化，重新加载后一致", async () => {
    const storage = createLocalStorageHostStorage();
    const store = new HostStore(storage);
    await store.load();
    await store.upsert(host("a"));
    await store.upsert(host("b"));
    await store.setActive("b");
    await store.setLastAddress("a", { host: "100.64.0.2", port: 47631 });
    await store.setDeviceName("  我的 Pixel ");

    const reloaded = new HostStore(createLocalStorageHostStorage());
    await reloaded.load();
    const state = reloaded.getState();
    expect(state.hosts.map((h) => h.id)).toEqual(["a", "b"]);
    expect(state.activeHostId).toBe("b");
    expect(state.deviceName).toBe("我的 Pixel");
    expect(reloaded.get("a")?.lastAddress).toEqual({ host: "100.64.0.2", port: 47631 });
  });

  it("删除当前激活的电脑会清掉激活项", async () => {
    const store = new HostStore(createLocalStorageHostStorage());
    await store.load();
    await store.upsert(host("a"));
    await store.setActive("a");
    await store.remove("a");
    expect(store.getState()).toMatchObject({ hosts: [], activeHostId: null });
  });

  it("不能激活不存在的电脑；空设备名回落到默认名", async () => {
    const store = new HostStore(createLocalStorageHostStorage());
    await store.load();
    await store.setActive("ghost");
    expect(store.getState().activeHostId).toBeNull();
    await store.setDeviceName("   ");
    expect(store.getState().deviceName).toBe(DEFAULT_DEVICE_NAME);
  });

  it("订阅者在变更时收到通知", async () => {
    const store = new HostStore(createLocalStorageHostStorage());
    await store.load();
    let count = 0;
    const off = store.subscribe(() => {
      count += 1;
    });
    await store.upsert(host("a"));
    off();
    await store.upsert(host("b"));
    expect(count).toBe(1);
  });
});

describe("normalizeHostsState", () => {
  it("丢弃损坏的条目，激活项必须存在", () => {
    const state = normalizeHostsState({
      hosts: [host("a"), { id: "broken" }, null],
      activeHostId: "missing",
      deviceName: 42,
    });
    expect(state.hosts.map((h) => h.id)).toEqual(["a"]);
    expect(state.activeHostId).toBeNull();
    expect(state.deviceName).toBe(DEFAULT_DEVICE_NAME);
  });

  it("localStorage 里不是 JSON 时当作没有数据", async () => {
    localStorage.setItem("agentdeck-mobile-hosts", "{oops");
    expect(await createLocalStorageHostStorage().read()).toBeNull();
  });
});
