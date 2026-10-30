import { describe, expect, it } from "vitest";
import type { AgentSnapshot } from "@agentdeck/protocol";
import {
  buildDispatchGroups,
  dispatchBadgeOf,
  dispatchMasterOf,
  dispatchStatus,
  dispatchSummaryText,
  findDispatchGroup,
  findDispatchGroupThrough,
  isUnderArchivedMaster,
  type DispatchNode,
} from "./dispatch";

function agent(id: string, patch: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id,
    provider: "claude",
    cwd: "C:/work/demo",
    status: "idle",
    pendingPermissions: [],
    lastSeq: 1,
    resumable: false,
    createdAt: 1000,
    updatedAt: 2000,
    ...patch,
  };
}

const pending = [{ id: "p" }] as AgentSnapshot["pendingPermissions"];
const idle = { running: false, descendantsWorking: false };

function ids(nodes: readonly DispatchNode[]): unknown[] {
  return nodes.map((node) => (node.children.length > 0 ? [node.agent.id, ids(node.children)] : node.agent.id));
}

describe("dispatchStatus", () => {
  it("按设计的优先级判定", () => {
    const failed = agent("a", { lastTurnOutcome: "failed" });
    expect(dispatchStatus(agent("a", { pendingPermissions: pending }), { running: true, descendantsWorking: true })).toBe("approval");
    expect(dispatchStatus(failed, { running: true, descendantsWorking: true })).toBe("running");
    expect(dispatchStatus(agent("a", { backgroundActive: true }), idle)).toBe("running");
    expect(dispatchStatus(failed, { running: false, descendantsWorking: true })).toBe("waiting");
    expect(dispatchStatus(failed, idle)).toBe("failed");
    expect(dispatchStatus(agent("a", { status: "error" }), idle)).toBe("failed");
    expect(dispatchStatus(agent("a", { lastTurnOutcome: "canceled" }), idle)).toBe("canceled");
    expect(dispatchStatus(agent("a", { lastTurnOutcome: "completed" }), idle)).toBe("done");
    expect(dispatchStatus(agent("a", { lastSeq: 0 }), idle)).toBe("notStarted");
    expect(dispatchStatus(agent("a"), idle)).toBe("ended");
  });

  it("回合标记仍为运行中但进程已不在运行：算已中断，已回收的已完成会话仍是已完成", () => {
    expect(dispatchStatus(agent("a", { status: "dormant", lastTurnOutcome: "running" }), idle)).toBe("canceled");
    expect(dispatchStatus(agent("a", { status: "dormant", lastTurnOutcome: "completed" }), idle)).toBe("done");
  });
});

describe("dispatchBadgeOf / findDispatchGroup", () => {
  const notRunning = () => false;

  it("角标合并工作中与需要处理，待审批只计一次；都已完成时为 null", () => {
    const groups = buildDispatchGroups(
      [
        agent("m"),
        agent("run", { parentAgentId: "m", status: "running" }),
        agent("ask", { parentAgentId: "m", pendingPermissions: pending }),
        agent("bad", { parentAgentId: "m", lastTurnOutcome: "failed" }),
      ],
      (entry) => entry.status === "running",
    );
    expect(dispatchBadgeOf(groups)).toEqual({ count: 3, working: 2, attention: 2 });
    const calm = buildDispatchGroups([agent("m"), agent("ok", { parentAgentId: "m", lastTurnOutcome: "completed" })], notRunning);
    expect(dispatchBadgeOf(calm)).toBeNull();
  });

  it("任一层子会话都能找到所属主会话；孤儿组 master 为 null；无关会话找不到", () => {
    const groups = buildDispatchGroups(
      [
        agent("m"),
        agent("plain"),
        agent("c", { parentAgentId: "m" }),
        agent("leaf", { parentAgentId: "c" }),
        agent("orphan", { parentAgentId: "gone" }),
      ],
      notRunning,
    );
    expect(findDispatchGroup(groups, "m")?.master?.agent.id).toBe("m");
    expect(findDispatchGroup(groups, "leaf")?.master?.agent.id).toBe("m");
    expect(findDispatchGroup(groups, "orphan")?.master).toBeNull();
    expect(findDispatchGroup(groups, "plain")).toBeUndefined();
  });
});

