// @vitest-environment jsdom
// 侧栏会话列表：不显示归档、置顶在前；右键菜单的重命名 / 置顶 / 归档 / 导出（design.md 4.17）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Provider, createStore } from "jotai";
import type { AgentSnapshot } from "@agentdeck/protocol";
import { AGENT_STATUS_LABELS } from "@/lib/agent-session-display";
import { stubRadixGlobals } from "@/test-utils/radix";
import { ConfirmProvider } from "@/lib/use-confirm";
import { replaceAgentSnapshotsAtom } from "@/stores/agents";
import { WorkbenchSidebar } from "./workbench-sidebar";

stubRadixGlobals();

const updateSession = vi.fn(async (_id: string, _patch: unknown) => ({}));
const fetchAllTimelineEntries = vi.fn(async (_id: string) => [] as unknown[]);
const forkSession = vi.fn(async (id: string, _options?: unknown) => ({ id: `${id}-fork` }));
vi.mock("@/hooks/use-agent-session", () => ({
  useAgentSession: () => ({ updateSession, fetchAllTimelineEntries, forkSession, deleteSession: vi.fn() }),
  humanizeSidecarError: (error: unknown) => String(error),
}));
vi.mock("@/hooks/use-agent-catalog", () => ({ useAgentProviders: () => ({ data: undefined }) }));

function agent(id: string, patch: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id,
    provider: "claude",
    cwd: "C:/work/demo",
    title: `会话-${id}`,
    status: "idle",
    pendingPermissions: [],
    lastSeq: 0,
    resumable: false,
    createdAt: 1000,
    updatedAt: 2000,
    ...patch,
  };
}

function renderSidebar(agents: AgentSnapshot[]) {
  const store = createStore();
  store.set(replaceAgentSnapshotsAtom, agents);
  return render(
    <Provider store={store}>
      <ConfirmProvider>
        <MemoryRouter>
          <WorkbenchSidebar />
        </MemoryRouter>
      </ConfirmProvider>
    </Provider>,
  );
}

const exportSessionFile = vi.fn();

beforeEach(() => {
  window.agentdeckDesktop = { windowType: "tauri", exportSessionFile } as never;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.agentdeckDesktop = undefined;
});

describe("侧栏会话列表", () => {
  it("不显示归档的会话；置顶排在最前，组内按 updatedAt 倒序", () => {
    renderSidebar([
      agent("new", { updatedAt: 5000 }),
      agent("pin-old", { pinned: true, updatedAt: 1000 }),
      agent("gone", { archived: true, updatedAt: 9000 }),
      agent("pin-new", { pinned: true, updatedAt: 3000 }),
    ]);
    expect(screen.queryByText("会话-gone")).toBeNull();
    const order = screen.getAllByText(/^会话-/).map((node) => node.textContent);
    expect(order).toEqual(["会话-pin-new", "会话-pin-old", "会话-new"]);
  });
});

describe("侧栏会话状态（backgroundActive）", () => {
  it("idle 且 backgroundActive 显示「运行中」文案；普通 idle 显示「空闲」", () => {
    renderSidebar([agent("bg", { backgroundActive: true }), agent("plain")]);
    expect(screen.getAllByText(new RegExp(AGENT_STATUS_LABELS.running))).toHaveLength(1);
    expect(screen.getAllByText(new RegExp(AGENT_STATUS_LABELS.idle))).toHaveLength(1);
  });
});

