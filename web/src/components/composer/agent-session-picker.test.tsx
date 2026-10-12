// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ProviderInfo } from "@agentdeck/protocol";
import { AgentSessionPicker } from "./agent-session-picker";
import { resolveProvider } from "@/lib/agent-selection";

afterEach(() => cleanup());

const PROVIDERS: ProviderInfo[] = [
  { id: "claude", kind: "claude", label: "Claude Code", available: false, unavailableReason: "未找到 claude 可执行文件" },
  { id: "codex", kind: "codex", label: "Codex", available: true },
  { id: "mock", kind: "mock", label: "Mock", available: true },
];

const CATALOG = {
  models: [{ provider: "codex", id: "gpt-5", label: "GPT-5", isDefault: true }],
  modes: [
    { id: "read-only", label: "只读" },
    { id: "auto", label: "自动" },
    { id: "full-access", label: "完全访问", dangerous: true },
  ],
};

describe("AgentSessionPicker", () => {
  it("不可用的 provider 置灰并显示原因", () => {
    render(
      <AgentSessionPicker
        selection={{ provider: "codex", model: null, modeId: null }}
        onChange={vi.fn()}
        providers={PROVIDERS}
        catalog={CATALOG}
      />,
    );
    const claude = screen.getByRole("option", { name: "Claude Code（不可用：未找到 claude 可执行文件）" }) as HTMLOptionElement;
    expect(claude.disabled).toBe(true);
    expect((screen.getByRole("option", { name: "Codex" }) as HTMLOptionElement).disabled).toBe(false);
    expect((screen.getByLabelText("Agent") as HTMLSelectElement).value).toBe("codex");
  });

  it("切换 provider 时清空模型与模式；选择模型 / 模式回调新选择", () => {
    const onChange = vi.fn();
    render(
      <AgentSessionPicker
        selection={{ provider: "codex", model: null, modeId: null }}
        onChange={onChange}
        providers={PROVIDERS}
        catalog={CATALOG}
      />,
    );
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "mock" } });
    expect(onChange).toHaveBeenLastCalledWith({ provider: "mock", model: null, modeId: null });
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: "gpt-5" } });
    expect(onChange).toHaveBeenLastCalledWith({ provider: "codex", model: "gpt-5", modeId: null });
    fireEvent.change(screen.getByLabelText("模式"), { target: { value: "auto" } });
    expect(onChange).toHaveBeenLastCalledWith({ provider: "codex", model: null, modeId: "auto" });
  });

  it("危险模式醒目标注，选中时给出警告", () => {
    const { rerender } = render(
      <AgentSessionPicker
        selection={{ provider: "codex", model: null, modeId: null }}
        onChange={vi.fn()}
        providers={PROVIDERS}
        catalog={CATALOG}
      />,
    );
    expect(screen.getByRole("option", { name: "完全访问（危险：跳过权限确认）" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();

    rerender(
      <AgentSessionPicker
        selection={{ provider: "codex", model: null, modeId: "full-access" }}
        onChange={vi.fn()}
        providers={PROVIDERS}
        catalog={CATALOG}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("危险模式");
  });

  it("危险与否只看 AgentMode.dangerous，不按 id 判断", () => {
    render(
      <AgentSessionPicker
        selection={{ provider: "claude", model: null, modeId: "bypassPermissions" }}
        onChange={vi.fn()}
        providers={PROVIDERS}
        catalog={{
          models: [],
          modes: [
            { id: "bypassPermissions", label: "未标记" },
            { id: "custom-yolo", label: "全自动", dangerous: true },
          ],
        }}
      />,
    );
    expect(screen.getByRole("option", { name: "未标记" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "全自动（危险：跳过权限确认）" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("模型列表为空时只有默认选项（ACP 首次建会话前）", () => {
    render(
      <AgentSessionPicker
        selection={{ provider: "codex", model: null, modeId: null }}
        onChange={vi.fn()}
        providers={PROVIDERS}
        catalog={{ models: [], modes: [] }}
      />,
    );
    const model = screen.getByLabelText("模型") as HTMLSelectElement;
    expect(Array.from(model.options).map((option) => option.textContent)).toEqual(["默认模型"]);
    expect(model.value).toBe("");
  });

  it("resolveProvider 跳过不可用的记忆值，优先真实 Agent", () => {
    expect(resolveProvider("claude", PROVIDERS)).toBe("codex");
    expect(resolveProvider("mock", PROVIDERS)).toBe("mock");
    expect(resolveProvider(null, [PROVIDERS[0]!, PROVIDERS[2]!])).toBe("mock");
    expect(resolveProvider(null, [PROVIDERS[0]!])).toBeNull();
  });
});
