import { describe, expect, it } from "vitest";
import { buildQrSvg, formatCountdown } from "./qr-svg";

describe("buildQrSvg", () => {
  it("生成带 4 模块静区的方形 viewBox，path 由矩形段组成", () => {
    const qr = buildQrSvg("agentdeck://pair#abc");
    // 版本 1 为 21 模块，加上两侧各 4 的静区；文本更长时版本更大，总之 size = 模块数 + 8 且为奇数
    expect(qr.size).toBeGreaterThanOrEqual(29);
    expect((qr.size - 8) % 4).toBe(1);
    expect(qr.path).toMatch(/^(M\d+ \d+h\d+v1h-\d+z)+$/);
  });

  it("所有矩形都落在静区之内", () => {
    const qr = buildQrSvg(`agentdeck://pair#${"x".repeat(300)}`);
    for (const match of qr.path.matchAll(/M(\d+) (\d+)h(\d+)v1/g)) {
      const [x, y, w] = [Number(match[1]), Number(match[2]), Number(match[3])];
      expect(x).toBeGreaterThanOrEqual(4);
      expect(y).toBeGreaterThanOrEqual(4);
      expect(x + w).toBeLessThanOrEqual(qr.size - 4);
      expect(y + 1).toBeLessThanOrEqual(qr.size - 4);
    }
  });

  it("相同输入结果稳定，不同输入结果不同", () => {
    expect(buildQrSvg("a")).toEqual(buildQrSvg("a"));
    expect(buildQrSvg("a").path).not.toBe(buildQrSvg("b").path);
  });
});

describe("formatCountdown", () => {
  it("mm:ss，向上取整到秒，不为负", () => {
    expect(formatCountdown(300_000)).toBe("05:00");
    expect(formatCountdown(299_001)).toBe("05:00");
    expect(formatCountdown(61_000)).toBe("01:01");
    expect(formatCountdown(999)).toBe("00:01");
    expect(formatCountdown(0)).toBe("00:00");
    expect(formatCountdown(-5)).toBe("00:00");
  });
});