describe("会话右键菜单（4.17）", () => {
  it("菜单含重命名 / 置顶 / 归档 / 导出；点置顶与归档调用 agent.update", async () => {
    renderSidebar([agent("a")]);
    fireEvent.contextMenu(screen.getByText("会话-a"));
    for (const label of ["重命名", "置顶会话", "归档会话", "导出为 JSON", "导出为 Markdown"]) {
      expect(await screen.findByRole("menuitem", { name: label })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("menuitem", { name: "置顶会话" }));
    await waitFor(() => expect(updateSession).toHaveBeenCalledWith("a", { pinned: true }));

    fireEvent.contextMenu(screen.getByText("会话-a"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "归档会话" }));
    await waitFor(() => expect(updateSession).toHaveBeenCalledWith("a", { archived: true }));
  });

  it("分叉会话（4.23）：调用 agent.fork（整会话，不带 throughSeq）；运行中的会话禁用", async () => {
    renderSidebar([agent("a")]);
    fireEvent.contextMenu(screen.getByText("会话-a"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "分叉会话" }));
    await waitFor(() => expect(forkSession).toHaveBeenCalledWith("a", {}));
    cleanup();

    renderSidebar([agent("b", { status: "running" })]);
    fireEvent.contextMenu(screen.getByText("会话-b"));
    const item = await screen.findByRole("menuitem", { name: "分叉会话" });
    expect(item.getAttribute("aria-disabled") === "true" || item.hasAttribute("data-disabled")).toBe(true);
  });

  it("分叉失败时用提示框反馈", async () => {
    forkSession.mockRejectedValueOnce(new Error("原生分叉会话失败：炸了"));
    renderSidebar([agent("a")]);
    fireEvent.contextMenu(screen.getByText("会话-a"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "分叉会话" }));
    expect(await screen.findByText(/原生分叉会话失败：炸了/)).toBeTruthy();
  });

  it("已置顶显示「取消置顶会话」；运行中的会话不提供归档", async () => {
    renderSidebar([agent("a", { pinned: true, status: "running" })]);
    fireEvent.contextMenu(screen.getByText("会话-a"));
    expect(await screen.findByRole("menuitem", { name: "取消置顶会话" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "归档会话" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "取消归档" })).toBeNull();
  });

  it("重命名：保存新标题；恢复自动标题以 null 提交；取消不调用", async () => {
    renderSidebar([agent("a")]);
    fireEvent.contextMenu(screen.getByText("会话-a"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "重命名" }));
    const input = (await screen.findByLabelText("会话标题")) as HTMLInputElement;
    expect(input.value).toBe("会话-a");
    fireEvent.change(input, { target: { value: "新名字" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(updateSession).toHaveBeenCalledWith("a", { title: "新名字" }));

    fireEvent.contextMenu(screen.getByText("会话-a"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "重命名" }));
    fireEvent.click(await screen.findByRole("button", { name: "恢复自动标题" }));
    await waitFor(() => expect(updateSession).toHaveBeenLastCalledWith("a", { title: null }));

    updateSession.mockClear();
    fireEvent.contextMenu(screen.getByText("会话-a"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "重命名" }));
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));
    expect(updateSession).not.toHaveBeenCalled();
  });

  it("没有自定义标题时重命名弹窗不提供「恢复自动标题」", async () => {
    renderSidebar([agent("a", { title: undefined, preview: "首条消息" })]);
    fireEvent.contextMenu(screen.getByText("首条消息"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "重命名" }));
    expect(await screen.findByLabelText("会话标题")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "恢复自动标题" })).toBeNull();
  });

  it("导出：取全量时间线、调用桥并提示成功；取消保存对话框不提示", async () => {
    exportSessionFile.mockResolvedValueOnce({ ok: true, canceled: false, path: "C:/out/a.md", bytes: 10 });
    renderSidebar([agent("a")]);
    fireEvent.contextMenu(screen.getByText("会话-a"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "导出为 Markdown" }));
    await waitFor(() => expect(exportSessionFile).toHaveBeenCalledTimes(1));
    expect(fetchAllTimelineEntries).toHaveBeenCalledWith("a");
    const input = exportSessionFile.mock.calls[0]![0] as { fileName: string; content: string; format: string };
    expect(input.format).toBe("markdown");
    expect(input.fileName).toMatch(/^会话-a-\d{8}-\d{4}$/);
    expect(input.content.startsWith("# 会话-a\n")).toBe(true);
    expect(await screen.findByText(/已导出到 C:\/out\/a\.md/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));

    exportSessionFile.mockResolvedValueOnce({ ok: false, canceled: true, bytes: 0 });
    fireEvent.contextMenu(screen.getByText("会话-a"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "导出为 JSON" }));
    await waitFor(() => expect(exportSessionFile).toHaveBeenCalledTimes(2));
    expect((exportSessionFile.mock.calls[1]![0] as { format: string }).format).toBe("json");
    expect(screen.queryByText(/导出失败|导出成功/)).toBeNull();
  });

  it("导出失败时提示错误", async () => {
    exportSessionFile.mockResolvedValueOnce({ ok: false, canceled: false, bytes: 0, error: "拒绝访问" });
    renderSidebar([agent("a")]);
    fireEvent.contextMenu(screen.getByText("会话-a"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "导出为 JSON" }));
    expect(await screen.findByText("拒绝访问")).toBeTruthy();
  });
});
