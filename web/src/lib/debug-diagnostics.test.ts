import { describe, expect, it } from "vitest";
import {
  buildDiagnostics,
  countSessionsByStatus,
  eventsToJsonl,
  filterLogText,
  sidecarPort,
} from "./debug-diagnostics";

const LOG = [
  "2026-01-01T00:00:00.000Z [info] sidecar 启动",
  "2026-01-01T00:00:01.000Z [warn] provider 不可用 codex",
  "2026-01-01T00:00:02.000Z [error] 请求失败 Boom",
  "    at stack line 1",
  "2026-01-01T00:00:03.000Z [debug] 细节",
].join("\n");

describe("filterLogText", () => {
  it("全部 + 无关键字原样返回", () => {
    expect(filterLogText(LOG, "all", "")).toBe(LOG);
  });

  it("警告及以上包含 warn 与 error（含续行）", () => {
    const out = filterLogText(LOG, "warn", "").split("\n");
    expect(out).toHaveLength(3);
    expect(out[0]).toContain("[warn]");
    expect(out[2]).toContain("at stack line 1");
  });

  it("错误级别只留 error 及其续行", () => {
    const out = filterLogText(LOG, "error", "").split("\n");
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("[error]");
  });

  it("关键字不区分大小写，可与级别叠加", () => {
    expect(filterLogText(LOG, "all", "BOOM")).toContain("[error]");
    expect(filterLogText(LOG, "all", "BOOM")).not.toContain("[info]");
    expect(filterLogText(LOG, "error", "codex")).toBe("");
  });
});

describe("buildDiagnostics", () => {
  const input = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    app: { version: "0.1.0", commit: "abc", buildDate: "2026-01-01" },
    sidecar: {
      status: "ready" as const,
      version: "1.0.0",
      error: null,
      wsUrl: "ws://127.0.0.1:43210/ws?token=SUPERSECRETTOKEN",
      token: "SUPERSECRETTOKEN",
    },
    connection: "open",
    paths: { dataDir: "/d", logDir: "/d/logs" },
    providers: [
      { id: "claude", kind: "claude" as const, label: "Claude", available: true },
      { id: "codex", kind: "codex" as const, label: "Codex", available: false, unavailableReason: "未安装" },
    ],
    codingAgents: null,
    sessions: { a: { status: "running" as const }, b: { status: "idle" as const }, c: { status: "idle" as const } },
    platform: "Win32",
    userAgent: "UA",
  };

  it("不包含 token，只保留端口", () => {
    const text = JSON.stringify(buildDiagnostics(input as never));
    expect(text).not.toContain("SUPERSECRETTOKEN");
    expect(text).not.toContain("wsUrl");
    expect(text).toContain("43210");
  });

  it("统计会话数量与 provider 可用状态", () => {
    const result = buildDiagnostics(input as never) as unknown as {
      sessions: { total: number; byStatus: Record<string, number> };
      providers: Array<{ id: string; available: boolean; unavailableReason?: string }>;
    };
    expect(result.sessions).toEqual({ total: 3, byStatus: { running: 1, idle: 2 } });
    expect(result.providers[1]).toMatchObject({ id: "codex", available: false, unavailableReason: "未安装" });
  });
});

describe("helpers", () => {
  it("sidecarPort 解析端口，非法地址返回 null", () => {
    expect(sidecarPort("ws://127.0.0.1:8123/ws")).toBe("8123");
    expect(sidecarPort("")).toBeNull();
    expect(sidecarPort("not a url")).toBeNull();
  });

  it("countSessionsByStatus 空表", () => {
    expect(countSessionsByStatus({})).toEqual({ total: 0, byStatus: {} });
  });

  it("eventsToJsonl 每行一个 JSON 且再次脱敏", () => {
    const text = eventsToJsonl([
      { id: 1, ts: 0, type: "console", level: "warn", summary: "a", payload: { api_key: "sk-xxx" } },
      { id: 2, ts: 1, type: "sidecar", level: "info", summary: "b" },
    ]);
    const lines = text.split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).payload.api_key).toBe("***");
    expect(JSON.parse(lines[1]!).time).toBe("1970-01-01T00:00:00.001Z");
  });
});
