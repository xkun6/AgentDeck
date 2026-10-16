// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AgentBackgroundTask, AgentRateLimits, ProviderSubagentDescriptor } from "@agentdeck/protocol";

vi.mock("@/hooks/use-agent-session", () => ({
  useAgentSession: () => ({ stopBackgroundTask: vi.fn() }),
  humanizeSidecarError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

const { ComposerStatusRow } = await import("./composer-status-row");
const { RateLimitTrack } = await import("./rate-limit-track");
const { TodoTrack } = await import("./todo-track");
const { OutputSpeedChip } = await import("./output-speed-chip");

afterEach(cleanup);

const subagent = (id: string): ProviderSubagentDescriptor =>
  ({
    id,
    provider: "claude",
    parentSubagentId: null,
    title: `子代理 ${id}`,
    status: "running",
    createdAt: 1,
  }) as unknown as ProviderSubagentDescriptor;

const task = (taskId: string): AgentBackgroundTask => ({
  taskId,
  kind: "command",
  description: `任务 ${taskId}`,
  status: "running",
  startedAt: 1_000_000,
});

const baseProps = {
  agentId: "a1",
  subagents: [] as ProviderSubagentDescriptor[],
  openSubagentId: null,
  onOpenSubagent: vi.fn(),
  backgroundTasks: [] as AgentBackgroundTask[],
  openTaskId: null,
  onOpenTask: vi.fn(),
  todos: undefined,
  busy: false,
  rateLimits: undefined,
  usage: undefined,
};

const limits: AgentRateLimits = {
  windows: [
    { id: "five_hour", label: "5 小时", usedPercent: 3, resetsAt: new Date(2026, 9, 14, 18, 0).getTime() },
    { id: "seven_day", label: "7 天", usedPercent: 96, resetsAt: new Date(2026, 9, 20, 9, 5).getTime() },
  ],
  status: "warning",
  updatedAt: new Date(2026, 9, 14, 8, 7).getTime(),
};

describe("ComposerStatusRow 同一行布局与隐藏规则", () => {
  it("整行都没有内容时不渲染（不占高度）", () => {
    const { container } = render(<ComposerStatusRow {...baseProps} />);
    expect(container.innerHTML).toBe("");
  });

  it("子代理、后台任务、步骤、额度、速度在同一个行容器里，按顺序排列", () => {
    render(
      <ComposerStatusRow
        {...baseProps}
        subagents={[subagent("s1")]}
        backgroundTasks={[task("t1")]}
        todos={[{ text: "写代码", completed: false }]}
        busy
        rateLimits={limits}
        usage={{ outputTokensPerSecond: 42.5 }}
      />,
    );
    const row = screen.getByTestId("composer-status-row");
    const sub = screen.getByRole("button", { name: /子代理/ });
    const bg = screen.getByRole("button", { name: /后台任务/ });
    const todo = screen.getByRole("button", { name: /步骤/ });
    const quota = screen.getByRole("button", { name: /额度/ });
    const speed = screen.getByText("43 tok/s");
    for (const node of [sub, bg, todo, quota, speed]) expect(row.contains(node)).toBe(true);
    const order = [sub, bg, todo, quota, speed].map((node) => {
      let rootChild: HTMLElement = node;
      while (rootChild.parentElement && rootChild.parentElement !== row) rootChild = rootChild.parentElement;
      return Array.from(row.children).indexOf(rootChild);
    });
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(5);
  });

  it("各芯片没有内容时隐藏：只有额度时只出现额度芯片", () => {
    render(<ComposerStatusRow {...baseProps} rateLimits={limits} />);
    expect(screen.queryByRole("button", { name: /子代理/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /后台任务/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /步骤/ })).toBeNull();
    expect(screen.getByRole("button", { name: /额度/ })).toBeTruthy();
    expect(screen.queryByText(/tok\/s/)).toBeNull();
  });

  it("空 todo 列表与没有速度值都算没有内容", () => {
    const { container } = render(<ComposerStatusRow {...baseProps} todos={[]} usage={{ inputTokens: 5 }} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("步骤芯片", () => {
  const items = [
    { text: "读代码", completed: true },
    { text: "写实现", completed: false },
    { text: "跑测试", completed: false },
  ];

  it("显示「步骤 已完成/总数」，点开列出每步状态；回合中第一条未完成项为进行中，已完成项带状态标记", () => {
    render(<TodoTrack items={items} busy />);
    const chip = screen.getByRole("button", { name: /步骤/ });
    expect(chip.textContent).toContain("1/3");
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(chip);
    const rows = screen.getByRole("list", { name: "步骤列表" }).querySelectorAll("li");
    expect(Array.from(rows).map((row) => row.getAttribute("data-status"))).toEqual([
      "completed",
      "in_progress",
      "pending",
    ]);
    expect(rows[1]?.textContent).toBe("写实现");
    fireEvent.click(chip);
    expect(screen.queryByRole("list", { name: "步骤列表" })).toBeNull();
  });

  it("空闲时没有进行中项；全部完成显示「N/N ✓」完成态", () => {
    const { rerender } = render(<TodoTrack items={items} busy={false} />);
    fireEvent.click(screen.getByRole("button", { name: /步骤/ }));
    expect(
      Array.from(screen.getByRole("list", { name: "步骤列表" }).querySelectorAll("li")).map((row) =>
        row.getAttribute("data-status"),
      ),
    ).toEqual(["completed", "pending", "pending"]);
    rerender(<TodoTrack items={items.map((item) => ({ ...item, completed: true }))} busy />);
    const chip = screen.getByRole("button", { name: /步骤/ });
    expect(chip.textContent).toContain("3/3 ✓");
    expect(chip.getAttribute("data-tone")).toBe("done");
  });

  it("没有 todo 项时不渲染", () => {
    expect(render(<TodoTrack items={undefined} busy />).container.innerHTML).toBe("");
    expect(render(<TodoTrack items={[]} busy />).container.innerHTML).toBe("");
  });
});

describe("额度芯片", () => {
  const now = new Date(2026, 9, 14, 8, 30).getTime();

  it("芯片文字「额度 5h 3% · 7d 96%」，≥ 80% 用警告色；弹层每窗口一行：标签、进度条、已用 N%、重置时间，底部更新时间", () => {
    render(<RateLimitTrack rateLimits={limits} now={now} />);
    const chip = screen.getByRole("button", { name: /额度/ });
    expect(chip.textContent).toContain("额度");
    expect(chip.textContent).toContain("5h 3% · 7d 96%");
    expect(chip.getAttribute("data-tone")).toBe("warn");
    fireEvent.click(chip);
    const panel = screen.getByLabelText("额度详情");
    expect(panel.textContent).toContain("5 小时");
    expect(panel.textContent).toContain("已用 3%");
    expect(panel.textContent).toContain("18:00 重置");
    expect(panel.textContent).toContain("7 天");
    expect(panel.textContent).toContain("已用 96%");
    expect(panel.textContent).toContain("10月20日 09:05 重置");
    expect(panel.textContent).toContain("更新于 08:07");
    const fills = panel.querySelectorAll<HTMLElement>("[style]");
    expect(Array.from(fills).map((el) => el.style.width)).toEqual(["3%", "96%"]);
  });

  it("全部低于 80% 为正常色；rejected 为危险色并显示「额度已用尽」", () => {
    const normal: AgentRateLimits = { ...limits, windows: [{ id: "five_hour", label: "5 小时", usedPercent: 10 }], status: "allowed" };
    const { rerender } = render(<RateLimitTrack rateLimits={normal} now={now} />);
    expect(screen.getByRole("button", { name: /额度/ }).getAttribute("data-tone")).toBe("normal");
    rerender(<RateLimitTrack rateLimits={{ ...normal, status: "rejected" }} now={now} />);
    const chip = screen.getByRole("button", { name: /额度/ });
    expect(chip.getAttribute("data-tone")).toBe("err");
    expect(chip.textContent).toContain("额度已用尽");
  });

  it("没有 rateLimits 时隐藏", () => {
    expect(render(<RateLimitTrack rateLimits={undefined} />).container.innerHTML).toBe("");
    expect(render(<RateLimitTrack rateLimits={{ windows: [], updatedAt: 1 }} />).container.innerHTML).toBe("");
  });
});

describe("速度芯片", () => {
  it("回合中显示实时值；空闲时弱化并提示上一回合平均输出速度", () => {
    const { rerender } = render(<OutputSpeedChip usage={{ outputTokensPerSecond: 123.4 }} busy />);
    const live = screen.getByText("123 tok/s").closest("span[title]")!;
    expect(live.getAttribute("data-idle")).toBeNull();
    expect(live.getAttribute("title")).toBe("当前输出速度");
    rerender(<OutputSpeedChip usage={{ outputTokensPerSecond: 42.46 }} busy={false} />);
    const idle = screen.getByText("42 tok/s").closest("span[title]")!;
    expect(idle.getAttribute("data-idle")).toBe("true");
    expect(idle.getAttribute("title")).toBe("上一回合平均输出速度");
  });

  it("没有值时隐藏", () => {
    expect(render(<OutputSpeedChip usage={undefined} busy />).container.innerHTML).toBe("");
  });
});
