import { readFileSync } from "node:fs";
import path from "node:path";
import { format } from "node:util";

import { encodeOfferUrl, decodeOfferUrl } from "@agentdeck/remote";
import nacl from "tweetnacl";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";

import type { Logger } from "../../src/logger.js";

import { RemotePhone, RawPhone, startHarness, upgradeStatus, type Harness } from "./harness.js";

let h: Harness;

beforeEach(async () => {
  h = await startHarness({ enable: true });
});

afterEach(async () => {
  await h.close();
});

describe("路径与明文端点", () => {
  test("只接受 GET /remote 的 WS 升级，其余 404（含 /rpc、/health）", async () => {
    expect(await upgradeStatus(h.port, "/rpc")).toBe(404);
    expect(await upgradeStatus(h.port, "/")).toBe(404);
    expect(await upgradeStatus(h.port, "/remote/x")).toBe(404);
    const health = await fetch(`http://127.0.0.1:${h.port}/health`);
    expect(health.status).toBe(404);
    const rpc = await fetch(`http://127.0.0.1:${h.port}/remote`);
    expect(rpc.status).toBe(404);
  });
});

describe("握手：配对", () => {
  test("配对成功：回 deviceId / deviceSecret，设备出现在状态里并在线，本机收到 remote.changed", async () => {
    const before = h.local.notifications.filter((n) => n.method === "remote.changed").length;
    const { phone, deviceId, deviceSecret } = await h.pairPhone("我的小米");
    expect(deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Buffer.from(deviceSecret, "base64")).toHaveLength(32);

    const status = await h.local.call("remote.status");
    expect(status.devices).toHaveLength(1);
    expect(status.devices[0]).toMatchObject({ deviceId, name: "我的小米", connected: true });
    expect(status.devices[0]).not.toHaveProperty("secretSha256");

    await h.local.waitFor(
      () => h.local.notifications.filter((n) => n.method === "remote.changed").length > before,
    );
    phone.close();
  });

  test("devices.json 只存凭据哈希，不含 deviceSecret；daemon-keypair.json 重启后不变", async () => {
    const { phone, deviceSecret } = await h.pairPhone();
    const devicesFile = readFileSync(path.join(h.dataDir!, "remote", "devices.json"), "utf8");
    expect(devicesFile).not.toContain(deviceSecret);
    expect(devicesFile).toContain("secretSha256");
    const keypair = readFileSync(path.join(h.dataDir!, "remote", "daemon-keypair.json"), "utf8");
    expect(JSON.parse(keypair)).toHaveProperty("publicKey");
    phone.close();
  });

  test("配对后可用保存的凭据重新认证（authed 回电脑名）", async () => {
    const { phone, deviceId, deviceSecret, offer } = await h.pairPhone();
    phone.close();
    await phone.closed;
    const again = await RemotePhone.open(h.port, {
      mode: "auth",
      daemonPublicKey: offer.daemonPublicKey,
      deviceId,
      deviceSecret,
    });
    expect(await again.outcome).toEqual({ type: "authed", name: "test-pc" });
    again.close();
  });

  test("pairingSecret 复用：第二次使用被拒（invalid）", async () => {
    const offer = await h.newOffer();
    const first = await RemotePhone.open(h.port, { mode: "pair", offer, deviceName: "A" });
    expect((await first.outcome).type).toBe("paired");
    const second = await RemotePhone.open(h.port, { mode: "pair", offer, deviceName: "B" });
    expect(await second.outcome).toEqual({ type: "auth_failed", reason: "invalid" });
    expect(await second.closed).toBeGreaterThan(0);
    first.close();
  });

  test("pairingSecret 过期：超过 5 分钟被拒（expired）", async () => {
    const offer = await h.newOffer();
    expect(offer.expiresAt).toBe(h.clock.t + 5 * 60 * 1000);
    h.clock.advance(5 * 60 * 1000 + 1);
    const phone = await RemotePhone.open(h.port, { mode: "pair", offer, deviceName: "A" });
    expect(await phone.outcome).toEqual({ type: "auth_failed", reason: "expired" });
  });

  test("新签发作废旧的：旧 offer 被拒，新 offer 可用", async () => {
    const oldOffer = await h.newOffer();
    const newOffer = await h.newOffer();
    expect(newOffer.pairingSecret).not.toBe(oldOffer.pairingSecret);
    const stale = await RemotePhone.open(h.port, { mode: "pair", offer: oldOffer, deviceName: "A" });
    expect(await stale.outcome).toEqual({ type: "auth_failed", reason: "invalid" });
    const fresh = await RemotePhone.open(h.port, { mode: "pair", offer: newOffer, deviceName: "B" });
    expect((await fresh.outcome).type).toBe("paired");
    fresh.close();
  });

  test("offer 里带电脑名、公钥和地址", async () => {
    const offer = await h.newOffer();
    expect(offer.name).toBe("test-pc");
    expect(offer.addresses).toEqual([{ host: "127.0.0.1", port: h.port, kind: "lan" }]);
    expect(decodeOfferUrl(encodeOfferUrl(offer))).toEqual(offer);
  });

  test("challenge 不符：回 invalid 并断开，且不消耗配对密钥", async () => {
    const offer = await h.newOffer();
    const raw = await RawPhone.open(h.port);
    await raw.handshake(offer.daemonPublicKey);
    raw.sendJson({ type: "pair", pairingSecret: offer.pairingSecret, challenge: "bogus", deviceName: "x" });
    expect(await raw.readJson()).toEqual({ type: "auth_failed", reason: "invalid" });
    expect(await raw.closed).toBeGreaterThan(0);

    // 用了错误 challenge 的尝试没有消耗配对密钥
    const phone = await RemotePhone.open(h.port, { mode: "pair", offer, deviceName: "ok" });
    expect((await phone.outcome).type).toBe("paired");
    phone.close();
  });

  test("沿用旧连接的 challenge 重放无效（challenge 每连接新生成）", async () => {
    const offer = await h.newOffer();
    const first = await RawPhone.open(h.port);
    await first.handshake(offer.daemonPublicKey);
    const second = await RawPhone.open(h.port);
    await second.handshake(offer.daemonPublicKey);
    expect(second.challenge).not.toBe(first.challenge);
    second.sendJson({ type: "pair", pairingSecret: offer.pairingSecret, challenge: first.challenge, deviceName: "x" });
    expect(await second.readJson()).toEqual({ type: "auth_failed", reason: "invalid" });
    first.ws.close();
  });
});

