import { describe, expect, it } from "vitest";
import type { ProviderSubagentDescriptor } from "@agentdeck/protocol";
import {
  parseSubAgentLog,
  selectSubagentsAtLevel,
  subagentPillLabel,
  subagentRowLabel,
} from "./subagent-presentation";

function sub(
  id: string,
  status: ProviderSubagentDescriptor["status"],
  extra: Partial<ProviderSubagentDescriptor> = {},
): ProviderSubagentDescriptor {
  return {
    id,
    parentAgentId: "a1",
    parentSubagentId: null,
    provider: "claude",
    title: "Explore",
    description: null,
    status,
    createdAt: 1,
    updatedAt: 1,
    toolCallId: id,
    cwd: null,
    subtitle: null,
    ...extra,
  };
}

describe("parseSubAgentLog", () => {
  it("`[Tool] summary` 行解析为动作，其余行保留为文本", () => {
    const parsed = parseSubAgentLog("\n[Read] src/a.ts\n[Grep]\n普通说明\n  [Bash]   ls -la  \n\n");
    expect(parsed.actions).toEqual([
      { index: 1, toolName: "Read", summary: "src/a.ts" },
      { index: 2, toolName: "Grep" },
      { index: 3, toolName: "Bash", summary: "ls -la" },
    ]);
    expect(parsed.remainingLog).toBe("普通说明");
  });

  it("空 log 没有动作也没有文本；空方括号不算动作", () => {
    expect(parseSubAgentLog("")).toEqual({ actions: [], remainingLog: "" });
    expect(parseSubAgentLog("[ ] x").actions).toEqual([]);
  });
});

describe("子代理药丸", () => {
  it("按状态计数，只列非零项", () => {
    expect(subagentPillLabel([sub("1", "running"), sub("2", "running"), sub("3", "failed")])).toBe(
      "2 运行中，1 失败",
    );
    expect(subagentPillLabel([sub("1", "running"), sub("2", "completed")])).toBe("1 运行中");
    expect(subagentPillLabel([sub("1", "failed"), sub("2", "completed")])).toBe("1 失败");
  });

  it("全部结束（完成 / 取消）时显示总数", () => {
    expect(subagentPillLabel([sub("1", "completed"), sub("2", "canceled"), sub("3", "completed")])).toBe(
      "3 个子代理",
    );
  });

  it("只取当前层级并按创建时间排序", () => {
    const all = [
      sub("b", "running", { createdAt: 5 }),
      sub("a", "completed", { createdAt: 2 }),
      sub("child", "running", { parentSubagentId: "a", createdAt: 3 }),
    ];
    expect(selectSubagentsAtLevel(all, null).map((row) => row.id)).toEqual(["a", "b"]);
    expect(selectSubagentsAtLevel(all, "a").map((row) => row.id)).toEqual(["child"]);
    expect(subagentPillLabel(selectSubagentsAtLevel(all, null))).toBe("1 运行中");
  });

  it("行标签优先 description，其次 title，再次「子代理」", () => {
    expect(subagentRowLabel({ title: "Explore", description: "读 package.json" })).toBe("读 package.json");
    expect(subagentRowLabel({ title: "Explore", description: null })).toBe("Explore");
    expect(subagentRowLabel({ title: null, description: "  " })).toBe("子代理");
  });
});
