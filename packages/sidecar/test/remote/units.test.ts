import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { classifyIpv4, collectAddresses } from "../../src/remote/addresses.js";
import { PairingManager, PAIRING_TTL_MS } from "../../src/remote/pairing.js";
import { DESKTOP_ACTIVE_WINDOW_MS, PresenceTracker } from "../../src/remote/presence.js";
import { RemoteStore, sha256Hex } from "../../src/remote/store.js";
import { createLogger } from "../../src/logger.js";
import type { RpcClientConnection } from "../../src/server/client-connection.js";
import { redactRemoteSecrets } from "../../src/utils/redact-remote.js";
import { FakeClock } from "./harness.js";

describe("addresses：lan / tailscale 分类", () => {
  test("classifyIpv4 按契约划分私网段", () => {
    expect(classifyIpv4("10.0.0.5")).toBe("lan");
    expect(classifyIpv4("172.16.0.1")).toBe("lan");
    expect(classifyIpv4("172.31.255.1")).toBe("lan");
    expect(classifyIpv4("192.168.1.8")).toBe("lan");
    expect(classifyIpv4("100.64.0.1")).toBe("tailscale");
    expect(classifyIpv4("100.127.255.254")).toBe("tailscale");
    // 边界之外
    expect(classifyIpv4("172.15.0.1")).toBeNull();
    expect(classifyIpv4("172.32.0.1")).toBeNull();
    expect(classifyIpv4("100.63.255.255")).toBeNull();
    expect(classifyIpv4("100.128.0.1")).toBeNull();
    expect(classifyIpv4("169.254.1.1")).toBeNull();
    expect(classifyIpv4("8.8.8.8")).toBeNull();
    expect(classifyIpv4("not-an-ip")).toBeNull();
    expect(classifyIpv4("1.2.3")).toBeNull();
  });

  test("collectAddresses：跳过内部地址与 IPv6，lan 在前 tailscale 在后，去重", () => {
    const info = (address: string, extra: Record<string, unknown> = {}) =>
      ({ address, family: "IPv4", internal: false, netmask: "", mac: "", cidr: null, ...extra }) as never;
    const addresses = collectAddresses(
      {
        Tailscale: [info("100.100.1.2"), info("fe80::1", { family: "IPv6" })],
        WLAN: [info("192.168.1.20"), info("192.168.1.20")],
        Loopback: [info("127.0.0.1", { internal: true })],
        Docker: [info("172.17.0.1"), info("169.254.3.4"), info("8.8.4.4")],
        Empty: undefined,
      },
      47_631,
    );
    expect(addresses).toEqual([
      { host: "192.168.1.20", port: 47_631, kind: "lan" },
      { host: "172.17.0.1", port: 47_631, kind: "lan" },
      { host: "100.100.1.2", port: 47_631, kind: "tailscale" },
    ]);
  });
});

describe("PairingManager", () => {
  test("签发后可用一次；第二次为 invalid", () => {
    const clock = new FakeClock();
    const pairing = new PairingManager(clock.now);
    const { pairingSecret, expiresAt } = pairing.issue();
    expect(expiresAt).toBe(clock.t + PAIRING_TTL_MS);
    expect(Buffer.from(pairingSecret, "base64url")).toHaveLength(32);
    expect(pairing.consume(pairingSecret)).toBe("ok");
    expect(pairing.consume(pairingSecret)).toBe("invalid");
  });

  test("过期为 expired（边界：恰好到点仍有效）", () => {
    const clock = new FakeClock();
    const pairing = new PairingManager(clock.now);
    const a = pairing.issue();
    clock.advance(PAIRING_TTL_MS);
    expect(pairing.consume(a.pairingSecret)).toBe("ok");
    const b = pairing.issue();
    clock.advance(PAIRING_TTL_MS + 1);
    expect(pairing.consume(b.pairingSecret)).toBe("expired");
  });

  test("新签发作废旧的；未知密钥 invalid", () => {
    const pairing = new PairingManager();
    const first = pairing.issue();
    const second = pairing.issue();
    expect(first.pairingSecret).not.toBe(second.pairingSecret);
    expect(pairing.consume(first.pairingSecret)).toBe("invalid");
    expect(pairing.consume("totally-wrong")).toBe("invalid");
    expect(pairing.consume(second.pairingSecret)).toBe("ok");
  });

  test("clear 后全部失效", () => {
    const pairing = new PairingManager();
    const { pairingSecret } = pairing.issue();
    pairing.clear();
    expect(pairing.consume(pairingSecret)).toBe("invalid");
  });
});

