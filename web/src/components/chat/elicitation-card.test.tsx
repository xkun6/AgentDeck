// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentPermissionRequest, ElicitationField } from "@agentdeck/protocol";
import { getDefaultStore } from "jotai";
import { SidecarRpcError } from "@/lib/sidecar-client";
import { chatRuntimeBySessionAtom, type PendingApproval } from "@/stores/chat";
import { ApprovalDialog } from "./approval-dialog";

const { openExternalUrl } = vi.hoisted(() => ({ openExternalUrl: vi.fn() }));
vi.mock("@/lib/external-links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/external-links")>()),
  openExternalUrl,
}));

afterEach(() => {
  cleanup();
  openExternalUrl.mockReset();
  getDefaultStore().set(chatRuntimeBySessionAtom, {});
});

const FIELDS: ElicitationField[] = [
  { key: "name", title: "姓名", description: "你的名字", required: true, type: "string", minLength: 2 },
  { key: "password", title: "密码", required: false, type: "string", secret: true },
  {
    key: "level",
    title: "等级",
    required: false,
    type: "select",
    options: [
      { value: "lo", label: "低" },
      { value: "hi", label: "高" },
    ],
  },
  {
    key: "city",
    title: "城市",
    required: false,
    type: "select",
    options: ["a", "b", "c", "d", "e"].map((value) => ({ value, label: `城市${value}` })),
  },
  { key: "agree", title: "同意条款", required: false, type: "boolean", default: true },
  { key: "score", title: "分数", required: false, type: "number", min: 0, max: 10 },
  {
    key: "tags",
    title: "标签",
    required: false,
    type: "multiselect",
    max: 2,
    options: [
      { value: "x", label: "标签X" },
      { value: "y", label: "标签Y" },
      { value: "z", label: "标签Z" },
    ],
  },
];

function formRequest(fields: ElicitationField[] = FIELDS, patch: Partial<AgentPermissionRequest> = {}): AgentPermissionRequest {
  return {
    id: "e1",
    provider: "claude",
    name: "mcp:forms",
    kind: "elicitation",
    title: "forms 需要你填写表单",
    detail: { type: "elicitation", serverName: "forms", mode: "form", message: "请填写以下资料", fields },
    actions: [
      { id: "submit", label: "提交", behavior: "allow" },
      { id: "decline", label: "拒绝", behavior: "deny" },
      { id: "cancel", label: "取消", behavior: "deny" },
    ],
    ...patch,
  };
}

function urlRequest(url = "https://example.com/auth"): AgentPermissionRequest {
  return {
    id: "e2",
    provider: "claude",
    name: "mcp:oauth",
    kind: "elicitation",
    detail: { type: "elicitation", serverName: "oauth", mode: "url", message: "请在浏览器里授权", url, elicitationId: "x1" },
    actions: [
      { id: "done", label: "已完成", behavior: "allow" },
      { id: "decline", label: "拒绝", behavior: "deny" },
      { id: "cancel", label: "取消", behavior: "deny" },
    ],
  };
}

function approval(permission: AgentPermissionRequest): PendingApproval {
  return { requestId: permission.id, sessionId: "agent-1", command: "", permission };
}

function lastResponse(onRespond: ReturnType<typeof vi.fn>) {
  return onRespond.mock.calls.at(-1)![1];
}

