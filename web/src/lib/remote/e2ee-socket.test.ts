// @vitest-environment node
// E2eeSocket 的赢家连接协议错误：认证成功后发生的解密失败 / 计数回退必须真正关闭连接（design.md 4.31），
// 不能让会话静默失败、继续挂着一条再也收不到数据的半死连接。
import { describe, expect, it } from "vitest";
import {
  deriveSharedKey,
  E2eeChannel,
  exportKey,
  generateKeyPair,
  importPublicKey,
} from "@agentdeck/remote";
import { ConnectionEventLog } from "../connection-log";
import { E2eeSocket, type RawSocket } from "./e2ee-socket";

/** 扮演网关的假 socket：收到 hello 回 ready，收到加密的 auth 回 authed，之后由测试推帧 */
class FakeGatewaySocket implements RawSocket {
  binaryType = "arraybuffer";
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed: { code?: number; reason?: string } | null = null;
  channel: E2eeChannel | null = null;
  private sentFrames = 0;

  constructor(private readonly serverKeys: ReturnType<typeof generateKeyPair>) {}

  send(data: string | Uint8Array): void {
    if (typeof data === "string") {
      const hello = JSON.parse(data) as { clientKey: string };
      const shared = deriveSharedKey(this.serverKeys.secretKey, importPublicKey(hello.clientKey));
      this.channel = new E2eeChannel(shared, "server");
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "e2ee_ready", v: 1, challenge: "c" }) }));
      return;
    }
    this.sentFrames += 1;
    if (this.sentFrames === 1) {
      queueMicrotask(() => this.deliver(this.channel!.seal(JSON.stringify({ type: "authed", name: "pc" }))));
    }
  }

  deliver(frame: Uint8Array): void {
    const copy = frame.slice();
    this.onmessage?.({ data: copy.buffer });
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
}

async function openAuthed(eventLog?: ConnectionEventLog) {
  const serverKeys = generateKeyPair();
  const raw = new FakeGatewaySocket(serverKeys);
  const socket = new E2eeSocket({
    addresses: [{ host: "10.0.0.2", port: 1 }],
    credentials: {
      mode: "auth",
      daemonPublicKey: exportKey(serverKeys.publicKey),
      deviceId: "d",
      deviceSecret: "s",
    },
    createSocket: () => raw,
    ...(eventLog ? { eventLog } : {}),
  });
  const received: string[] = [];
  socket.onmessage = (event) => received.push(event.data);
  const closes: Array<{ code: number; reason: string; wasClean: boolean }> = [];
  socket.onclose = (event) => closes.push(event);
  const opened = new Promise<void>((resolve) => {
    socket.onopen = () => resolve();
  });
  await Promise.resolve();
  raw.onopen?.({});
  await opened;
  return { socket, raw, received, closes };
}

describe("E2eeSocket 赢家连接的协议错误", () => {
  it("认证后收到非法的帧（方向 / 解密失败）：关闭底层连接并以 1011 / protocol_error 结束", async () => {
    const { socket, raw, received, closes } = await openAuthed();
    expect(socket.readyState).toBe(E2eeSocket.OPEN);

    raw.deliver(raw.channel!.seal(JSON.stringify({ hello: 1 })));
    expect(received).toEqual(['{"hello":1}']);

    raw.deliver(new Uint8Array(80).fill(7));
    expect(raw.closed?.code).toBe(1011);
    expect(socket.readyState).toBe(E2eeSocket.CLOSED);
    expect(closes).toHaveLength(1);
    expect(closes[0]!.code).toBe(1011);
    expect(closes[0]!.reason).toMatch(/^protocol_error:(bad_direction|decrypt_failed)$/);
    expect(closes[0]!.wasClean).toBe(false);
  });

  it("认证后帧计数回退（重放已接受的帧）：同样关闭连接", async () => {
    const { socket, raw, received, closes } = await openAuthed();
    const frame = raw.channel!.seal(JSON.stringify({ n: 1 }));
    raw.deliver(frame);
    raw.deliver(frame);
    expect(received).toEqual(['{"n":1}']);
    expect(raw.closed?.code).toBe(1011);
    expect(closes[0]?.reason).toBe("protocol_error:replay");
    expect(socket.readyState).toBe(E2eeSocket.CLOSED);
  });

  it("关闭之后不再向上投递帧，也不会重复触发 onclose", async () => {
    const { raw, received, closes } = await openAuthed();
    raw.deliver(new Uint8Array(80).fill(7));
    raw.deliver(raw.channel!.seal(JSON.stringify({ late: true })));
    expect(received).toEqual([]);
    expect(closes).toHaveLength(1);
  });
});

describe("E2eeSocket 连接事件记录", () => {
  it("每个地址尝试的结果与耗时：成功记 attempt-ok，赢家协议错误记 protocol-error", async () => {
    const log = new ConnectionEventLog();
    const { raw } = await openAuthed(log);
    expect(log.entries()).toHaveLength(1);
    expect(log.entries()[0]).toMatchObject({ event: "attempt-ok", address: "10.0.0.2:1" });
    expect(log.entries()[0]!.durationMs).toBeGreaterThanOrEqual(0);

    raw.deliver(new Uint8Array(80).fill(7));
    expect(log.entries()[1]).toMatchObject({ event: "protocol-error", address: "10.0.0.2:1" });
    expect(log.entries()[1]!.detail).toMatch(/bad_direction|decrypt_failed/);
  });

  it("地址连不上：记 attempt-fail 与失败原因", async () => {
    const log = new ConnectionEventLog();
    const serverKeys = generateKeyPair();
    const socket = new E2eeSocket({
      addresses: [{ host: "10.0.0.9", port: 1 }],
      credentials: { mode: "auth", daemonPublicKey: exportKey(serverKeys.publicKey), deviceId: "d", deviceSecret: "s" },
      createSocket: () => {
        throw new Error("网络不可达");
      },
      eventLog: log,
    });
    const closed = new Promise<{ code: number }>((resolve) => {
      socket.onclose = resolve;
    });
    expect((await closed).code).toBe(1006);
    expect(log.entries()).toHaveLength(1);
    expect(log.entries()[0]).toMatchObject({ event: "attempt-fail", address: "10.0.0.9:1", detail: "网络不可达" });
  });
});
