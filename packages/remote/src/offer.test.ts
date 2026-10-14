import { describe, expect, test } from "vitest";

import { fromBase64, fromBase64Url, toBase64, toBase64Url } from "./base64.js";
import { decodeOfferUrl, encodeOfferUrl, OFFER_URL_PREFIX, OfferError, type RemoteConnectionOffer } from "./offer.js";
import { generateKeyPair, exportKey } from "./keys.js";

function sampleOffer(patch: Partial<Record<keyof RemoteConnectionOffer, unknown>> = {}): RemoteConnectionOffer {
  return {
    v: 1,
    name: "我的电脑",
    daemonPublicKey: exportKey(generateKeyPair().publicKey),
    addresses: [
      { host: "192.168.1.20", port: 47631, kind: "lan" },
      { host: "100.101.102.103", port: 47631, kind: "tailscale" },
    ],
    pairingSecret: "A".repeat(43),
    expiresAt: 1_800_000_000_000,
    ...patch,
  } as RemoteConnectionOffer;
}

function rawUrl(payload: unknown): string {
  return OFFER_URL_PREFIX + toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

describe("base64 工具", () => {
  test("各种长度往返", () => {
    for (let length = 0; length < 40; length++) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 11) & 255);
      expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes));
      expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(Array.from(bytes));
    }
  });

  test("与标准实现一致，url 变体无填充且替换 +/", () => {
    const bytes = Uint8Array.from([251, 255, 190, 1, 2]);
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    expect(toBase64Url(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
  });

  test("非法输入抛错", () => {
    expect(() => fromBase64("abc")).toThrow();
    expect(() => fromBase64("ab!d")).toThrow();
    expect(() => fromBase64("QR==")).toThrow(); // 非规范填充位
    expect(() => fromBase64Url("a")).toThrow();
    expect(() => fromBase64Url("ab+/")).toThrow();
  });
});

describe("RemoteConnectionOffer 编解码", () => {
  test("agentdeck://pair#base64url 往返", () => {
    const offer = sampleOffer();
    const url = encodeOfferUrl(offer);
    expect(url.startsWith("agentdeck://pair#")).toBe(true);
    expect(url.slice(OFFER_URL_PREFIX.length)).not.toMatch(/[+/=]/);
    expect(decodeOfferUrl(url)).toEqual(offer);
    expect(decodeOfferUrl(`  ${url}\n`)).toEqual(offer);
  });

  test("前缀不符 / 载荷损坏 / 非 JSON 都报 OfferError", () => {
    expect(() => decodeOfferUrl("https://example.com/#abc")).toThrow(OfferError);
    expect(() => decodeOfferUrl(`${OFFER_URL_PREFIX}!!!`)).toThrow(OfferError);
    expect(() => decodeOfferUrl(OFFER_URL_PREFIX + toBase64Url(new TextEncoder().encode("not json")))).toThrow(OfferError);
    expect(() => decodeOfferUrl(OFFER_URL_PREFIX)).toThrow(OfferError);
  });

  test.each([
    ["版本号错误", { v: 2 }],
    ["name 为空", { name: "" }],
    ["name 不是字符串", { name: 5 }],
    ["公钥不是 base64", { daemonPublicKey: "***" }],
    ["公钥长度不对", { daemonPublicKey: toBase64(new Uint8Array(16)) }],
    ["地址为空", { addresses: [] }],
    ["地址不是数组", { addresses: "x" }],
    ["端口为 0", { addresses: [{ host: "1.2.3.4", port: 0, kind: "lan" }] }],
    ["端口超范围", { addresses: [{ host: "1.2.3.4", port: 70000, kind: "lan" }] }],
    ["端口非整数", { addresses: [{ host: "1.2.3.4", port: 1.5, kind: "lan" }] }],
    ["kind 非法", { addresses: [{ host: "1.2.3.4", port: 80, kind: "wan" }] }],
    ["host 含非法字符", { addresses: [{ host: "1.2.3.4/evil", port: 80, kind: "lan" }] }],
    ["pairingSecret 太短", { pairingSecret: "abc" }],
    ["pairingSecret 含非法字符", { pairingSecret: "!".repeat(43) }],
    ["expiresAt 非数字", { expiresAt: "soon" }],
    ["expiresAt 非有限", { expiresAt: null }],
  ])("非法字段被拒：%s", (_label, patch) => {
    expect(() => decodeOfferUrl(rawUrl(sampleOffer(patch as never)))).toThrow(OfferError);
  });

  test("缺少字段与非对象载荷被拒", () => {
    const { pairingSecret: _omit, ...rest } = sampleOffer();
    expect(() => decodeOfferUrl(rawUrl(rest))).toThrow(OfferError);
    expect(() => decodeOfferUrl(rawUrl([1, 2]))).toThrow(OfferError);
    expect(() => decodeOfferUrl(rawUrl(null))).toThrow(OfferError);
  });

  test("encodeOfferUrl 也会拒绝非法 offer", () => {
    expect(() => encodeOfferUrl(sampleOffer({ addresses: [] }))).toThrow(OfferError);
  });

  test("多余字段被丢弃", () => {
    const decoded = decodeOfferUrl(rawUrl({ ...sampleOffer(), extra: "x" }));
    expect("extra" in decoded).toBe(false);
  });
});
