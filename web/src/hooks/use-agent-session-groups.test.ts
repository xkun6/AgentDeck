import { describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import type { AgentGroup } from "@agentdeck/protocol";
import type { SidecarClient } from "@/lib/sidecar-client";
import { groupsStateAtom } from "@/stores/groups";
import { bindGroupsToStore, createAgentSessionActions } from "./use-agent-session";

const group: AgentGroup = {
  id: "g1",
  title: "排序对比",
  prompt: "p",
  cwd: "/work",
  createdAt: 1,
  members: [{ agentId: "a", provider: "claude" }],
  status: "running",
};

describe("并行协作组（design.md 4.27）", () => {
  it("group.changed / group.removed 增量更新 store；每次拉到 agent.list 后重新拉 group.list", async () => {
    const store = createStore();
    let onChanged: (value: AgentGroup) => void = () => {};
    let onRemoved: (id: string) => void = () => {};
    let onAgents: () => void = () => {};
    const request = vi.fn(async () => ({ groups: [group] }));
    const client = {
      request,
      onGroupChanged: (listener: typeof onChanged) => { onChanged = listener; return () => {}; },
      onGroupRemoved: (listener: typeof onRemoved) => { onRemoved = listener; return () => {}; },
      onAgents: (listener: () => void) => { onAgents = listener; return () => {}; },
    } as unknown as SidecarClient;
    const unbind = bindGroupsToStore(client, store);

    onAgents();
    await vi.waitFor(() => expect(store.get(groupsStateAtom).loaded).toBe(true));
    expect(request).toHaveBeenCalledWith("group.list");
    expect(Object.keys(store.get(groupsStateAtom).groups)).toEqual(["g1"]);

    onChanged({ ...group, status: "done" });
    expect(store.get(groupsStateAtom).groups.g1?.status).toBe("done");
    onRemoved("g1");
    expect(store.get(groupsStateAtom).groups).toEqual({});
    unbind();
  });

  it("动作：createGroup 写入 store，deleteGroup 返回 warnings 并移除", async () => {
    const store = createStore();
    const request = vi.fn(async (method: string) => {
      if (method === "group.create") return { group };
      return { warnings: ["清理失败"] };
    });
    const actions = createAgentSessionActions({ request } as unknown as SidecarClient, store);
    const params = {
      prompt: "p",
      cwd: "/work",
      members: [{ provider: "claude" }, { provider: "codex" }],
      worktree: "none" as const,
    };
    expect(await actions.createGroup(params)).toEqual(group);
    expect(request).toHaveBeenCalledWith("group.create", params, expect.anything());
    expect(store.get(groupsStateAtom).groups.g1).toEqual(group);

    expect(await actions.deleteGroup("g1", true)).toEqual(["清理失败"]);
    expect(request).toHaveBeenCalledWith("group.delete", { id: "g1", removeWorktrees: true }, expect.anything());
    expect(store.get(groupsStateAtom).groups).toEqual({});
  });
});