describe("RemoteStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "agentdeck-remote-store-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("密钥对首次生成、之后不变", async () => {
    const a = new RemoteStore({ dataDir: dir });
    const first = await a.loadOrCreateKeyPair();
    const b = new RemoteStore({ dataDir: dir });
    const second = await b.loadOrCreateKeyPair();
    expect(Buffer.from(second.publicKey)).toEqual(Buffer.from(first.publicKey));
    expect(Buffer.from(second.secretKey)).toEqual(Buffer.from(first.secretKey));
    expect(existsSync(path.join(dir, "remote", "daemon-keypair.json"))).toBe(true);
  });

  test("原子写入：不留 .tmp 文件；设备只存哈希；吊销保留墓碑", async () => {
    const store = new RemoteStore({ dataDir: dir });
    await store.load();
    const device = await store.addDevice({ name: "手机", secretSha256: sha256Hex("s3cret"), now: 100 });
    expect(readdirSync(path.join(dir, "remote")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    const text = readFileSync(path.join(dir, "remote", "devices.json"), "utf8");
    expect(text).not.toContain("s3cret");
    expect(store.listActive()).toHaveLength(1);

    await store.touch(device.deviceId, 500);
    expect(store.find(device.deviceId)?.lastSeenAt).toBe(500);

    expect(await store.revokeDevice(device.deviceId, 600)).toBe(true);
    expect(await store.revokeDevice(device.deviceId, 700)).toBe(false);
    expect(store.listActive()).toEqual([]);
    expect(store.find(device.deviceId)?.revokedAt).toBe(600);

    // 重新加载后状态一致
    const reloaded = new RemoteStore({ dataDir: dir });
    await reloaded.load();
    expect(reloaded.listActive()).toEqual([]);
    expect(reloaded.find(device.deviceId)?.revokedAt).toBe(600);
  });

  test("devices.json 损坏时视为空表而不是抛错；非法条目被丢弃", async () => {
    const store = new RemoteStore({ dataDir: dir });
    await store.addDevice({ name: "x", secretSha256: "aa", now: 1 });
    writeFileSync(path.join(dir, "remote", "devices.json"), "{broken");
    const again = new RemoteStore({ dataDir: dir });
    await again.load();
    expect(again.listActive()).toEqual([]);
    writeFileSync(path.join(dir, "remote", "devices.json"), JSON.stringify([{ deviceId: 1 }, "x"]));
    await again.load();
    expect(again.listActive()).toEqual([]);
  });
});

describe("PresenceTracker", () => {
  const conn = (kind: "local" | "remote"): RpcClientConnection => ({ kind, send: () => undefined, close: () => undefined });

  test("可见的 desktop 心跳在 120 秒内有效，超时失效", () => {
    const clock = new FakeClock();
    const presence = new PresenceTracker(clock.now);
    const desktop = conn("local");
    expect(presence.isDesktopActive()).toBe(false);
    presence.update(desktop, "desktop", true);
    expect(presence.isDesktopActive()).toBe(true);
    clock.advance(DESKTOP_ACTIVE_WINDOW_MS);
    expect(presence.isDesktopActive()).toBe(true);
    clock.advance(1);
    expect(presence.isDesktopActive()).toBe(false);
    presence.update(desktop, "desktop", true); // 心跳续期
    expect(presence.isDesktopActive()).toBe(true);
  });

  test("不可见 / 连接断开 / mobile 都不算电脑前有人", () => {
    const presence = new PresenceTracker();
    const desktop = conn("local");
    presence.update(desktop, "desktop", false);
    expect(presence.isDesktopActive()).toBe(false);
    presence.update(desktop, "desktop", true);
    presence.forget(desktop);
    expect(presence.isDesktopActive()).toBe(false);
    presence.update(conn("local"), "mobile", true);
    expect(presence.isDesktopActive()).toBe(false);
  });

  test("远程连接自报 desktop 也按 mobile 处理", () => {
    const presence = new PresenceTracker();
    presence.update(conn("remote"), "desktop", true);
    expect(presence.isDesktopActive()).toBe(false);
  });

  test("多个桌面窗口：任一可见即算在电脑前", () => {
    const presence = new PresenceTracker();
    const a = conn("local");
    const b = conn("local");
    presence.update(a, "desktop", false);
    presence.update(b, "desktop", true);
    expect(presence.isDesktopActive()).toBe(true);
    presence.update(b, "desktop", false);
    expect(presence.isDesktopActive()).toBe(false);
  });
});

describe("日志脱敏", () => {
  const secret = "q3Zx9Yk2LmN8pR5tVw7yB1cD4fG6hJ0aS2eU8iO3kM=";

  test("redactRemoteSecrets 覆盖 JSON、key=value 与配对链接", () => {
    expect(redactRemoteSecrets(`{"type":"paired","deviceSecret":"${secret}"}`)).not.toContain(secret);
    expect(redactRemoteSecrets(`deviceSecret=${secret} ok`)).toBe("deviceSecret=*** ok");
    expect(redactRemoteSecrets(`pairingSecret: ${secret}`)).not.toContain(secret);
    expect(redactRemoteSecrets("scan agentdeck://pair#eyJ2IjoxfQ now")).toBe("scan agentdeck://pair#*** now");
    expect(redactRemoteSecrets("普通日志 deviceId=abc")).toBe("普通日志 deviceId=abc");
  });

  test("logger 写出的日志里没有 deviceSecret / pairingSecret / 配对链接", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agentdeck-remote-log-"));
    try {
      const logger = createLogger({ logDir: dir, stderr: false });
      logger.info("收到消息 %s", JSON.stringify({ type: "paired", deviceId: "d", deviceSecret: secret }));
      logger.warn("pairingSecret=%s", secret);
      logger.info("offer %s", "agentdeck://pair#eyJ2IjoxLCJwYWlyaW5nU2VjcmV0IjoiYWJjIn0");
      logger.close();
      const text = readFileSync(path.join(dir, "sidecar.log"), "utf8");
      expect(text).not.toContain(secret);
      expect(text).not.toContain("eyJ2Ijox");
      expect(text).toContain("deviceId");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
