// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentPermissionRequest } from "@agentdeck/protocol";
import { getDefaultStore } from "jotai";
import { SidecarRpcError } from "@/lib/sidecar-client";
import { chatRuntimeBySessionAtom, createEmptyChatRuntime, type PendingApproval } from "@/stores/chat";
import { ApprovalDialog } from "./approval-dialog";
import { HANDLED_ELSEWHERE_REMOVE_DELAY_MS } from "./use-approval-failure";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  getDefaultStore().set(chatRuntimeBySessionAtom, {});
});

function rpcError(code: string, message = "找不到待处理的权限请求：p1"): SidecarRpcError {
  return new SidecarRpcError({ code: -32000, message, data: { code } });
}

function approval(permission?: AgentPermissionRequest, command = "echo hi"): PendingApproval {
  return { requestId: permission?.id ?? "p1", sessionId: "agent-1", command, permission };
}

describe("ApprovalDialog", () => {
  it("按 request.actions 渲染按钮并回传 behavior + selectedActionId", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const request: AgentPermissionRequest = {
      id: "p1",
      provider: "acp:dsh",
      name: "execute",
      kind: "tool",
      title: "执行命令",
      description: "Agent 想要运行一条命令",
      detail: { type: "shell", command: "npm test", cwd: "/repo" },
      actions: [
        { id: "allow_once", label: "允许一次", behavior: "allow" },
        { id: "allow_always", label: "总是允许", behavior: "allow" },
        { id: "reject_once", label: "拒绝", behavior: "deny" },
      ],
    };
    render(<ApprovalDialog approval={approval(request)} onRespond={onRespond} />);

    expect(screen.getByText("执行命令")).toBeTruthy();
    expect(screen.getByText("Agent 想要运行一条命令")).toBeTruthy();
    expect(screen.getByText("npm test")).toBeTruthy();
    expect(screen.getByText("工作目录：/repo")).toBeTruthy();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "允许一次",
      "总是允许",
      "拒绝",
      "理由",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "总是允许" }));
    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(1));
    expect(onRespond.mock.calls[0]![1]).toEqual({ behavior: "allow", selectedActionId: "allow_always" });

    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(2));
    expect(onRespond.mock.calls[1]![1]).toEqual({ behavior: "deny", selectedActionId: "reject_once" });
  });

  it("没有 actions 时显示默认的 允许 / 拒绝", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalDialog approval={approval(undefined, "rm -rf dist")} onRespond={onRespond} />);

    expect(screen.getByText("需要确认执行")).toBeTruthy();
    expect(screen.getByText("rm -rf dist")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "允许" }));
    await waitFor(() => expect(onRespond).toHaveBeenCalledWith(expect.anything(), { behavior: "allow" }));
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await waitFor(() => expect(onRespond).toHaveBeenLastCalledWith(expect.anything(), { behavior: "deny" }));
  });

  it("编辑请求展示 diff，计划请求展示计划正文", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const edit: AgentPermissionRequest = {
      id: "p2",
      provider: "claude",
      name: "Edit",
      kind: "tool",
      detail: { type: "edit", filePath: "src/a.ts", unifiedDiff: "--- a\n+++ b\n-old\n+new" },
      actions: [
        { id: "allow", label: "允许一次", behavior: "allow" },
        { id: "deny", label: "拒绝", behavior: "deny" },
      ],
    };
    const { unmount } = render(<ApprovalDialog approval={approval(edit)} onRespond={onRespond} />);
    expect(screen.getByText(/修改文件：src\/a\.ts/)).toBeTruthy();
    expect(screen.getByText(/\+1 −1 行/)).toBeTruthy();
    expect(screen.getByText((_, node) => node?.tagName === "PRE" && node.textContent?.includes("+new") === true)).toBeTruthy();
    unmount();

    const plan: AgentPermissionRequest = {
      id: "p3",
      provider: "claude",
      name: "ExitPlanMode",
      kind: "plan",
      detail: { type: "plan", text: "1. 读代码\n2. 改代码" },
      actions: [
        { id: "approve", label: "批准计划", behavior: "allow" },
        { id: "keep_planning", label: "继续规划", behavior: "deny" },
      ],
    };
    render(<ApprovalDialog approval={approval(plan)} onRespond={onRespond} />);
    expect(screen.getByText("需要批准计划")).toBeTruthy();
    // Markdown 渲染器是懒加载的，加载前先显示纯文本兜底；两者都包含计划正文
    await waitFor(() => expect(document.body.textContent).toContain("读代码"));
    expect(screen.getByRole("button", { name: "批准计划" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "继续规划" })).toBeTruthy();
  });

  it("remaining ≥ 1 时显示「还有 N 条待处理」，为 0 或缺省时不显示（权限卡与提问卡）", () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(<ApprovalDialog approval={approval(undefined)} onRespond={onRespond} remaining={2} />);
    expect(screen.getByText("还有 2 条待处理")).toBeTruthy();
    rerender(<ApprovalDialog approval={approval(undefined)} onRespond={onRespond} remaining={0} />);
    expect(screen.queryByText(/条待处理/)).toBeNull();
    rerender(<ApprovalDialog approval={approval(undefined)} onRespond={onRespond} />);
    expect(screen.queryByText(/条待处理/)).toBeNull();

    const question: AgentPermissionRequest = {
      id: "pq2",
      provider: "claude",
      name: "AskUserQuestion",
      kind: "question",
      detail: { type: "question", questions: [{ question: "Q?", multiSelect: false, options: [{ label: "A" }] }] },
    };
    rerender(<ApprovalDialog approval={approval(question)} onRespond={onRespond} remaining={1} />);
    expect(screen.getByText("还有 1 条待处理")).toBeTruthy();
  });

  it("发送失败时显示错误并恢复按钮", async () => {
    const onRespond = vi.fn().mockRejectedValue(new Error("该审批请求已失效"));
    render(<ApprovalDialog approval={approval(undefined)} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: "允许" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("该审批请求已失效");
    expect((screen.getByRole("button", { name: "允许" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("ApprovalDialog：拒绝 / 继续规划附理由", () => {
  const tool: AgentPermissionRequest = {
    id: "p1",
    provider: "claude",
    name: "Bash",
    kind: "tool",
    actions: [
      { id: "allow", label: "允许一次", behavior: "allow" },
      { id: "deny", label: "拒绝", behavior: "deny" },
    ],
  };
  const plan: AgentPermissionRequest = {
    id: "p2",
    provider: "claude",
    name: "ExitPlanMode",
    kind: "plan",
    detail: { type: "plan", text: "## 步骤\n\n- 读代码\n- 改代码" },
    actions: [
      { id: "approve", label: "批准计划", behavior: "allow" },
      { id: "keep_planning", label: "继续规划", behavior: "deny" },
    ],
  };

  it("理由入口默认折叠；不展开时拒绝不带 message（常规操作不多一步）", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalDialog approval={approval(tool)} onRespond={onRespond} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("button", { name: "添加理由" }).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(1));
    expect(onRespond.mock.calls[0]![1]).toEqual({ behavior: "deny", selectedActionId: "deny" });
  });

  it("点开出单行输入，再点拒绝提交理由（去首尾空白）；允许不带理由", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalDialog approval={approval(tool)} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: "添加理由" }));
    const input = screen.getByRole("textbox", { name: "理由" }) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "  别动生产配置  " } });
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(1));
    expect(onRespond.mock.calls[0]![1]).toEqual({ behavior: "deny", selectedActionId: "deny", message: "别动生产配置" });

    fireEvent.click(screen.getByRole("button", { name: "允许一次" }));
    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(2));
    expect(onRespond.mock.calls[1]![1]).toEqual({ behavior: "allow", selectedActionId: "allow" });
  });

  it("在输入框里回车提交第一个拒绝动作；输入法选词中的回车不提交；空理由不带 message", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalDialog approval={approval(tool)} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: "添加理由" }));
    const input = screen.getByRole("textbox", { name: "理由" });
    fireEvent.change(input, { target: { value: "太危险" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onRespond).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(1));
    expect(onRespond.mock.calls[0]![1]).toEqual({ behavior: "deny", selectedActionId: "deny", message: "太危险" });
  });

  it("展开后把输入框滚进可视区（软键盘）；空输入回车等同直接拒绝", async () => {
    vi.useFakeTimers();
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
    const onRespond = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalDialog approval={approval(tool)} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: "添加理由" }));
    await vi.advanceTimersByTimeAsync(300);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "理由" }), { key: "Enter" });
    await vi.advanceTimersByTimeAsync(0);
    expect(onRespond.mock.calls[0]![1]).toEqual({ behavior: "deny", selectedActionId: "deny" });
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("计划：「继续规划」的入口叫「意见」，意见作为 message 回传", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalDialog approval={approval(plan)} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: "添加意见" }));
    fireEvent.change(screen.getByRole("textbox", { name: "意见" }), { target: { value: "先补测试再改" } });
    fireEvent.click(screen.getByRole("button", { name: "继续规划" }));
    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(1));
    expect(onRespond.mock.calls[0]![1]).toEqual({
      behavior: "deny",
      selectedActionId: "keep_planning",
      message: "先补测试再改",
    });
  });

  it("没有拒绝类动作时不显示理由入口；默认 允许 / 拒绝 也有", () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const allowOnly: AgentPermissionRequest = { ...tool, actions: [{ id: "allow", label: "允许", behavior: "allow" }] };
    const { unmount } = render(<ApprovalDialog approval={approval(allowOnly)} onRespond={onRespond} />);
    expect(screen.queryByRole("button", { name: "添加理由" })).toBeNull();
    unmount();
    render(<ApprovalDialog approval={approval(undefined)} onRespond={onRespond} />);
    expect(screen.getByRole("button", { name: "添加理由" })).toBeTruthy();
  });

  it("计划用 Markdown 渲染（列表 / 标题），容器限高 320px 可滚动", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const { container } = render(<ApprovalDialog approval={approval(plan)} onRespond={onRespond} />);
    const box = container.querySelector('[data-kind="plan"]');
    expect(box).toBeTruthy();
    await waitFor(() => expect(box!.querySelectorAll("li").length).toBe(2), { timeout: 5000 });
    expect(box!.querySelector("pre")).toBeNull();
    expect(screen.getByText("读代码")).toBeTruthy();
  });
});

