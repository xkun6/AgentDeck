// 手机端纯函数：路由解析、会话过滤、工作目录去重、attention 判定、设备名探测
import { describe, expect, it } from "vitest";
import type { AttentionNotice } from "@agentdeck/protocol";
import { attentionTarget, decideAttention } from "./attention";
import { cwdBaseName, cwdKey, recentCwdOptions } from "./cwd-options";
import { detectDeviceName } from "./platform";
import { navTabOf, parseRoute, routeHash, type MobileRoute } from "./route";
import { archivedCount, visibleSessions } from "./session-filter";
import { agent } from "./test-fixtures";

describe("route", () => {
  it("hash 与路由互相转换，未知 hash 回落到会话列表", () => {
    expect(parseRoute("")).toEqual({ name: "sessions" });
    expect(parseRoute("#/nope")).toEqual({ name: "sessions" });
    expect(parseRoute("#/settings/nope")).toEqual({ name: "sessions" });
    for (const page of ["background", "diagnostics"] as const) {
      const route: MobileRoute = { name: "settings", page };
      expect(parseRoute(routeHash(route))).toEqual(route);
      // 设置子页不显示底部导航
      expect(navTabOf(route)).toBeNull();
    }
    expect(navTabOf({ name: "settings" })).toBe("settings");
    for (const name of ["hosts", "pair", "new", "settings"] as const) {
      expect(parseRoute(routeHash({ name }))).toEqual({ name });
    }
    const route = { name: "session", agentId: "a/b c#1" } as const;
    expect(parseRoute(routeHash(route))).toEqual(route);
  });

  it("坏的百分号编码不抛错", () => {
    expect(parseRoute("#/s/%E0%A4%A")).toEqual({ name: "sessions" });
    expect(parseRoute("#/s/a1/sub/%E0%A4%A")).toEqual({ name: "sessions" });
    expect(parseRoute("#/s/%E0%A4%A/sub/s1")).toEqual({ name: "sessions" });
  });

  it("子代理路由：带 subagentId 的往返，特殊字符与不带 subagentId 的会话路由互不干扰", () => {
    const route = { name: "session", agentId: "a/b c#1", subagentId: "toolu_01/x y" } as const;
    expect(routeHash(route)).toBe("#/s/a%2Fb%20c%231/sub/toolu_01%2Fx%20y");
    expect(parseRoute(routeHash(route))).toEqual(route);
    expect(parseRoute("#/s/a1/sub/s1")).toEqual({ name: "session", agentId: "a1", subagentId: "s1" });
    expect(parseRoute("#/s/a1")).toEqual({ name: "session", agentId: "a1" });
    expect(routeHash({ name: "session", agentId: "a1" })).toBe("#/s/a1");
    expect(navTabOf(route)).toBeNull();
  });

  it("底部导航只在三个主页面显示", () => {
    expect(navTabOf({ name: "sessions" })).toBe("sessions");
    expect(navTabOf({ name: "session", agentId: "x" })).toBeNull();
    expect(navTabOf({ name: "pair" })).toBeNull();
  });
});

describe("派单路由", () => {
  it("总览与详情可往返；总览有底部导航，详情没有；坏编码退回总览", () => {
    expect(parseRoute(routeHash({ name: "dispatch" }))).toEqual({ name: "dispatch" });
    const detail: MobileRoute = { name: "dispatch", agentId: "a/b c" };
    expect(routeHash(detail)).toBe("#/dispatch/a%2Fb%20c");
    expect(parseRoute(routeHash(detail))).toEqual(detail);
    expect(parseRoute("#/dispatch/%E0%A4%A")).toEqual({ name: "dispatch" });
    expect(navTabOf({ name: "dispatch" })).toBe("dispatch");
    expect(navTabOf(detail)).toBeNull();
  });
});