describe("ElicitationCard（form）", () => {
  it("按 fields 渲染各类控件：文本、遮罩、单选组、下拉、开关（带默认值）、数字、多选", () => {
    render(<ApprovalDialog approval={approval(formRequest())} onRespond={vi.fn()} />);

    expect(screen.getByText("forms 需要你填写表单")).toBeTruthy();
    expect(screen.getByText("请填写以下资料")).toBeTruthy();
    expect(screen.getByText("你的名字")).toBeTruthy();
    expect((screen.getByLabelText(/姓名/) as HTMLInputElement).type).toBe("text");
    expect((screen.getByLabelText("密码") as HTMLInputElement).type).toBe("password");
    // ≤4 个选项：单选组；更多：下拉
    expect(screen.getByRole("radiogroup", { name: "等级" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "低" })).toBeTruthy();
    const dropdown = screen.getByLabelText("城市") as HTMLSelectElement;
    expect(dropdown.tagName).toBe("SELECT");
    expect(within(dropdown).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "（不选择）",
      "城市a",
      "城市b",
      "城市c",
      "城市d",
      "城市e",
    ]);
    expect((screen.getByLabelText("同意条款") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByLabelText("分数")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "标签X" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "提交" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消" })).toBeTruthy();
  });

  it("必填 / 长度 / 数值范围 / 多选上限校验：未通过不提交并显示错误，通过后回传 content", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalDialog approval={approval(formRequest())} onRespond={onRespond} />);

    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(onRespond).not.toHaveBeenCalled();
    expect(screen.getByText("必填")).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/姓名/), { target: { value: "a" } });
    expect(screen.getByText("不能少于 2 个字符")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/姓名/), { target: { value: "小明" } });
    fireEvent.change(screen.getByLabelText("分数"), { target: { value: "11" } });
    expect(screen.getByText("不能大于 10")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("分数"), { target: { value: "abc" } });
    expect(screen.getByText("请输入数字")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("分数"), { target: { value: "7.5" } });

    fireEvent.click(screen.getByRole("checkbox", { name: "标签X" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "标签Y" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "标签Z" }));
    expect(screen.getByText("最多选择 2 项")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "标签Z" }));

    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByRole("radio", { name: "高" }));
    fireEvent.change(screen.getByLabelText("城市"), { target: { value: "c" } });
    fireEvent.click(screen.getByLabelText("同意条款"));

    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(1));
    expect(lastResponse(onRespond)).toEqual({
      behavior: "allow",
      selectedActionId: "submit",
      updatedInput: {
        content: {
          name: "小明",
          password: "s3cret",
          level: "hi",
          city: "c",
          agree: false,
          score: 7.5,
          tags: ["x", "y"],
        },
      },
    });
  });

  it("选填字段留空时不进 content；默认值会被预填并提交", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const fields: ElicitationField[] = [
      { key: "a", required: false, type: "string", default: "默认" },
      { key: "b", required: false, type: "string" },
      { key: "ok", required: false, type: "boolean" },
    ];
    render(<ApprovalDialog approval={approval(formRequest(fields))} onRespond={onRespond} />);
    expect((screen.getByLabelText("a") as HTMLInputElement).value).toBe("默认");
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(1));
    expect(lastResponse(onRespond).updatedInput).toEqual({ content: { a: "默认", ok: false } });
  });

  it("拒绝回传 deny + decline；取消回传 deny + cancel + interrupt", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalDialog approval={approval(formRequest())} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(1));
    expect(lastResponse(onRespond)).toEqual({ behavior: "deny", selectedActionId: "decline" });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(2));
    expect(lastResponse(onRespond)).toEqual({ behavior: "deny", selectedActionId: "cancel", interrupt: true });
  });

  it("没有 fields 的表单可直接提交（content 为空对象）；remaining 提示条数", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalDialog approval={approval(formRequest([]))} onRespond={onRespond} remaining={2} />);
    expect(screen.getByText("还有 2 条待处理")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(1));
    expect(lastResponse(onRespond).updatedInput).toEqual({ content: {} });
  });

  it("发送失败显示错误并保留已填内容；PERMISSION_NOT_FOUND 显示「已在其他设备处理」并禁用按钮", async () => {
    const onRespond = vi.fn().mockRejectedValueOnce(new Error("网络断开"));
    render(<ApprovalDialog approval={approval(formRequest([{ key: "a", required: false, type: "string" }]))} onRespond={onRespond} />);
    fireEvent.change(screen.getByLabelText("a"), { target: { value: "保留我" } });
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect((await screen.findByRole("alert")).textContent).toContain("网络断开");
    expect((screen.getByLabelText("a") as HTMLInputElement).value).toBe("保留我");

    onRespond.mockRejectedValueOnce(
      new SidecarRpcError({ code: -32000, message: "找不到待处理的权限请求", data: { code: "PERMISSION_NOT_FOUND" } }),
    );
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(await screen.findByText("已在其他设备处理")).toBeTruthy();
    expect((screen.getByRole("button", { name: "提交" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("ElicitationCard（url）", () => {
  it("显示说明与链接，点按钮用系统浏览器打开；已完成回传 allow + done（无 content）", async () => {
    openExternalUrl.mockResolvedValue(true);
    const onRespond = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalDialog approval={approval(urlRequest())} onRespond={onRespond} />);

    expect(screen.getByText("oauth 需要你在浏览器中完成操作")).toBeTruthy();
    expect(screen.getByText("请在浏览器里授权")).toBeTruthy();
    expect(screen.getByText("https://example.com/auth")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "在浏览器中打开" }));
    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledWith("https://example.com/auth"));

    fireEvent.click(screen.getByRole("button", { name: "已完成" }));
    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(1));
    expect(lastResponse(onRespond)).toEqual({ behavior: "allow", selectedActionId: "done" });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(2));
    expect(lastResponse(onRespond)).toEqual({ behavior: "deny", selectedActionId: "cancel", interrupt: true });
  });

  it("打开失败给出提示；不安全的链接协议不提供打开按钮", async () => {
    openExternalUrl.mockResolvedValue(false);
    const { unmount } = render(<ApprovalDialog approval={approval(urlRequest())} onRespond={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "在浏览器中打开" }));
    expect((await screen.findByRole("alert")).textContent).toContain("无法打开链接");
    unmount();
    openExternalUrl.mockClear();

    render(<ApprovalDialog approval={approval(urlRequest("javascript:alert(1)"))} onRespond={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "在浏览器中打开" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("链接协议不受支持");
    expect(openExternalUrl).not.toHaveBeenCalled();
  });
});