describe("ApprovalDialog：并发处理（PERMISSION_NOT_FOUND）", () => {
  const request: AgentPermissionRequest = { id: "p1", provider: "claude", name: "Bash", kind: "tool", title: "执行命令" };

  function seedStore() {
    const pending = approval(request);
    getDefaultStore().set(chatRuntimeBySessionAtom, {
      "agent-1": { ...createEmptyChatRuntime(0), pendingApprovals: [pending] },
    });
    return pending;
  }

  it("权限卡：另一端已处理 → 显示「已在其他设备处理」、禁用按钮，稍后移除该卡片", async () => {
    const pending = seedStore();
    const onRespond = vi.fn().mockRejectedValue(rpcError("PERMISSION_NOT_FOUND"));
    render(<ApprovalDialog approval={pending} onRespond={onRespond} />);
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "允许" }));
    await vi.waitFor(() => expect(screen.getByText("已在其他设备处理")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: "允许" }) as HTMLButtonElement).disabled).toBe(true);
    expect(getDefaultStore().get(chatRuntimeBySessionAtom)["agent-1"]!.pendingApprovals).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(HANDLED_ELSEWHERE_REMOVE_DELAY_MS);
    expect(getDefaultStore().get(chatRuntimeBySessionAtom)["agent-1"]!.pendingApprovals).toHaveLength(0);
  });

  it("提问卡同样处理 PERMISSION_NOT_FOUND", async () => {
    const question: AgentPermissionRequest = {
      id: "p1",
      provider: "claude",
      name: "AskUserQuestion",
      kind: "question",
      detail: { type: "question", questions: [{ question: "Q?", multiSelect: false, options: [{ label: "A" }] }] },
    };
    const pending = approval(question);
    getDefaultStore().set(chatRuntimeBySessionAtom, {
      "agent-1": { ...createEmptyChatRuntime(0), pendingApprovals: [pending] },
    });
    const onRespond = vi.fn().mockRejectedValue(rpcError("PERMISSION_NOT_FOUND"));
    render(<ApprovalDialog approval={pending} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: "跳过" }));
    expect(await screen.findByText("已在其他设备处理")).toBeTruthy();
    expect((screen.getByRole("button", { name: "跳过" }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(
      () => expect(getDefaultStore().get(chatRuntimeBySessionAtom)["agent-1"]!.pendingApprovals).toHaveLength(0),
      { timeout: HANDLED_ELSEWHERE_REMOVE_DELAY_MS + 1500 },
    );
  });

  it("其它错误经 humanizeSidecarError 汉化后显示，卡片保留可重试", async () => {
    const pending = seedStore();
    const onRespond = vi.fn().mockRejectedValue(rpcError("AGENT_CLOSED", "closed"));
    render(<ApprovalDialog approval={pending} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: "允许" }));
    expect((await screen.findByRole("alert")).textContent).toContain("该会话已关闭，请新建会话");
    expect(screen.queryByText("已在其他设备处理")).toBeNull();
    expect((screen.getByRole("button", { name: "允许" }) as HTMLButtonElement).disabled).toBe(false);
    expect(getDefaultStore().get(chatRuntimeBySessionAtom)["agent-1"]!.pendingApprovals).toHaveLength(1);
  });
});

