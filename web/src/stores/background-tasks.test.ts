import { describe, expect, it } from "vitest";
import { createStore } from "jotai";
import type { AgentBackgroundTask } from "@agentdeck/protocol";
import {
  backgroundTasksByAgentAtom,
  removeAgentBackgroundTasksAtom,
  replaceBackgroundTasksAtom,
} from "./background-tasks";

function task(taskId: string, status: AgentBackgroundTask["status"] = "running"): AgentBackgroundTask {
  return { taskId, kind: "command", description: "pnpm build", status, startedAt: 1 };
}

describe("background-tasks store", () => {
  it("update 通知整表替换，且各会话互不影响", () => {
    const store = createStore();
    store.set(replaceBackgroundTasksAtom, { agentId: "a1", tasks: [task("t1"), task("t2")] });
    store.set(replaceBackgroundTasksAtom, { agentId: "a2", tasks: [task("t9")] });
    store.set(replaceBackgroundTasksAtom, { agentId: "a1", tasks: [task("t1", "completed")] });
    expect(store.get(backgroundTasksByAgentAtom)).toEqual({
      a1: [task("t1", "completed")],
      a2: [task("t9")],
    });
  });

  it("会话删除时移除其任务；不存在的会话保持原状态引用", () => {
    const store = createStore();
    store.set(replaceBackgroundTasksAtom, { agentId: "a1", tasks: [task("t1")] });
    const before = store.get(backgroundTasksByAgentAtom);
    store.set(removeAgentBackgroundTasksAtom, "missing");
    expect(store.get(backgroundTasksByAgentAtom)).toBe(before);
    store.set(removeAgentBackgroundTasksAtom, "a1");
    expect(store.get(backgroundTasksByAgentAtom)).toEqual({});
  });
});