describe("归属链", () => {
  const byIdOf = (agents: AgentSnapshot[]) => new Map(agents.map((entry) => [entry.id, entry]));

  it("dispatchMasterOf 跳过中间层找到真正的主会话；链断了或成环时没有", () => {
    const agents = [
      agent("m"),
      agent("a", { parentAgentId: "m" }),
      agent("b", { parentAgentId: "a" }),
      agent("o", { parentAgentId: "gone" }),
      agent("x", { parentAgentId: "y" }),
      agent("y", { parentAgentId: "x" }),
    ];
    const byId = byIdOf(agents);
    expect(dispatchMasterOf(byId.get("b")!, byId)?.id).toBe("m");
    expect(dispatchMasterOf(byId.get("a")!, byId)?.id).toBe("m");
    expect(dispatchMasterOf(byId.get("o")!, byId)).toBeUndefined();
    expect(dispatchMasterOf(byId.get("x")!, byId)).toBeUndefined();
    expect(dispatchMasterOf(byId.get("m")!, byId)).toBeUndefined();
  });

  it("isUnderArchivedMaster 看链的顶端：多层也算；中间层归档、主会话正常不算；成环不死循环", () => {
    const agents = [
      agent("m", { archived: true }),
      agent("a", { parentAgentId: "m" }),
      agent("b", { parentAgentId: "a" }),
      agent("live"),
      agent("mid", { parentAgentId: "live", archived: true }),
      agent("leaf", { parentAgentId: "mid" }),
      agent("x", { parentAgentId: "y" }),
      agent("y", { parentAgentId: "x" }),
    ];
    const byId = byIdOf(agents);
    const under = (id: string) => isUnderArchivedMaster(byId.get(id)!, byId);
    expect(under("a")).toBe(true);
    expect(under("b")).toBe(true);
    expect(under("leaf")).toBe(false);
    expect(under("x")).toBe(false);
  });

  it("findDispatchGroupThrough：已归档的子会话沿上级找到主会话；查不到时为 undefined", () => {
    const agents = [
      agent("m"),
      agent("c", { parentAgentId: "m" }),
      agent("old", { parentAgentId: "m", archived: true }),
      agent("older", { parentAgentId: "old", archived: true }),
      agent("plain"),
    ];
    const groups = buildDispatchGroups(agents, () => false);
    const snapshots = Object.fromEntries(agents.map((entry) => [entry.id, entry]));
    expect(findDispatchGroupThrough(groups, snapshots, "older")?.master?.agent.id).toBe("m");
    expect(findDispatchGroupThrough(groups, snapshots, "plain")).toBeUndefined();
    expect(findDispatchGroupThrough(groups, snapshots, "missing")).toBeUndefined();
  });
});

