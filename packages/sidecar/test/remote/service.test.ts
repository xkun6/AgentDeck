import { createServer, type Server } from "node:net";

import { afterEach, describe, expect, test } from "vitest";

import { freePort, RemotePhone, startHarness, type Harness } from "./harness.js";

let h: Harness | null = null;
const blockers: Server[] = [];

afterEach(async () => {
  await h?.close();
  h = null;
  for (const server of blockers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function occupy(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    blockers.push(server);
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

describe("settings.remote", () => {
  test("默认关闭、端口 47631，不监听", async () => {
    h = await startHarness();
    expect((await h.local.call("settings.get")).remote).toEqual({ enabled: false, port: 47_631 });
    expect(await h.local.call("remote.status")).toMatchObject({
      enabled: false,
      port: 47_631,
      listening: false,
      devices: [],
    });
  });

  test("settings.set 启用后开始监听，关闭后停止监听并断开全部远程连接", async () => {
    h = await startHarness();
    await h.enable();
    expect(await h.local.call("remote.status")).toMatchObject({ enabled: true, port: h.port, listening: true });
    const { phone } = await h.pairPhone();

    await h.local.call("settings.set", { patch: { remote: { enabled: false } } });
    await phone.closed;
    expect(await h.local.call("remote.status")).toMatchObject({ enabled: false, listening: false });
    await expect(RemotePhone.open(h.port, { mode: "pair", offer: await fakeOffer(), deviceName: "x" })).rejects.toBeTruthy();
  });

  test("启停与设备变化都会广播 remote.changed", async () => {
    const harness = await startHarness();
    h = harness;
    await harness.enable();
    await harness.local.waitFor(() => harness.local.notifications.some((n) => n.method === "remote.changed"));
    const last = harness.local.notifications.filter((n) => n.method === "remote.changed").at(-1)!.params as {
      listening: boolean;
    };
    expect(last.listening).toBe(true);
  });

  test("修改端口会在新端口重启，旧端口释放", async () => {
    h = await startHarness();
    await h.enable();
    const oldPort = h.port;
    const newPort = await freePort();
    await h.local.call("settings.set", { patch: { remote: { port: newPort } } });
    expect(await h.local.call("remote.status")).toMatchObject({ port: newPort, listening: true });
    h.port = newPort;
    const { phone } = await h.pairPhone();
    phone.close();
    await expect(RemotePhone.open(oldPort, { mode: "pair", offer: await fakeOffer(), deviceName: "x" })).rejects.toBeTruthy();
  });

  test("无关设置变化不会重启网关（已有连接保持）", async () => {
    h = await startHarness();
    await h.enable();
    const { phone } = await h.pairPhone();
    await h.local.call("settings.set", { patch: { interop: { enabled: false } } });
    expect(await phone.call("sidecar.info")).toBeTruthy();
    phone.close();
  });

  test("端口被占用：status.error 给出中文原因，sidecar 不崩溃，换端口后恢复", async () => {
    h = await startHarness();
    const busy = await freePort();
    await occupy(busy);
    await h.local.call("settings.set", { patch: { remote: { enabled: true, port: busy } } });
    const status = await h.local.call("remote.status");
    expect(status.listening).toBe(false);
    expect(status.enabled).toBe(true);
    expect(status.error).toContain("已被占用");
    // sidecar 仍可正常工作
    expect(await h.local.call("sidecar.info")).toBeTruthy();
    expect(await h.local.call("agent.list")).toEqual({ agents: [] });
    // 无法在未监听时签发配对
    const failed = await h.local.request("remote.pairing.create");
    expect(failed.error).toMatchObject({ code: -32000, data: { code: "NOT_SUPPORTED" } });

    const good = await freePort();
    await h.local.call("settings.set", { patch: { remote: { port: good } } });
    const recovered = await h.local.call("remote.status");
    expect(recovered).toMatchObject({ listening: true, port: good });
    expect(recovered.error).toBeUndefined();
  });

  test("未设置数据目录时不能启用，给出中文原因", async () => {
    h = await startHarness({ dataDir: null });
    await h.local.call("settings.set", { patch: { remote: { enabled: true, port: await freePort() } } });
    const status = await h.local.call("remote.status");
    expect(status.listening).toBe(false);
    expect(status.error).toContain("数据目录");
  });

  test("端口范围与未知字段由 schema 拒绝（-32602）", async () => {
    h = await startHarness();
    for (const patch of [
      { remote: { port: 80 } },
      { remote: { port: 70_000 } },
      { remote: { port: 1.5 } },
      { remote: { enabled: "yes" } },
      { remote: { extra: 1 } },
    ]) {
      const response = await h.local.request("settings.set", { patch });
      expect(response.error?.code, JSON.stringify(patch)).toBe(-32602);
    }
  });

  test("没有可用网络地址时拒绝签发配对", async () => {
    h = await startHarness({ addresses: () => [] });
    await h.enable();
    const response = await h.local.request("remote.pairing.create");
    expect(response.error).toMatchObject({ code: -32000, data: { code: "NOT_SUPPORTED" } });
  });

  test("吊销不存在的设备返回 -32602", async () => {
    h = await startHarness();
    await h.enable();
    const response = await h.local.request("remote.devices.revoke", { deviceId: "nope" });
    expect(response.error?.code).toBe(-32602);
  });

  test("重启后设置、密钥对和设备表仍在（同一数据目录）", async () => {
    h = await startHarness();
    await h.enable();
    const first = await h.pairPhone("持久化");
    first.phone.close();
    await first.phone.closed;
    const { dataDir, port } = h;
    await h.local.close();
    await h.remote.stop();
    await h.manager.shutdown();
    await h.server.close();

    // 用同一数据目录再起一个实例
    const next = await startHarness({ dataDir: dataDir! });
    h = next;
    expect((await next.local.call("settings.get")).remote).toMatchObject({ enabled: true, port });
    const status = await next.local.call("remote.status");
    expect(status.listening).toBe(true);
    expect(status.devices.map((d) => d.deviceId)).toEqual([first.deviceId]);
    // 旧凭据仍能认证（公钥没有变）
    const again = await RemotePhone.open(port, {
      mode: "auth",
      daemonPublicKey: first.offer.daemonPublicKey,
      deviceId: first.deviceId,
      deviceSecret: first.deviceSecret,
    });
    expect((await again.outcome).type).toBe("authed");
    again.close();
  });
});

async function fakeOffer() {
  const { generateKeyPair, exportKey } = await import("@agentdeck/remote");
  return {
    v: 1 as const,
    name: "x",
    daemonPublicKey: exportKey(generateKeyPair().publicKey),
    addresses: [{ host: "127.0.0.1", port: 1, kind: "lan" as const }],
    pairingSecret: "A".repeat(43),
    expiresAt: Date.now() + 1000,
  };
}
