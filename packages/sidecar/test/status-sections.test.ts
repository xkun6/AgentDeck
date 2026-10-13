import { describe, expect, test } from "vitest";

import { buildMcpSection, formatResetsIn, formatWindowLabel } from "../src/agent/status-sections.js";
import { buildCodexAccountSection, buildCodexRateLimitSection } from "../src/providers/codex/codex-agent.js";

describe("status-sections", () => {
  test("MCP 概览：按状态计数，未连接的逐个列出；空列表与失败降级", async () => {
    await expect(
      buildMcpSection(async () => ({
        reconnect: "all",
        servers: [
          { name: "a", status: "connected" },
          { name: "b", status: "disabled" },
          { name: "c", status: "pending" },
        ],
      })),
    ).resolves.toEqual({
      title: "MCP",
      rows: [
        { label: "概览", value: "3 个服务器：1 已连接，1 连接中，1 已禁用" },
        { label: "b", value: "已禁用" },
        { label: "c", value: "连接中" },
      ],
    });
    await expect(buildMcpSection(async () => ({ reconnect: "all", servers: [] }))).resolves.toEqual({
      title: "MCP",
      rows: [{ label: "概览", value: "未配置 MCP 服务器" }],
    });
    await expect(
      buildMcpSection(async () => {
        throw new Error("boom");
      }),
    ).resolves.toEqual({ title: "MCP", rows: [{ label: "状态", value: "读取失败：boom" }] });
  });

  test("窗口与重置时间格式化", () => {
    expect(formatWindowLabel(300)).toBe("5 小时");
    expect(formatWindowLabel(10080)).toBe("每周");
    expect(formatWindowLabel(2880)).toBe("2 天");
    expect(formatWindowLabel(45)).toBe("45 分钟");
    expect(formatWindowLabel(null)).toBe("用量");
    const now = 1_000_000_000_000;
    expect(formatResetsIn(now / 1000 + 8100, now)).toBe("约 2 小时 15 分钟后重置");
    expect(formatResetsIn(now / 1000 + 3 * 86400 + 7200, now)).toBe("约 3 天 2 小时后重置");
    expect(formatResetsIn(now / 1000 + 10, now)).toBe("即将重置");
    expect(formatResetsIn(null, now)).toBeUndefined();
  });

  test("Codex 账户 / 用量分组：各类账户；无窗口返回 null", () => {
    expect(buildCodexAccountSection({ account: { type: "apiKey" }, requiresOpenaiAuth: false })?.rows).toEqual([
      { label: "登录方式", value: "API Key" },
    ]);
    expect(buildCodexAccountSection({ account: { type: "amazonBedrock" } })?.rows).toEqual([
      { label: "登录方式", value: "Amazon Bedrock" },
    ]);
    expect(buildCodexAccountSection(null)).toBeNull();
    const now = 1_000_000_000_000;
    expect(
      buildCodexRateLimitSection(
        {
          rateLimits: {
            primary: { usedPercent: 12.6, windowDurationMins: null, resetsAt: now / 1000 + 600 },
            secondary: null,
          },
        },
        now,
      ),
    ).toEqual({ title: "用量限制", rows: [{ label: "主要窗口", value: "已用 13%，约 10 分钟后重置" }] });
    expect(buildCodexRateLimitSection({ rateLimits: { primary: null, secondary: null } })).toBeNull();
  });
});