describe("握手：认证", () => {
  test("凭据错误：invalid", async () => {
    const { phone, deviceId, offer } = await h.pairPhone();
    phone.close();
    const bad = await RemotePhone.open(h.port, {
      mode: "auth",
      daemonPublicKey: offer.daemonPublicKey,
      deviceId,
      deviceSecret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    });
    expect(await bad.outcome).toEqual({ type: "auth_failed", reason: "invalid" });
  });

  test("未知 deviceId：invalid", async () => {
    const offer = await h.newOffer();
    const bad = await RemotePhone.open(h.port, {
      mode: "auth",
      daemonPublicKey: offer.daemonPublicKey,
      deviceId: "no-such-device",
      deviceSecret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    });
    expect(await bad.outcome).toEqual({ type: "auth_failed", reason: "invalid" });
  });

  test("已吊销设备：用原凭据认证返回 revoked", async () => {
    const { phone, deviceId, deviceSecret, offer } = await h.pairPhone();
    await h.local.call("remote.devices.revoke", { deviceId });
    await phone.closed;
    const again = await RemotePhone.open(h.port, {
      mode: "auth",
      daemonPublicKey: offer.daemonPublicKey,
      deviceId,
      deviceSecret,
    });
    expect(await again.outcome).toEqual({ type: "auth_failed", reason: "revoked" });
  });

  test("daemon 公钥不符的客户端解不开也得不到任何回复", async () => {
    const offer = await h.newOffer();
    const raw = await RawPhone.open(h.port);
    // 用一把无关的 daemon 公钥派生共享密钥：服务端解不开首个加密帧，直接断开
    const other = nacl.box.keyPair();
    await raw.handshake(Buffer.from(other.publicKey).toString("base64"));
    raw.sendJson({ type: "pair", pairingSecret: offer.pairingSecret, challenge: raw.challenge, deviceName: "x" });
    expect(await raw.closed).toBeGreaterThan(0);
    expect(raw.binaries).toHaveLength(0);
  });
});

