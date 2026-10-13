import { describe, expect, it } from "vitest";
import type { AgentUIMessage } from "@agentdeck/protocol";
import type { AgentSelection } from "@/lib/agent-selection";
import {
  GROUP_MEMBERS_MAX,
  NOT_GIT_REPO_MESSAGE,
  buildGroupCreateParams,
  lastAssistantMessageText,
  validateGroupForm,
  type GroupFormState,
} from "./group-display";

const sel = (provider: string | null, extra: Partial<AgentSelection> = {}): AgentSelection => ({
  provider,
  model: null,
  modeId: null,
  thinkingOptionId: null,
  ...extra,
});

function form(patch: Partial<GroupFormState> = {}): GroupFormState {
  return {
    prompt: "实现排序",
    cwd: "C:/work/repo",
    members: [sel("claude"), sel("codex")],
    perMemberWorktree: false,
    chairMode: "none",
    chair: sel(null),
    ...patch,
  };
}

describe("validateGroupForm", () => {
  it("合法表单没有错误", () => {
    expect(validateGroupForm(form(), { isGitRepo: false })).toEqual({});
  });

  it("成员数需为 2–6 个", () => {
    expect(validateGroupForm(form({ members: [sel("claude")] }), { isGitRepo: true }).members).toMatch(/2–6/);
    const seven = Array.from({ length: GROUP_MEMBERS_MAX + 1 }, () => sel("claude"));
    expect(validateGroupForm(form({ members: seven }), { isGitRepo: true }).members).toMatch(/2–6/);
    const six = Array.from({ length: GROUP_MEMBERS_MAX }, () => sel("claude"));
    expect(validateGroupForm(form({ members: six }), { isGitRepo: true }).members).toBeUndefined();
  });

  it("成员必须选了 Agent，prompt 与工作目录不能为空", () => {
    const errors = validateGroupForm(form({ members: [sel("claude"), sel(null)], prompt: "  ", cwd: "" }), {
      isGitRepo: true,
    });
    expect(errors.members).toMatch(/Agent/);
    expect(errors.prompt).toBeTruthy();
    expect(errors.cwd).toBeTruthy();
  });

  it("worktree 仅在 git 仓库内可用", () => {
    expect(validateGroupForm(form({ perMemberWorktree: true }), { isGitRepo: false }).worktree).toBe(
      NOT_GIT_REPO_MESSAGE,
    );
    expect(validateGroupForm(form({ perMemberWorktree: true }), { isGitRepo: true }).worktree).toBeUndefined();
  });

  it("开启汇总必须选汇总 Agent", () => {
    expect(validateGroupForm(form({ chairMode: "review" }), { isGitRepo: true }).chair).toBeTruthy();
    expect(
      validateGroupForm(form({ chairMode: "review", chair: sel("claude") }), { isGitRepo: true }).chair,
    ).toBeUndefined();
  });
});

describe("buildGroupCreateParams", () => {
  it("只带有值的可选字段；worktree 与汇总映射为协议取值", () => {
    const params = buildGroupCreateParams(
      form({
        prompt: " 任务 ",
        members: [sel("claude", { model: "opus", modeId: "plan" }), sel("codex")],
        perMemberWorktree: true,
        chairMode: "synthesize",
        chair: sel("claude", { model: "sonnet" }),
      }),
    );
    expect(params).toEqual({
      prompt: "任务",
      cwd: "C:/work/repo",
      members: [{ provider: "claude", model: "opus", modeId: "plan" }, { provider: "codex" }],
      worktree: "per-member",
      chair: { provider: "claude", model: "sonnet", mode: "synthesize" },
    });
    expect(buildGroupCreateParams(form())).not.toHaveProperty("chair");
    expect(buildGroupCreateParams(form()).worktree).toBe("none");
  });
});

describe("lastAssistantMessageText", () => {
  const message = (role: AgentUIMessage["role"], text: string): AgentUIMessage => ({
    id: text,
    sessionId: "s",
    role,
    createdAt: 1,
    status: "complete",
    parts: [{ type: "text", text }],
  });

  it("取最后一条非空助手消息", () => {
    expect(lastAssistantMessageText([message("assistant", "第一条"), message("user", "追问"), message("assistant", "第二条")])).toBe("第二条");
    expect(lastAssistantMessageText([message("user", "只有用户")])).toBe("");
    expect(lastAssistantMessageText([])).toBe("");
  });
});
