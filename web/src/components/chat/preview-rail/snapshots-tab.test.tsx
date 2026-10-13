// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider as JotaiProvider, createStore } from "jotai";
import type { SnapshotTurn } from "@agentdeck/protocol";
import { sidecarConnectionAtom } from "@/stores/agents";

const listSnapshots = vi.fn<(agentId: string) => Promise<SnapshotTurn[]>>();
const snapshotDiff = vi.fn();
const restoreSnapshot = vi.fn();
vi.mock("@/hooks/use-agent-session", () => ({
  useAgentSession: () => ({ listSnapshots, snapshotDiff, restoreSnapshot }),
  humanizeSidecarError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import { SnapshotsTab } from "./snapshots-tab";

afterEach(() => {
  cleanup();
  listSnapshots.mockReset();
  snapshotDiff.mockReset();
  restoreSnapshot.mockReset();
});

const TURNS: SnapshotTurn[] = [
  {
    turnId: "t1",
    seq: 2,
    startedAt: 1_700_000_000_000,
    before: "b1",
    after: "a1",
    changedFiles: [
      { path: "src/a.ts", status: "M" },
      { path: "src/new.ts", status: "A" },
    ],
  },
  { turnId: "t2", seq: 9, startedAt: 1_700_000_100_000, before: "a1", after: "a1", changedFiles: [] },
  {
    turnId: "t3",
    seq: 15,
    startedAt: 1_700_000_200_000,
    before: null,
    after: null,
    changedFiles: [],
    skipped: "too_many_files",
  },
];

function renderTab(selectedTurnId: string | null = null) {
  const store = createStore();
  store.set(sidecarConnectionAtom, "open");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <JotaiProvider store={store}>
        <SnapshotsTab agentId="agent-1" selectedTurnId={selectedTurnId} />
      </JotaiProvider>
    </QueryClientProvider>,
  );
}

describe("SnapshotsTab", () => {
  it("按回合列出：有变化的显示文件数，跳过的显示原因，无变化的回合不列出", async () => {
    listSnapshots.mockResolvedValue(TURNS);
    renderTab();
    expect(await screen.findByText("2 个文件")).toBeTruthy();
    expect(screen.getByText("文件过多，已跳过快照")).toBeTruthy();
    expect(screen.queryByText("回合 2")).toBeNull();
  });

  it("展开回合显示文件状态与 diff，选择文件时只请求该文件的 diff", async () => {
    listSnapshots.mockResolvedValue(TURNS);
    snapshotDiff.mockResolvedValue({ diff: "--- a/src/a.ts\n+新增行\n", truncated: false });
    renderTab("t1");
    expect(await screen.findByText("src/new.ts")).toBeTruthy();
    expect(await screen.findByText("+新增行")).toBeTruthy();
    expect(snapshotDiff).toHaveBeenCalledWith("agent-1", "t1", {});
    fireEvent.click(screen.getByText("src/a.ts"));
    await waitFor(() =>
      expect(snapshotDiff).toHaveBeenCalledWith("agent-1", "t1", { path: "src/a.ts" }),
    );
  });

  it("回滚确认弹窗列出将恢复 / 删除的文件，确认后调用 restore 并提示结果", async () => {
    listSnapshots.mockResolvedValue(TURNS);
    snapshotDiff.mockResolvedValue({ diff: "", truncated: false });
    restoreSnapshot.mockResolvedValue({
      restored: ["src/a.ts"],
      deleted: ["src/new.ts"],
      backupCommit: "0123456789abcdef",
    });
    renderTab("t1");
    fireEvent.click(await screen.findByText("回滚到本回合之前"));

    const dialog = await screen.findByRole("dialog", { name: "回滚到本回合之前" });
    expect(dialog.textContent).toContain("将恢复 1 个文件");
    expect(dialog.textContent).toContain("将删除 1 个文件");
    expect(dialog.textContent).toContain("src/a.ts");
    expect(dialog.textContent).toContain("src/new.ts");
    expect(restoreSnapshot).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("确认回滚"));
    await waitFor(() => expect(restoreSnapshot).toHaveBeenCalledWith("agent-1", "t1"));
    expect(await screen.findByText(/已回滚：恢复 1 个文件，删除 1 个文件/)).toBeTruthy();
  });

  it("取消不回滚；回滚失败显示错误", async () => {
    listSnapshots.mockResolvedValue(TURNS);
    snapshotDiff.mockResolvedValue({ diff: "", truncated: false });
    restoreSnapshot.mockRejectedValue(new Error("工作目录上有回合正在执行"));
    renderTab("t1");
    fireEvent.click(await screen.findByText("回滚到本回合之前"));
    fireEvent.click(await screen.findByText("取消"));
    expect(restoreSnapshot).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("回滚到本回合之前"));
    fireEvent.click(await screen.findByText("确认回滚"));
    expect(await screen.findByText(/回滚失败：工作目录上有回合正在执行/)).toBeTruthy();
  });

  it("没有任何带改动的回合时显示空状态", async () => {
    listSnapshots.mockResolvedValue([TURNS[1]!]);
    renderTab();
    expect(await screen.findByText(/还没有带文件改动的回合/)).toBeTruthy();
  });
});