describe("连接超时与限流", () => {
  test("连上后不握手：认证超时断开", async () => {
    await h.close();
    h = await startHarness({ enable: true, tuning: { authTimeoutMs: 200 } });
    const raw = await RawPhone.open(h.port);
    expect(await raw.closed).toBe(1008);
  });

  test("握手后迟迟不认证：超时断开", async () => {
    await h.close();
    h = await startHarness({ enable: true, tuning: { authTimeoutMs: 300 } });
    const offer = await h.newOffer();
    const raw = await RawPhone.open(h.port);
    await raw.handshake(offer.daemonPublicKey);
    expect(await raw.closed).toBe(1008);
  });

  test("认证成功的连接不受认证超时影响", async () => {
    await h.close();
    h = await startHarness({ enable: true, tuning: { authTimeoutMs: 300 } });
    const { phone } = await h.pairPhone();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await phone.call("sidecar.info")).toMatchObject({ version: "9.9.9-test" });
    phone.close();
  });

  test("同一来源 IP 连续 5 次认证失败后冷却 60 秒，冷却结束恢复", async () => {
    const offer = await h.newOffer();
    for (let i = 0; i < 5; i++) {
      const bad = await RemotePhone.open(h.port, {
        mode: "auth",
        daemonPublicKey: offer.daemonPublicKey,
        deviceId: "ghost",
        deviceSecret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      });
      expect((await bad.outcome).type).toBe("auth_failed");
      await bad.closed;
    }
    expect(await upgradeStatus(h.port)).toBe(429);
    h.clock.advance(59_000);
    expect(await upgradeStatus(h.port)).toBe(429);
    h.clock.advance(2_000);
    const ok = await RemotePhone.open(h.port, { mode: "pair", offer, deviceName: "A" });
    expect((await ok.outcome).type).toBe("paired");
    ok.close();
  });

  test("认证成功会清零失败计数", async () => {
    const offer = await h.newOffer();
    const badAuth = async () => {
      const bad = await RemotePhone.open(h.port, {
        mode: "auth",
        daemonPublicKey: offer.daemonPublicKey,
        deviceId: "ghost",
        deviceSecret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      });
      await bad.closed;
    };
    for (let i = 0; i < 4; i++) {
      await badAuth();
    }
    const ok = await RemotePhone.open(h.port, { mode: "pair", offer, deviceName: "A" });
    expect((await ok.outcome).type).toBe("paired");
    for (let i = 0; i < 4; i++) {
      await badAuth();
    }
    expect(await upgradeStatus(h.port)).toBe(101);
    ok.close();
  });
});

/** 记录 logger 输出（已按 printf 风格格式化） */
function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const push = (level: string) => (message: string, ...args: unknown[]) => {
    lines.push(`[${level}] ${format(message, ...args)}`);
  };
  return {
    lines,
    logger: { debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error"), close: () => undefined },
  };
}

