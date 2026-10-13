// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Provider as JotaiProvider, createStore } from "jotai";
import type { UsageSummary } from "@agentdeck/protocol";
import { sidecarConnectionAtom } from "@/stores/agents";

const usageSummary = vi.fn<(range?: { sinceMs?: number }) => Promise<UsageSummary>>();
vi.mock("@/hooks/use-agent-session", () => ({
  useAgentSession: () => ({ usageSummary }),
  humanizeSidecarError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import { UsageRoute } from "./usage";

afterEach(() => {
  cleanup();
  usageSummary.mockReset();
});

function summary(patch: Partial<UsageSummary> = {}): UsageSummary {
  return {
    backfilling: false,
    totals: { turns: 12, failedTurns: 2, inputTokens: 120_000, cachedInputTokens: 50_000, outputTokens: 8_000, costUsd: 1.5 },
    byDay: [
      { day: "2026-06-14", inputTokens: 100, outputTokens: 20, cachedInputTokens: 30, costUsd: 0.1, turns: 2 },
    ],
    byProvider: [
      { provider: "claude", label: "Claude Code", inputTokens: 90_000, outputTokens: 6_000, costUsd: 1, turns: 8 },
      { provider: "codex", label: "Codex", inputTokens: 30_000, outputTokens: 2_000, costUsd: 0.5, turns: 4 },
    ],
    byModel: [{ provider: "claude", model: null, inputTokens: 90_000, outputTokens: 6_000, costUsd: 1, turns: 8 }],
    topAgents: [
      { agentId: "alive", title: "活着的会话", provider: "claude", inputTokens: 5_000, outputTokens: 500, costUsd: 0.2, turns: 3, deleted: false },
      { agentId: "gone", title: null, provider: "codex", inputTokens: 4_000, outputTokens: 400, costUsd: 0.1, turns: 2, deleted: true },
    ],
    perf: { ttftP50Ms: 800, ttftP95Ms: 2500, durationP50Ms: 12_000, durationP95Ms: 90_000, outputTokensPerSecP50: 42.5 },
    ...patch,
  };
}

function renderPage() {
  const store = createStore();
  store.set(sidecarConnectionAtom, "open");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <JotaiProvider store={store}>
        <MemoryRouter initialEntries={["/usage"]}>
          <Routes>
            <Route path="/usage" element={<UsageRoute />} />
            <Route path="/tasks/:taskId" element={<div>详情页</div>} />
          </Routes>
        </MemoryRouter>
      </JotaiProvider>
    </QueryClientProvider>,
  );
}

describe("UsageRoute", () => {
  it("渲染总量、占比、高用量会话与性能指标，已删除的会话不可点", async () => {
    usageSummary.mockResolvedValue(summary());
    renderPage();
    expect(await screen.findByText("回合数")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("失败 2")).toBeTruthy();
    expect(screen.getByText("120k")).toBeTruthy();
    expect(screen.getByText("$1.50")).toBeTruthy();
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("默认模型 · claude")).toBeTruthy();
    expect(screen.getByText("800ms")).toBeTruthy();
    expect(screen.getByText("42.5 tok/s")).toBeTruthy();

    expect(screen.getByText("（已删除的会话）").closest("button")).toBeNull();
    fireEvent.click(screen.getByText("活着的会话"));
    expect(await screen.findByText("详情页")).toBeTruthy();
  });

  it("默认 30 天；切换范围重新请求（全部 sinceMs=0）", async () => {
    usageSummary.mockResolvedValue(summary());
    renderPage();
    await screen.findByText("回合数");
    const first = usageSummary.mock.calls[0]![0]!.sinceMs!;
    expect(first).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("tab", { name: "全部" }));
    await waitFor(() => expect(usageSummary).toHaveBeenLastCalledWith({ sinceMs: 0 }));
  });

  it("backfilling 时顶部提示正在统计历史会话", async () => {
    usageSummary.mockResolvedValue(summary({ backfilling: true }));
    renderPage();
    expect(await screen.findByText("正在统计历史会话…")).toBeTruthy();
  });

  it("没有记录时显示空状态", async () => {
    usageSummary.mockResolvedValue(
      summary({ totals: { turns: 0, failedTurns: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 } }),
    );
    renderPage();
    expect(await screen.findByText("所选时间范围内暂无用量记录")).toBeTruthy();
  });

  it("请求失败时显示错误", async () => {
    usageSummary.mockRejectedValue(new Error("sidecar 炸了"));
    renderPage();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("sidecar 炸了")).toBeTruthy();
  });
});