describe("buildDispatchGroups", () => {
  const notRunning = () => false;

  it("主会话 = 有子会话且自身不是子会话；嵌套子会话归到同一主会话，汇总包含全部后代", () => {
    const groups = buildDispatchGroups(
      [
        agent("plain"),
        agent("master"),
        agent("c1", { parentAgentId: "master", lastTurnOutcome: "completed" }),
        agent("c2", { reportToAgentId: "master", lastTurnOutcome: "failed" }),
        agent("nested", { parentAgentId: "c1", lastTurnOutcome: "completed" }),
      ],
      notRunning,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].master?.agent.id).toBe("master");
    expect(ids(groups[0].children)).toEqual([["c1", ["nested"]], "c2"]);
    expect(groups[0].summary).toMatchObject({ total: 3, done: 2, working: 0, attention: 1 });
    expect(dispatchSummaryText(groups[0].summary)).toBe("1 失败 · 2 已完成");
  });

  it("后代在工作时子会话显示等待子任务，后代待审批算需要处理", () => {
    const [group] = buildDispatchGroups(
      [
        agent("master"),
        agent("c1", { parentAgentId: "master", lastTurnOutcome: "completed" }),
        agent("nested", { parentAgentId: "c1", pendingPermissions: pending }),
      ],
      notRunning,
    );
    expect(group.children[0].status).toBe("waiting");
    expect(group.summary).toMatchObject({ working: 2, attention: 1 });
    expect(dispatchSummaryText(group.summary)).toBe("1 待审批 · 1 等待子任务");
    expect(group.master?.status).toBe("waiting");
  });

  it("isRunning 判定运行中", () => {
    const [group] = buildDispatchGroups(
      [agent("master"), agent("c1", { parentAgentId: "master" })],
      (entry) => entry.id === "c1",
    );
    expect(group.children[0].status).toBe("running");
  });

  it("已归档的子会话不显示；只有已归档子会话的不算主会话", () => {
    const groups = buildDispatchGroups(
      [agent("master"), agent("c1", { parentAgentId: "master", archived: true })],
      notRunning,
    );
    expect(groups).toEqual([]);
  });

  it("includeArchived：已归档主会话的分组总是列出，子会话不工作也在", () => {
    const groups = buildDispatchGroups(
      [agent("master", { archived: true }), agent("c1", { parentAgentId: "master" })],
      notRunning,
      { includeArchived: true },
    );
    expect(groups.map((group) => group.master?.agent.id)).toEqual(["master"]);
    expect(ids(groups[0].children)).toEqual(["c1"]);
  });

  it("已归档的主会话只有还有工作中的子会话时才列出", () => {
    const archived = agent("master", { archived: true });
    expect(buildDispatchGroups([archived, agent("c1", { parentAgentId: "master" })], notRunning)).toEqual([]);
    const groups = buildDispatchGroups([archived, agent("c1", { parentAgentId: "master", status: "running" })], (entry) => entry.status === "running");
    expect(groups.map((group) => group.master?.agent.id)).toEqual(["master"]);
  });

  it("主会话找不到时归入最后的 master 为 null 一组，保留内部层级", () => {
    const groups = buildDispatchGroups(
      [
        agent("orphanChild", { parentAgentId: "orphan" }),
        agent("orphan", { parentAgentId: "gone" }),
        agent("legacy", { origin: "delegate" }),
        agent("master"),
        agent("c1", { parentAgentId: "master" }),
      ],
      notRunning,
    );
    expect(groups.map((group) => group.master?.agent.id ?? null)).toEqual(["master", null]);
    expect(ids(groups[1].children)).toEqual([["orphan", ["orphanChild"]], "legacy"]);
  });

  it("中间层子会话已归档时，它的子会话接到再上一级，仍算主会话的进度", () => {
    const groups = buildDispatchGroups(
      [
        agent("master"),
        agent("c1", { parentAgentId: "master" }),
        agent("mid", { parentAgentId: "master", archived: true }),
        agent("leaf", { parentAgentId: "mid" }),
      ],
      notRunning,
    );
    expect(groups).toHaveLength(1);
    expect(ids(groups[0].children)).toEqual(["c1", "leaf"]);
    expect(groups[0].summary.total).toBe(2);
  });

  it("链上连续多层归档也能接上；上面已无人时才算主会话已删除", () => {
    const groups = buildDispatchGroups(
      [
        agent("master"),
        agent("a", { parentAgentId: "master", archived: true }),
        agent("b", { parentAgentId: "a", archived: true }),
        agent("leaf", { parentAgentId: "b" }),
        agent("x", { parentAgentId: "gone", archived: true }),
        agent("y", { parentAgentId: "x" }),
      ],
      notRunning,
    );
    expect(groups.map((group) => group.master?.agent.id ?? null)).toEqual(["master", null]);
    expect(ids(groups[0].children)).toEqual(["leaf"]);
    expect(ids(groups[1].children)).toEqual(["y"]);
  });

  it("归属成环时断开，每个会话只出现一次", () => {
    const groups = buildDispatchGroups(
      [agent("a", { parentAgentId: "b" }), agent("b", { parentAgentId: "a" })],
      notRunning,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].master).toBeNull();
    expect(groups[0].summary.total).toBe(2);
    expect(ids(groups[0].children)).toEqual([["a", ["b"]]]);
  });

  it("隐藏的评判会话不参与", () => {
    expect(buildDispatchGroups([agent("master"), agent("j", { origin: "judge", parentAgentId: "master" })], notRunning)).toEqual([]);
  });
});
