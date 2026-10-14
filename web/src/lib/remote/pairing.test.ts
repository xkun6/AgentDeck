import { describe, expect, it } from "vitest";
import { encodeOfferUrl, type RemoteConnectionOffer } from "@agentdeck/remote";
import { PairingError, parsePairingInput } from "./pairing";

const NOW = 1_800_000_000_000;

function offer(overrides: Partial<RemoteConnectionOffer> = {}): RemoteConnectionOffer {
  return {
    v: 1,
    name: "我的电脑",
    daemonPublicKey: Buffer.alloc(32, 7).toString("base64"),
    addresses: [
      { host: "192.168.1.8", port: 47631, kind: "lan" },
      { host: "100.64.0.2", port: 47631, kind: "tailscale" },
    ],
    pairingSecret: "A".repeat(43),
    expiresAt: NOW + 5 * 60_000,
    ...overrides,
  };
}

describe("parsePairingInput", () => {
  it("解析标准链接", () => {
    const parsed = parsePairingInput(encodeOfferUrl(offer()), NOW);
    expect(parsed.name).toBe("我的电脑");
    expect(parsed.addresses).toHaveLength(2);
  });

  it("接受前后带说明文字的整段粘贴", () => {
    const link = encodeOfferUrl(offer());
    const parsed = parsePairingInput(`请在手机上打开：\n${link}\n(5 分钟内有效)`, NOW);
    expect(parsed.pairingSecret).toBe("A".repeat(43));
  });

  it("没有链接 → link 类错误，提示以 agentdeck://pair# 开头", () => {
    try {
      parsePairingInput("https://example.com/hello", NOW);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PairingError);
      expect((error as PairingError).kind).toBe("link");
      expect((error as PairingError).message).toContain("agentdeck://pair#");
    }
  });

  it("链接被截断或损坏 → 提示重新复制", () => {
    const link = encodeOfferUrl(offer());
    expect(() => parsePairingInput(link.slice(0, link.length - 20), NOW)).toThrow(/损坏或不完整/);
    expect(() => parsePairingInput("agentdeck://pair#", NOW)).toThrow(PairingError);
  });

  it("已过期 → expired 类错误，提示在电脑上重新生成", () => {
    const link = encodeOfferUrl(offer({ expiresAt: NOW - 1 }));
    try {
      parsePairingInput(link, NOW);
      expect.unreachable();
    } catch (error) {
      expect((error as PairingError).kind).toBe("expired");
      expect((error as PairingError).message).toContain("重新生成");
    }
  });
});
