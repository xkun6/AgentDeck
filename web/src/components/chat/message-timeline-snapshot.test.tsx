import ReactDOMServer from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { SnapshotTurn } from "@agentdeck/protocol";

import { MessageTimeline } from "./message-timeline";
import type { ChatMessage } from "./chat-types";

const render = (node: ReactElement) =>
  ReactDOMServer.renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

const messages: ChatMessage[] = [
  { id: "u1", role: "user", createdAt: 1, status: "complete", text: "改一下" },
  { id: "a1", role: "assistant", createdAt: 2, status: "complete", text: "好的", firstSeq: 3 },
  { id: "u2", role: "user", createdAt: 3, status: "complete", text: "再改" },
  { id: "a2", role: "assistant", createdAt: 4, status: "complete", text: "完成", firstSeq: 8 },
];

function turn(patch: Partial<SnapshotTurn> & Pick<SnapshotTurn, "turnId" | "seq">): SnapshotTurn {
  return { startedAt: 0, before: "b", after: "a", changedFiles: [], ...patch };
}

describe("回合末尾「本回合修改了 N 个文件」小条", () => {
  const turns = [
    turn({
      turnId: "t1",
      seq: 3,
      changedFiles: [
        { path: "a.ts", status: "M" },
        { path: "b.ts", status: "A" },
      ],
    }),
    turn({ turnId: "t2", seq: 8 }),
  ];

  it("只在有文件变化的已结束回合显示", () => {
    const html = render(
      <MessageTimeline messages={messages} snapshotTurns={turns} onOpenSnapshot={vi.fn()} />,
    );
    expect(html).toContain("本回合修改了 2 个文件");
    expect(html.match(/本回合修改了/g)).toHaveLength(1);
  });

  it("进行中的回合（最后一条用户消息之后）不显示", () => {
    const running = [
      turn({ turnId: "t1", seq: 3 }),
      turn({ turnId: "t2", seq: 8, changedFiles: [{ path: "c.ts", status: "M" }] }),
    ];
    const html = render(
      <MessageTimeline
        messages={messages}
        snapshotTurns={running}
        onOpenSnapshot={vi.fn()}
        turnStartedAt={4}
      />,
    );
    expect(html).not.toContain("本回合修改了");
  });

  it("没有快照数据或没有回调时不显示", () => {
    expect(render(<MessageTimeline messages={messages} onOpenSnapshot={vi.fn()} />)).not.toContain(
      "本回合修改了",
    );
    expect(render(<MessageTimeline messages={messages} snapshotTurns={turns} />)).not.toContain(
      "本回合修改了",
    );
  });
});