describe("visibleSessions：子会话（4.26）", () => {
  const list = [
    agent("master"),
    agent("child", { parentAgentId: "master" }),
    agent("legacy", { reportToAgentId: "master" }),
    agent("byOrigin", { origin: "delegate" }),
    agent("oldChild", { parentAgentId: "master", archived: true }),
    agent("gone", { archived: true }),
    agent("left", { parentAgentId: "gone" }),
  ];

  it("默认不显示任何子会话", () => {
    expect(visibleSessions(list, false).map((x) => x.id)).toEqual(["master"]);
  });

  it("显示归档时只多出已归档的子会话和已归档主会话名下的子会话，计数一致", () => {
    expect(visibleSessions(list, true).map((x) => x.id)).toEqual(["master", "oldChild", "gone", "left"]);
    expect(archivedCount(list)).toBe(3);
  });

  it("已归档主会话名下多层的子会话都能从「显示已归档」进入；中间层归档但主会话正常的不进（在派单页）", () => {
    const deep = [
      agent("m", { archived: true }),
      agent("a", { parentAgentId: "m" }),
      agent("b", { parentAgentId: "a" }),
      agent("live"),
      agent("mid", { parentAgentId: "live", archived: true }),
      agent("leaf", { parentAgentId: "mid" }),
    ];
    expect(visibleSessions(deep, true).map((x) => x.id)).toEqual(["m", "a", "b", "live", "mid"]);
    expect(archivedCount(deep)).toBe(4);
  });

  it("目录候选不含子会话的目录", () => {
    const options = recentCwdOptions([
      agent("m", { cwd: "J:/repo" }),
      agent("w", { cwd: "J:/data/worktrees/delegate-1234abcd", parentAgentId: "m" }),
    ]);
    expect(options.map((option) => option.cwd)).toEqual(["J:/repo"]);
  });
});

describe("visibleSessions", () => {
  const list = [
    agent("a", { updatedAt: 5 }),
    agent("b", { updatedAt: 4, pinned: true }),
    agent("c", { updatedAt: 3, archived: true }),
    agent("j", { updatedAt: 2, origin: "judge" }),
    agent("d", { updatedAt: 1, pinned: true, archived: true }),
  ];

  it("默认隐藏归档与评判会话，置顶在前", () => {
    expect(visibleSessions(list, false).map((x) => x.id)).toEqual(["b", "a"]);
  });

  it("显示归档时仍隐藏评判会话，置顶（含已归档置顶）在前", () => {
    expect(visibleSessions(list, true).map((x) => x.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("归档计数不含评判会话", () => {
    expect(archivedCount([...list, agent("j2", { archived: true, origin: "judge" })])).toBe(2);
  });
});

describe("recentCwdOptions", () => {
  it("按目录去重（Windows 路径忽略大小写与斜杠方向），最近使用的在前，隐藏会话不参与", () => {
    const options = recentCwdOptions([
      agent("1", { cwd: "J:\\Program\\A", updatedAt: 10 }),
      agent("2", { cwd: "j:/program/a/", updatedAt: 30 }),
      agent("3", { cwd: "/home/me/b", updatedAt: 20 }),
      agent("4", { cwd: "/home/me/judge", updatedAt: 99, origin: "judge" }),
      agent("5", { cwd: "  ", updatedAt: 98 }),
    ]);
    expect(options.map((o) => [o.cwd, o.sessionCount])).toEqual([
      ["j:/program/a/", 2],
      ["/home/me/b", 1],
    ]);
  });

  it("Linux 路径区分大小写；cwdBaseName 取最后一段", () => {
    expect(cwdKey("/Home/X")).not.toBe(cwdKey("/home/x"));
    expect(cwdBaseName("J:\\Program\\AgentDeck\\")).toBe("AgentDeck");
  });
});

describe("decideAttention", () => {
  const notice: AttentionNotice = {
    id: "n1",
    kind: "finished",
    agentId: "a1",
    title: "重构",
    body: "本轮已完成",
    timestamp: 1,
  };

  it("前台且正停在该会话：忽略", () => {
    expect(decideAttention(notice, { name: "session", agentId: "a1" }, true)).toBe("ignore");
  });

  it("前台在其它页面（含其它会话）：应用内提示条", () => {
    expect(decideAttention(notice, { name: "sessions" }, true)).toBe("banner");
    expect(decideAttention(notice, { name: "session", agentId: "a2" }, true)).toBe("banner");
  });

  it("后台：交给后台处理器（M3）", () => {
    expect(decideAttention(notice, { name: "sessions" }, false)).toBe("background");
    expect(decideAttention(notice, { name: "session", agentId: "a1" }, false)).toBe("background");
  });

  it("没有 agentId 的调度类通知总是弹条；点击去会话列表", () => {
    const schedule: AttentionNotice = { ...notice, kind: "schedule", agentId: undefined };
    expect(decideAttention(schedule, { name: "session", agentId: "a1" }, true)).toBe("banner");
    expect(attentionTarget(schedule)).toEqual({ name: "sessions" });
    expect(attentionTarget(notice)).toEqual({ name: "session", agentId: "a1" });
  });
});

describe("detectDeviceName", () => {
  it("从 UA 取型号", () => {
    expect(
      detectDeviceName("Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UD1A) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36"),
    ).toBe("Pixel 8");
    expect(detectDeviceName("Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36")).toBe("SM-S918B");
  });

  it("精简 UA 的 K / 非安卓 → 默认名", () => {
    expect(detectDeviceName("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36")).toBe("安卓手机");
    expect(detectDeviceName("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("安卓手机");
  });
});
