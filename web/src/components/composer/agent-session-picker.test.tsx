// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ProviderInfo, ProviderProfile } from "@agentdeck/protocol";
import { stubRadixGlobals } from "@/test-utils/radix";
import { AgentSessionPicker } from "./agent-session-picker";
import { resolveProvider } from "@/lib/agent-selection";

stubRadixGlobals();
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

function openMenu(chipName: RegExp | string): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: chipName }));
  return screen.getByRole("listbox");
}

describe("AgentSessionPicker", () => {
  it("chip 只显示当前值，字段名放在 aria-label 与菜单标题", () => {
    render(
      <AgentSessionPicker
        selection={{ provider: "codex", model: null, modeId: null }}
        onChange={vi.fn()}
        providers={PROVIDERS}
        catalog={CATALOG}
      />,
    );
    const agentChip = screen.getByRole("button", { name: "Agent：Codex" });
    expect(agentChip.textContent).toBe("Codex");
    expect(screen.getByRole("button", { name: "模型：默认模型" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "模式：默认模式" })).toBeTruthy();

    const list = openMenu("模型：默认模型");
    expect(screen.getByRole("listbox", { name: "模型" })).toBe(list);
  });

  it("不可用的 provider 置灰并显示原因，当前项打勾", () => {
    render(
      <AgentSessionPicker
        selection={{ provider: "codex", model: null, modeId: null }}
        onChange={vi.fn()}
        providers={PROVIDERS}
        catalog={CATALOG}
      />,
    );
    const list = openMenu("Agent：Codex");
    const claude = within(list).getByRole("option", { name: /Claude Code/ });
    expect(claude.getAttribute("aria-disabled")).toBe("true");
    expect(claude.textContent).toContain("不可用：未找到 claude 可执行文件");
    const codex = within(list).getByRole("option", { name: /Codex/ });
    expect(codex.getAttribute("aria-disabled")).toBeNull();
    expect(codex.getAttribute("aria-selected")).toBe("true");
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
    fireEvent.click(within(openMenu("Agent：Codex")).getByRole("option", { name: /Mock/ }));
    expect(onChange).toHaveBeenLastCalledWith({ provider: "mock", model: null, modeId: null });
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.click(within(openMenu("模型：默认模型")).getByRole("option", { name: /GPT-5/ }));
    expect(onChange).toHaveBeenLastCalledWith({ provider: "codex", model: "gpt-5", modeId: null });

    fireEvent.click(within(openMenu("模式：默认模式")).getByRole("option", { name: /自动/ }));
    expect(onChange).toHaveBeenLastCalledWith({ provider: "codex", model: null, modeId: "auto" });
  });

  it("点击不可用的 provider 不触发选择", () => {
    const onChange = vi.fn();
    render(
      <AgentSessionPicker
        selection={{ provider: "codex", model: null, modeId: null }}
        onChange={onChange}
        providers={PROVIDERS}
        catalog={CATALOG}
      />,
    );
    fireEvent.click(within(openMenu("Agent：Codex")).getByRole("option", { name: /Claude Code/ }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("键盘：上下键移动并跳过不可用项，Enter 选择，Esc 关闭", () => {
    const onChange = vi.fn();
    render(
      <AgentSessionPicker
        selection={{ provider: "codex", model: null, modeId: null }}
        onChange={onChange}
        providers={PROVIDERS}
        catalog={CATALOG}
      />,
    );
    const list = openMenu("Agent：Codex");
    const activeText = () =>
      document.getElementById(list.getAttribute("aria-activedescendant") ?? "")?.textContent ?? "";
    expect(activeText()).toContain("Codex");

    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(activeText()).toContain("Codex");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(activeText()).toContain("Mock");
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith({ provider: "mock", model: null, modeId: null });
    expect(screen.queryByRole("listbox")).toBeNull();

    const reopened = openMenu("Agent：Codex");
    fireEvent.keyDown(reopened, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("危险模式醒目标注，选中时 chip 标红并给出警告", () => {
    const { rerender } = render(
      <AgentSessionPicker
        selection={{ provider: "codex", model: null, modeId: null }}
        onChange={vi.fn()}
        providers={PROVIDERS}
        catalog={CATALOG}
      />,
    );
    const list = openMenu("模式：默认模式");
    const danger = within(list).getByRole("option", { name: /完全访问/ });
    expect(danger.getAttribute("data-danger")).toBe("true");
    expect(danger.textContent).toContain("危险");
    expect(danger.textContent).toContain("跳过权限确认");
    expect(within(list).getByRole("option", { name: /自动/ }).getAttribute("data-danger")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.keyDown(list, { key: "Escape" });

    rerender(
      <AgentSessionPicker
        selection={{ provider: "codex", model: null, modeId: "full-access" }}
        onChange={vi.fn()}
        providers={PROVIDERS}
        catalog={CATALOG}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("危险模式");
    expect(screen.getByRole("button", { name: "模式：完全访问" }).getAttribute("data-danger")).toBe("true");
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
    expect(screen.getByRole("button", { name: "模式：未标记" }).getAttribute("data-danger")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    const list = openMenu("模式：未标记");
    expect(within(list).getByRole("option", { name: /未标记/ }).getAttribute("data-danger")).toBeNull();
    expect(within(list).getByRole("option", { name: /全自动/ }).getAttribute("data-danger")).toBe("true");
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
    const options = within(openMenu("模型：默认模型")).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]!.textContent).toContain("默认模型");
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");
    expect((screen.getByRole("button", { name: "模式：默认模式" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("禁用时三个 chip 都不可打开（已建会话同时锁定 Agent）", () => {
    render(
      <AgentSessionPicker
        selection={{ provider: "codex", model: null, modeId: null }}
        onChange={vi.fn()}
        providers={PROVIDERS}
        catalog={CATALOG}
        disabled
        providerLocked
      />,
    );
    for (const name of ["Agent：Codex", "模型：默认模型", "模式：默认模式"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("resolveProvider 跳过不可用的记忆值，优先真实 Agent", () => {
    expect(resolveProvider("claude", PROVIDERS)).toBe("codex");
    expect(resolveProvider("mock", PROVIDERS)).toBe("mock");
    expect(resolveProvider(null, [PROVIDERS[0]!, PROVIDERS[2]!])).toBe("mock");
    expect(resolveProvider(null, [PROVIDERS[0]!])).toBeNull();
  });

  it("中转分组：「内置」/「中转」标题，显示名用 label，副文字为「基于 … · host」，停用置灰", () => {
    const providers: ProviderInfo[] = [
      ...PROVIDERS,
      { id: "custom:relay", kind: "claude", label: "我的中转", available: true, custom: true, extends: "claude" },
    ];
    const profiles: ProviderProfile[] = [
      { id: "relay", extends: "claude", label: "我的中转", baseUrl: "http://127.0.0.1:8787" },
      { id: "off", extends: "codex", label: "停用中转", enabled: false },
    ];
    const onChange = vi.fn();
    render(
      <AgentSessionPicker
        selection={{ provider: "codex", model: null, modeId: null }}
        onChange={onChange}
        providers={providers}
        providerProfiles={profiles}
        catalog={CATALOG}
      />,
    );
    const list = openMenu("Agent：Codex");
    const titles = [...list.querySelectorAll('[role="presentation"]')].map((node) => node.textContent);
    expect(titles).toEqual(["内置", "中转"]);
    const names = within(list).getAllByRole("option").map((option) => option.textContent ?? "");
    expect(names.findIndex((name) => name.includes("Mock"))).toBeLessThan(names.findIndex((name) => name.includes("我的中转")));

    const relay = within(list).getByRole("option", { name: /我的中转/ });
    expect(relay.textContent).toContain("基于 Claude Code · 127.0.0.1:8787");
    expect(relay.getAttribute("aria-disabled")).toBeNull();
    const off = within(list).getByRole("option", { name: /停用中转/ });
    expect(off.getAttribute("aria-disabled")).toBe("true");
    expect(off.textContent).toContain("已停用");

    fireEvent.click(off);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(relay);
    expect(onChange).toHaveBeenLastCalledWith({ provider: "custom:relay", model: null, modeId: null });
  });

  it("没有中转时不显示分组标题", () => {
    render(
      <AgentSessionPicker
        selection={{ provider: "codex", model: null, modeId: null }}
        onChange={vi.fn()}
        providers={PROVIDERS}
        providerProfiles={[]}
        catalog={CATALOG}
      />,
    );
    const list = openMenu("Agent：Codex");
    expect(list.querySelectorAll('[role="presentation"]')).toHaveLength(0);
  });

  it("记忆的中转被删除或停用：resolveProvider 回退到默认 Agent，不报错", () => {
    const providers: ProviderInfo[] = [
      ...PROVIDERS,
      { id: "custom:relay", kind: "claude", label: "我的中转", available: true, custom: true },
    ];
    expect(resolveProvider("custom:relay", providers)).toBe("custom:relay");
    // 删除 / 停用后 provider.list 中不再有该项
    expect(resolveProvider("custom:relay", PROVIDERS)).toBe("codex");
    // provider.list 尚未加载时保持记忆值，不提前回退
    expect(resolveProvider("custom:relay", null)).toBe("custom:relay");
  });
});