describe("WS 心跳：连续 2 次无 pong 才终止", () => {
  const INTERVAL = 200;

  async function authedWithoutPong(logs: ReturnType<typeof captureLogger>) {
    await h.close();
    h = await startHarness({ enable: true, tuning: { pingIntervalMs: INTERVAL }, logger: logs.logger });
    const offer = await h.newOffer();
    const raw = await RawPhone.open(h.port);
    await raw.handshake(offer.daemonPublicKey);
    raw.sendJson({ type: "pair", pairingSecret: offer.pairingSecret, challenge: raw.challenge, deviceName: "raw" });
    expect((await raw.readJson()).type).toBe("paired");
    const realPong = raw.ws.pong.bind(raw.ws);
    return { raw, mute: () => (raw.ws.pong = () => undefined), unmute: () => (raw.ws.pong = realPong) };
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  test("漏 1 次 pong 不断开（之后恢复应答则计数清零）", async () => {
    const logs = captureLogger();
    const { raw, mute, unmute } = await authedWithoutPong(logs);
    mute();
    await sleep(INTERVAL * 1.5); // 第 1 次 ping 已发出且被忽略
    unmute();
    await sleep(INTERVAL * 5); // 之后的 ping 都正常应答
    expect(raw.ws.readyState).toBe(WebSocket.OPEN);
    expect(logs.lines.filter((line) => line.includes("心跳无响应"))).toEqual([]);
  });

  test("连续漏 2 次 pong 终止连接，并 warn 记录 device / ip / 存活 / 距上次 pong", async () => {
    const logs = captureLogger();
    const { raw, mute } = await authedWithoutPong(logs);
    mute();
    await sleep(INTERVAL * 2.5); // 已发出 2 次 ping，尚未到第 3 次检查
    expect(raw.ws.readyState).toBe(WebSocket.OPEN);
    await raw.closed;
    const warn = logs.lines.find((line) => line.includes("心跳无响应"));
    expect(warn).toMatch(/^\[warn\] 远程连接连续 2 次心跳无响应，终止（device=\S{8} ip=127\.0\.0\.1 存活=\d+s 距上次pong=\d+ms）$/);
  });
});

describe("断线诊断：远程连接关闭日志", () => {
  async function withLogs() {
    const logs = captureLogger();
    await h.close();
    h = await startHarness({ enable: true, logger: logs.logger });
    const closeLine = async (predicate: (line: string) => boolean = () => true) => {
      for (let i = 0; i < 200; i++) {
        const line = logs.lines.find((l) => l.includes("远程连接关闭") && predicate(l));
        if (line) return line;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`没有等到关闭日志：${logs.lines.join("\n")}`);
    };
    return { logs, closeLine };
  }

  const FIELDS =
    /^\[info\] 远程连接关闭 device=(\S+) ip=127\.0\.0\.1 存活=\d+s code=(\d+) reason=(\S+) by=(local|peer) path=(\S+) 距上次pong=\d+ms buffered=\d+$/;

  test("本端因协议违规关闭：by=local，path 标明原因（首帧二进制 = binary-in-hello）", async () => {
    const { closeLine } = await withLogs();
    const raw = await RawPhone.open(h.port);
    raw.ws.send(new Uint8Array([1, 2, 3]));
    await raw.closed;
    const match = FIELDS.exec(await closeLine());
    expect(match?.slice(1)).toEqual(["-", "1008", expect.any(String), "local", "binary-in-hello", ]);
  });

  test("认证后对端主动关闭：带 device 前 8 位，by=peer、path=peer-close", async () => {
    const { closeLine } = await withLogs();
    const { phone, deviceId } = await h.pairPhone();
    phone.close();
    const match = FIELDS.exec(await closeLine());
    expect(match?.[1]).toBe(deviceId.slice(0, 8));
    expect(match?.[4]).toBe("peer");
    expect(match?.[5]).toBe("peer-close");
  });

  test("吊销设备：path=revoked；rpc-server 的连接 / 断开日志也带 device 前 8 位", async () => {
    const { logs, closeLine } = await withLogs();
    const { phone, deviceId } = await h.pairPhone();
    await h.local.call("remote.devices.revoke", { deviceId });
    await phone.closed;
    const match = FIELDS.exec(await closeLine((l) => l.includes("path=revoked")));
    expect(match?.[1]).toBe(deviceId.slice(0, 8));
    expect(match?.[4]).toBe("local");
    const short = deviceId.slice(0, 8);
    expect(logs.lines.some((l) => l.includes(`远程客户端已连接 device=${short}`))).toBe(true);
    expect(logs.lines.some((l) => l.includes(`远程客户端已断开 device=${short}`))).toBe(true);
  });

  test("认证超时：path=auth-timeout", async () => {
    const logs = captureLogger();
    await h.close();
    h = await startHarness({ enable: true, tuning: { authTimeoutMs: 150 }, logger: logs.logger });
    const raw = await RawPhone.open(h.port);
    await raw.closed;
    for (let i = 0; i < 200 && !logs.lines.some((l) => l.includes("path=auth-timeout")); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(logs.lines.some((l) => l.includes("远程连接关闭") && l.includes("code=1008") && l.includes("path=auth-timeout"))).toBe(true);
  });
});

describe("下行超大消息", () => {
  test("带 id 的响应超限：改发同 id 的 RESPONSE_TOO_LARGE 错误，连接保持可用", async () => {
    const logs = captureLogger();
    await h.close();
    h = await startHarness({ enable: true, tuning: { maxPlaintextBytes: 1_500 }, logger: logs.logger });
    const { phone } = await h.pairPhone();
    for (let i = 0; i < 6; i++) {
      await h.local.call("agent.create", { provider: "mock", cwd: process.cwd() });
    }
    const response = await phone.request("agent.list");
    expect(response.result).toBeUndefined();
    expect(response.error).toMatchObject({ code: -32000, data: { code: "RESPONSE_TOO_LARGE" } });
    expect(response.error?.message).toContain("响应过大");
    // 同一连接上小响应照常
    expect(await phone.call("sidecar.info")).toMatchObject({ version: "9.9.9-test" });
    const warn = logs.lines.find((line) => line.includes("远程下行消息过大") && line.includes("已改发错误响应"));
    expect(warn).toMatch(/device=\S{8} \d+ 字节，上限 1500/);
    phone.close();
  });

  test("通知（无 id）超限：只记日志（含 method），不发错误响应，连接不受影响", async () => {
    const logs = captureLogger();
    await h.close();
    h = await startHarness({ enable: true, tuning: { maxPlaintextBytes: 300 }, logger: logs.logger });
    const { phone } = await h.pairPhone();
    await h.local.call("agent.create", { provider: "mock", cwd: process.cwd() });
    for (let i = 0; i < 200 && !logs.lines.some((l) => l.includes("method=agent.state")); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const warn = logs.lines.find((line) => line.includes("远程下行消息过大") && line.includes("method=agent.state"));
    expect(warn).toBeTruthy();
    expect(warn).not.toContain("已改发错误响应");
    expect(phone.notificationsOf("agent.state")).toEqual([]);
    expect(phone.ws.readyState).toBe(WebSocket.OPEN);
    phone.close();
  });
});

describe("帧与连接", () => {
  async function authedRaw() {
    const offer = await h.newOffer();
    const raw = await RawPhone.open(h.port);
    await raw.handshake(offer.daemonPublicKey);
    raw.sendJson({ type: "pair", pairingSecret: offer.pairingSecret, challenge: raw.challenge, deviceName: "raw" });
    const paired = await raw.readJson();
    expect(paired.type).toBe("paired");
    return raw;
  }

  test("握手首帧必须是文本：二进制首帧断开", async () => {
    const raw = await RawPhone.open(h.port);
    raw.ws.send(new Uint8Array([1, 2, 3]));
    expect(await raw.closed).toBe(1008);
  });

  test("hello 格式错误断开", async () => {
    const raw = await RawPhone.open(h.port);
    raw.ws.send(JSON.stringify({ type: "e2ee_hello", v: 2, clientKey: "x" }));
    expect(await raw.closed).toBe(1008);
  });

  test("hello 公钥非法断开", async () => {
    const raw = await RawPhone.open(h.port);
    raw.ws.send(JSON.stringify({ type: "e2ee_hello", v: 1, clientKey: "AAAA" }));
    expect(await raw.closed).toBe(1008);
  });

  test("握手后发明文文本帧：断开", async () => {
    const offer = await h.newOffer();
    const raw = await RawPhone.open(h.port);
    await raw.handshake(offer.daemonPublicKey);
    raw.ws.send(JSON.stringify({ type: "pair" }));
    expect(await raw.closed).toBe(1008);
  });

  test("认证后发文本帧：断开", async () => {
    const raw = await authedRaw();
    raw.ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "agent.list" }));
    expect(await raw.closed).toBe(1008);
  });

  test("计数回退（重放已接受的帧）：断开", async () => {
    const raw = await authedRaw();
    const frame = raw.sendJson({ jsonrpc: "2.0", id: 1, method: "sidecar.info" });
    const response = await raw.readJson();
    expect(response).toMatchObject({ id: 1, result: { version: "9.9.9-test" } });
    raw.ws.send(frame);
    expect(await raw.closed).toBe(1008);
  });

  test("篡改密文：断开", async () => {
    const raw = await authedRaw();
    const frame = raw.channel!.seal(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sidecar.info" }));
    frame[frame.length - 1] = frame[frame.length - 1]! ^ 0xff;
    raw.ws.send(frame);
    expect(await raw.closed).toBe(1008);
  });

  test("明文超过 16 MiB 的帧：断开", async () => {
    const raw = await authedRaw();
    const nonce = new Uint8Array(24);
    nonce[0] = 0x01;
    nonce[23] = 2;
    const sealed = nacl.box.after(new Uint8Array(16 * 1024 * 1024 + 1), nonce, raw.shared!);
    const frame = new Uint8Array(24 + sealed.length);
    frame.set(nonce, 0);
    frame.set(sealed, 24);
    raw.ws.send(frame);
    expect(await raw.closed).toBeGreaterThan(0);
  });

  test("认证后的非 JSON 明文不会让连接崩溃，回 -32700 即可", async () => {
    const raw = await authedRaw();
    const frame = raw.channel!.seal("not json");
    raw.ws.send(frame);
    expect(await raw.readJson()).toMatchObject({ error: { code: -32700 } });
    raw.ws.close();
  });

  test("吊销后在线连接立即被断开，设备从列表消失，本机收到 remote.changed", async () => {
    const { phone, deviceId } = await h.pairPhone();
    expect(await phone.call("sidecar.info")).toBeTruthy();
    const changed = h.local.notifications.filter((n) => n.method === "remote.changed").length;
    await h.local.call("remote.devices.revoke", { deviceId });
    await phone.closed;
    const status = await h.local.call("remote.status");
    expect(status.devices).toEqual([]);
    expect(h.local.notifications.filter((n) => n.method === "remote.changed").length).toBeGreaterThan(changed);
  });

  test("吊销会断开该设备的全部连接，不影响其它设备", async () => {
    const a = await h.pairPhone("A");
    const b = await h.pairPhone("B");
    const a2 = await RemotePhone.open(h.port, {
      mode: "auth",
      daemonPublicKey: a.offer.daemonPublicKey,
      deviceId: a.deviceId,
      deviceSecret: a.deviceSecret,
    });
    expect((await a2.outcome).type).toBe("authed");
    await h.local.call("remote.devices.revoke", { deviceId: a.deviceId });
    await Promise.all([a.phone.closed, a2.closed]);
    expect(await b.phone.call("sidecar.info")).toBeTruthy();
    b.phone.close();
  });

  test("断开后 lastSeenAt 被记录，connected 变为 false", async () => {
    const { phone } = await h.pairPhone();
    h.clock.advance(5_000);
    phone.close();
    await phone.closed;
    for (let i = 0; i < 50; i++) {
      const status = await h.local.call("remote.status");
      if (!status.devices[0]!.connected && status.devices[0]!.lastSeenAt === h.clock.t) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("lastSeenAt 未更新");
  });
});

describe("认证后的远程连接", () => {
  test("能调用 agent.list / provider.list 等普通方法", async () => {
    const { phone } = await h.pairPhone();
    const { agent } = await h.local.call("agent.create", { provider: "mock", cwd: process.cwd() });
    const listed = await phone.call<{ agents: Array<{ id: string }> }>("agent.list");
    expect(listed.agents.map((a) => a.id)).toContain(agent.id);
    phone.close();
  });

  test("收到本机创建会话产生的 agent.state 与 agent.stream 广播", async () => {
    const { phone } = await h.pairPhone();
    const { agent } = await h.local.call("agent.create", { provider: "mock", cwd: process.cwd() });
    await phone.waitFor(() => phone.notificationsOf("agent.state").length > 0);
    expect((phone.notificationsOf("agent.state")[0] as { agent: { id: string } }).agent.id).toBe(agent.id);
    await h.local.call("agent.send", { agentId: agent.id, prompt: "你好" });
    await phone.waitFor(() => phone.notificationsOf("agent.stream").length > 3);
    phone.close();
  });

  test("远程客户端也能发消息并收到流式输出", async () => {
    const { phone } = await h.pairPhone();
    const { agent } = await phone.call<{ agent: { id: string } }>("agent.create", {
      provider: "mock",
      cwd: process.cwd(),
    });
    await phone.call("agent.send", { agentId: agent.id, prompt: "hi" });
    await phone.waitFor(() =>
      phone
        .notificationsOf("agent.stream")
        .some((p) => (p as { event: { type: string } }).event.type === "turn_completed"),
    );
    phone.close();
  });

  test("settings.set / remote.* / provider.config.* 返回 -32601；settings.get 可用；已删除的 client.presence 同样不存在", async () => {
    const { phone } = await h.pairPhone();
    for (const [method, params] of [
      ["settings.set", { patch: { remote: { enabled: false } } }],
      ["remote.status", undefined],
      ["remote.pairing.create", undefined],
      ["remote.devices.revoke", { deviceId: "x" }],
      ["provider.config.get", undefined],
      ["provider.config.set", { providers: [] }],
    ] as const) {
      const error = await phone.errorOf(method, params);
      expect(error?.code, method).toBe(-32601);
    }
    // 没有被偷偷改掉
    expect((await h.local.call("settings.get")).remote.enabled).toBe(true);
    expect(await phone.call("settings.get")).toMatchObject({ remote: { enabled: true } });
    expect((await phone.errorOf("client.presence", { kind: "mobile", visible: true }))?.code).toBe(-32601);
    // 本机仍可读 provider 配置；手机能用的 provider.list 不含密钥字段
    expect(await h.local.call("provider.config.get")).toMatchObject({ providers: [] });
    expect(JSON.stringify(await phone.call("provider.list"))).not.toMatch(/apiKey/);
    phone.close();
  });

  test("remote.changed 只发给本机客户端，不发给手机", async () => {
    const { phone } = await h.pairPhone();
    const second = await h.pairPhone("第二台");
    await h.local.waitFor(() => h.local.notifications.filter((n) => n.method === "remote.changed").length > 1);
    expect(phone.notificationsOf("remote.changed")).toEqual([]);
    phone.close();
    second.phone.close();
  });

  test("未认证的连接收不到任何广播", async () => {
    const offer = await h.newOffer();
    const raw = await RawPhone.open(h.port);
    await raw.handshake(offer.daemonPublicKey);
    await h.local.call("agent.create", { provider: "mock", cwd: process.cwd() });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(raw.binaries).toHaveLength(0);
    raw.ws.close();
  });

  test("本机 /rpc 行为不变：remote.status 与 settings.set 可调用", async () => {
    const status = await h.local.call("remote.status");
    expect(status).toMatchObject({ enabled: true, port: h.port, listening: true });
    expect(await h.local.call("settings.set", { patch: { interop: { enabled: true } } })).toMatchObject({
      interop: { enabled: true },
    });
  });
});
