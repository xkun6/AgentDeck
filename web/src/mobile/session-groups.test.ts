import { describe, expect, it } from "vitest";
import { groupSessionsByProject, limitProjectRows } from "./session-groups";

const session = (id: string, cwd: string, pinned = false) => ({ id, cwd, pinned });

describe("groupSessionsByProject", () => {
  it("按目录分组，路径写法不同算同一项目，保持传入顺序；置顶单列", () => {
    const { pinned, projects } = groupSessionsByProject([
      session("a", "J:\\Program\\Demo"),
      session("b", "J:/Other/"),
      session("c", "j:/program/demo/"),
      session("p", "J:/Program/Demo", true),
    ]);
    expect(pinned.map((item) => item.id)).toEqual(["p"]);
    expect(projects.map((item) => [item.name, item.agents.map((agent) => agent.id)])).toEqual([
      ["Demo", ["a", "c"]],
      ["Other", ["b"]],
    ]);
  });

  it("同名目录带上父目录", () => {
    const { projects } = groupSessionsByProject([session("a", "J:/one/app"), session("b", "J:/two/app")]);
    expect(projects.map((item) => item.name)).toEqual(["one/app", "two/app"]);
  });

  it("AgentDeck 自建的 worktree 合成一组，没有目录的归入未知目录", () => {
    const { projects } = groupSessionsByProject([
      session("a", "C:/data/worktrees/delegate-0123abcd"),
      session("b", "C:/data/worktrees/deadbeef/2"),
      session("c", "  "),
    ]);
    expect(projects.map((item) => [item.name, item.path, item.agents.length])).toEqual([
      ["工作树", undefined, 2],
      ["未知目录", undefined, 1],
    ]);
  });
});

describe("limitProjectRows", () => {
  it("超出部分隐藏，进行中的始终显示", () => {
    const { shown, hidden } = limitProjectRows([1, 2, 3, 4], (value) => value === 4, 2);
    expect(shown).toEqual([1, 2, 4]);
    expect(hidden).toBe(1);
  });
});