describe("ApprovalDialog：Agent 提问（design.md 4.13）", () => {
  const QUESTION_REQUEST: AgentPermissionRequest = {
    id: "pq",
    provider: "claude",
    name: "AskUserQuestion",
    kind: "question",
    title: "Claude 有问题需要你回答",
    input: { questions: ["原样回传"] },
    detail: {
      type: "question",
      questions: [
        {
          question: "用哪个库？",
          header: "库",
          multiSelect: false,
          options: [
            { label: "dayjs", description: "轻量" },
            { label: "luxon", description: "功能全", preview: "DateTime.now()" },
          ],
        },
        {
          question: "启用哪些功能？",
          multiSelect: true,
          options: [{ label: "缓存" }, { label: "日志" }],
        },
      ],
    },
    actions: [
      { id: "submit", label: "提交回答", behavior: "allow" },
      { id: "skip", label: "跳过", behavior: "deny" },
    ],
  };

  it("单选 + 多选（含「其他」）全部作答后才可提交，answers 键为问题原文、多选以 \", \" 拼接", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalDialog approval={approval(QUESTION_REQUEST)} onRespond={onRespond} />);

    expect(screen.getByText("Claude 有问题需要你回答")).toBeTruthy();
    expect(screen.getByText("库")).toBeTruthy();
    expect(screen.getByText("轻量")).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "用哪个库？" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "启用哪些功能？" })).toBeTruthy();
    const submit = screen.getByRole("button", { name: "提交回答" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: /luxon/ }));
    // 单选只展示选中项的 preview
    expect(screen.getByText("DateTime.now()")).toBeTruthy();
    expect(submit.disabled).toBe(true);

    fireEvent.click(screen.getByRole("checkbox", { name: "缓存" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "日志" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "日志" }));
    const others = screen.getAllByRole("checkbox", { name: "其他" });
    fireEvent.click(others[0]!);
    // 选了「其他」但还没写内容：仍可提交（已选「缓存」），写了内容后并入答案
    fireEvent.change(screen.getByRole("textbox", { name: "启用哪些功能？：其他回答" }), {
      target: { value: " 自定义 " },
    });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(1));
    expect(onRespond.mock.calls[0]![1]).toEqual({
      behavior: "allow",
      selectedActionId: "submit",
      updatedInput: {
        questions: ["原样回传"],
        answers: { "用哪个库？": "luxon", "启用哪些功能？": "缓存, 自定义" },
      },
    });
  });

  it("单选「其他」：空文本不可提交，答案为输入的文本", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalDialog approval={approval(QUESTION_REQUEST)} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("radio", { name: "其他" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "日志" }));
    const submit = screen.getByRole("button", { name: "提交回答" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "用哪个库？：其他回答" }), {
      target: { value: "date-fns" },
    });
    fireEvent.click(submit);
    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(1));
    expect(onRespond.mock.calls[0]![1]).toMatchObject({
      updatedInput: { answers: { "用哪个库？": "date-fns", "启用哪些功能？": "日志" } },
    });
  });

  it("跳过回传 deny + skip", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalDialog approval={approval(QUESTION_REQUEST)} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: "跳过" }));
    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(1));
    expect(onRespond.mock.calls[0]![1]).toEqual({
      behavior: "deny",
      selectedActionId: "skip",
      message: "用户跳过了这些问题",
    });
  });
});

