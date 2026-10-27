// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider as JotaiProvider, createStore } from "jotai";
import { MemoryRouter, useLocation, useSearchParams } from "react-router-dom";

vi.mock("@/lib/use-confirm", () => ({ useConfirm: () => ({ confirm: async () => true }) }));
vi.mock("./web-preview-tab", () => ({ WebPreviewTab: () => null }));
vi.mock("./file-preview-tab", () => ({ FilePreviewTab: () => <div>files-tab</div> }));
vi.mock("./review-tab", () => ({ ReviewTab: () => null }));
vi.mock("./terminal-tab", () => ({ TerminalTab: () => null }));
vi.mock("./snapshots-tab", () => ({
  SnapshotsTab: ({ selectedTurnId }: { selectedTurnId: string | null }) => <div>snapshots-tab:{selectedTurnId}</div>,
}));

import { PreviewRail } from "./preview-rail";

afterEach(cleanup);

/** 模拟 detail.tsx 的 openSnapshotPanel：同一次点击里打开右栏并写入 ?panel=snapshots&snapshotTurn= */
function Harness() {
  const [visible, setVisible] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setVisible(true);
          const next = new URLSearchParams(searchParams);
          next.set("panel", "snapshots");
          next.set("snapshotTurn", "t1");
          setSearchParams(next, { replace: true });
        }}
      >
        open
      </button>
      <output data-testid="search">{location.search}</output>
      {visible ? <PreviewRail sessionId="s1" workspaceRoot="" onClose={() => setVisible(false)} /> : null}
    </>
  );
}

describe("PreviewRail 首次打开", () => {
  it("右栏关闭时从小条打开快照面板，不会被默认的「文件」页覆盖", async () => {
    render(
      <JotaiProvider store={createStore()}>
        <MemoryRouter initialEntries={["/tasks/s1"]}>
          <Harness />
        </MemoryRouter>
      </JotaiProvider>,
    );
    fireEvent.click(screen.getByText("open"));
    await waitFor(() => expect(screen.getByText("snapshots-tab:t1")).toBeTruthy());
    // 等可能的 effect 写回 URL 后再确认
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId("search").textContent).toBe("?panel=snapshots&snapshotTurn=t1");
    expect(screen.queryByText("files-tab")).toBeNull();
  });
});