describe("PermissionCard：始终允许与 defaultDeny", () => {
  const ALWAYS_REQUEST: AgentPermissionRequest = {
    id: "pa1",
    provider: "claude",
    name: "Bash",
    kind: "tool",
    detail: { type: "shell", command: "git status" },
    actions: [
      { id: "allow", label: "允许一次", behavior: "allow" },
      { id: "deny", label: "拒绝", behavior: "deny" },
      {
        id: "allow_session",
        label: "本会话始终允许",
        behavior: "allow",
        persist: "session",
        description: "仅本会话有效，不写入文件：Bash(git status)",
      },
      {
        id: "allow_project",
        label: "永久允许",
        behavior: "allow",
        persist: "permanent",
        description: "写入项目的 .claude/settings.local.json：Bash(git status)",
      },
    ],
  };

  it("始终允许类按钮标记 persist，回传对应 selectedActionId；动作说明显示在按钮下方并带 tooltip", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalDialog approval={approval(ALWAYS_REQUEST)} onRespond={onRespond} />);

    const project = screen.getByRole("button", { name: "永久允许" });
    expect(project.getAttribute("data-persist")).toBe("permanent");
    expect(project.getAttribute("title")).toBe("写入项目的 .claude/settings.local.json：Bash(git status)");
    expect(screen.getByRole("button", { name: "本会话始终允许" }).getAttribute("data-persist")).toBe("session");
    expect(screen.getByRole("button", { name: "允许一次" }).getAttribute("data-persist")).toBeNull();
    // 说明行（手机没有 hover，tooltip 之外再显示一份）
    expect(screen.getByText(/写入项目的 \.claude\/settings\.local\.json：Bash\(git status\)/, { selector: "li" })).toBeTruthy();

    fireEvent.click(project);
    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(1));
    expect(onRespond.mock.calls[0]![1]).toEqual({ behavior: "allow", selectedActionId: "allow_project" });
  });

  it("没有说明的动作不渲染说明行", () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const plain: AgentPermissionRequest = { ...ALWAYS_REQUEST, actions: ALWAYS_REQUEST.actions!.slice(0, 2) };
    const { container } = render(<ApprovalDialog approval={approval(plain)} onRespond={onRespond} />);
    expect(container.querySelector("ul")).toBeNull();
  });

  it("defaultDeny：拒绝排在最前并标为主按钮，允许类不带主按钮标记", () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalDialog approval={approval({ ...ALWAYS_REQUEST, defaultDeny: true })} onRespond={onRespond} />);
    const labels = screen.getAllByRole("button").map((button) => button.textContent);
    expect(labels).toEqual(["拒绝", "允许一次", "本会话始终允许", "永久允许", "理由"]);
    expect(screen.getByRole("button", { name: "拒绝" }).getAttribute("data-primary")).toBe("true");
    expect(screen.getByRole("button", { name: "允许一次" }).getAttribute("data-primary")).toBeNull();
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "允许一次" }));
  });

  it("未设置 defaultDeny 时保持原有顺序且无主按钮标记", () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalDialog approval={approval(ALWAYS_REQUEST)} onRespond={onRespond} />);
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "允许一次",
      "拒绝",
      "本会话始终允许",
      "永久允许",
      "理由",
    ]);
    expect(screen.getByRole("button", { name: "拒绝" }).getAttribute("data-primary")).toBeNull();
  });
});
