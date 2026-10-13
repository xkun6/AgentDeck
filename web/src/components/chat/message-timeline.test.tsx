import ReactDOMServer from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { MarkdownText } from "./markdown-renderer";
import {
  MessageTimeline,
  resolveBottomFollowState,
  shouldDetachOnScroll,
  shouldForceBottomOnMessageChange,
} from "./message-timeline";
import type { ChatMessage } from "./chat-types";

// MessageTimeline 内部的资料卡用到 useNavigate，SSR 渲染需要 Router 上下文。
const renderTimeline = (node: ReactElement) =>
  ReactDOMServer.renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

describe("MessageTimeline", () => {
  it("keeps bottom auto-follow disabled after an explicit upward scroll", () => {
    expect(resolveBottomFollowState(40, true)).toEqual({
      nearBottom: false,
      userDetachedFromBottom: true,
    });
  });

  it("reattaches bottom auto-follow only after returning to the bottom", () => {
    expect(resolveBottomFollowState(8, true)).toEqual({
      nearBottom: true,
      userDetachedFromBottom: false,
    });
  });

  it("treats a genuine user upward scroll as a bottom-detach gesture", () => {
    expect(shouldDetachOnScroll(800, 1000, false)).toBe(true);
  });

  it("does not detach while a programmatic turn jump animates upward", () => {
    // The smooth scrollTo from scrollToTurn drives scrollTop down too; without the
    // guard handleScroll would cancel its own jump. This locks in the fix.
    expect(shouldDetachOnScroll(800, 1000, true)).toBe(false);
  });

  it("does not detach when scrolling downward", () => {
    expect(shouldDetachOnScroll(1000, 800, false)).toBe(false);
  });

  it("forces bottom positioning when history first loads or the session changes", () => {
    expect(shouldForceBottomOnMessageChange(0, 8, false, undefined, "user-4")).toBe(true);
    expect(shouldForceBottomOnMessageChange(8, 6, true, "user-4", "user-3")).toBe(true);
  });

  it("forces bottom positioning for a newly appended user message", () => {
    expect(shouldForceBottomOnMessageChange(8, 10, false, "user-4", "user-5")).toBe(true);
  });

  it("keeps an upward-scrolled user detached for assistant-only updates", () => {
    expect(shouldForceBottomOnMessageChange(8, 9, false, "user-4", "user-4")).toBe(false);
  });

  it("uses the optimistic progress model instead of stale session usage", () => {
    const messages: ChatMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        createdAt: 1,
        status: "streaming",
        blocks: [{ type: "progress", text: "正在唤醒AgentDeck..." }],
      },
    ];

    const html = renderTimeline(
      <MessageTimeline
        messages={messages}
        turnStartedAt={1}
        sessionUsage={{ model: "deepseek-v4-flash" } as any}
        progressModel="qwen3.6-plus"
      />,
    );

    expect(html).toContain("qwen3.6-plus");
    expect(html).not.toContain("deepseek-v4-flash");
  });

  it("shows live context tokens instead of cumulative session totals", () => {
    const messages: ChatMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        createdAt: 1,
        status: "streaming",
        blocks: [{ type: "progress", text: "正在分析项目..." }],
      },
    ];

    const html = renderTimeline(
      <MessageTimeline
        messages={messages}
        turnStartedAt={1}
        sessionUsage={{
          model: "deepseek-v4-flash",
          total: 1_033_698,
          input: 1_027_212,
          output: 6_486,
          context_used: 87_382,
        } as any}
      />,
    );

    expect(html).toContain("87.4k tokens");
    expect(html).not.toContain("1.0M tokens");
  });


  it("命令输出消息原样显示：保留换行、不走 Markdown，带「命令输出」标签", () => {
    const messages: ChatMessage[] = [
      {
        id: "assistant-cmd",
        role: "assistant",
        createdAt: 1,
        status: "complete",
        blocks: [{ type: "text", text: "**用量**\n第二行", source: "command" }],
      },
    ];
    const html = renderTimeline(<MessageTimeline messages={messages} />);
    expect(html).toContain("命令输出");
    expect(html).toContain("<pre");
    expect(html).toContain("**用量**\n第二行");
    expect(html).not.toContain("<strong>");
  });

  it("renders Obsidian deep links without the blocked indicator", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text="[Twitter 时间线](obsidian://open?vault=AgentDeck&file=Twitter%20%E6%97%B6%E9%97%B4%E7%BA%BF)" />,
    );

    expect(html).toContain("href=\"obsidian://open?vault=AgentDeck&amp;file=Twitter%20%E6%97%B6%E9%97%B4%E7%BA%BF\"");
    expect(html).toContain("Twitter 时间线");
    expect(html).not.toContain("[blocked]");
  });



  it("renders footnote anchors as in-page links", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text={"正文引用[^1]\n\n[^1]: 这里是脚注内容"} />,
    );

    expect(html).toContain('href="#user-content-fn-1"');
    expect(html).toContain('href="#user-content-fnref-1"');
    expect(html).toContain("这里是脚注内容");
    expect(html).not.toContain('target="_blank"');
  });

  it("keeps safe relative Markdown links renderable", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text="[内部帮助](/about)" />,
    );

    expect(html).toContain("href=\"/about\"");
    expect(html).toContain("内部帮助");
  });

  it("renders controlled rich inline Markdown formatting", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text={'<small style="font-size: 12px; color: #999">06 月 07 日 05:30</small> · <span data-tone="muted" data-size="small">浏览 152</span>'} />,
    );

    expect(html).toContain("06 月 07 日 05:30");
    expect(html).toContain("浏览 152");
    expect(html).toContain("font-size:12px");
    expect(html).toContain("color:#999");
  });

  it("drops unsafe inline styles from rich formatting tags", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text={'<span style="background-image: url(javascript:alert(1)); font-size: 200px">日期</span>'} />,
    );

    expect(html).toContain("日期");
    expect(html).not.toContain("javascript");
    expect(html).not.toContain("background-image");
    expect(html).not.toContain("200px");
  });


  it("renders a copy button on fenced code blocks", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text={"```ts\nconst value = 1;\n```"} />,
    );

    expect(html).toContain('data-streamdown="code-block-copy-button"');
    expect(html).toContain('title="复制代码"');
  });

  it("does not render code block controls for inline code", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text={"行内 `code` 不需要复制按钮"} />,
    );

    expect(html).not.toContain('data-streamdown="code-block-copy-button"');
  });

  it("routes Mermaid fences away from the plain code block renderer", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text={"```mermaid\ngraph TD\n  A[开始] --> B{条件判断}\n  B -->|是| C[处理]\n```"} />,
    );

    expect(html).not.toContain('data-language="mermaid"');
    expect(html).not.toContain('data-streamdown="code-block"');
  });

  it("renders Markdown image syntax as an image preview", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text="结果图：![趋势图](https://example.test/chart.png)" />,
    );

    expect(html).toContain("https://example.test/chart.png");
    expect(html).toContain("alt=\"趋势图\"");
  });

  it("routes a Windows local-path Markdown image to the local preview instead of blocking it", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText
        text={"模型生成图片：![生成图](D:\\AgentDeck\\e2e\\.runtime\\agentdeck-home\\images\\generated previews\\model output.png)"}
      />,
    );

    // rehype-harden must not swallow the drive-letter path as a blocked image.
    expect(html).not.toContain("[Image blocked");
    // It must reach MessageImage's local-path handling (async media fetch →
    // loading placeholder in SSR), with the POSIX-style drive path mapped back.
    expect(html).toContain("图片加载中");
    expect(html).toContain("generated%20previews");
    expect(html).toContain("/D:/AgentDeck/e2e/.runtime/agentdeck-home/images");
  });

  it("renders single-dollar inline LaTeX formulas", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text={String.raw`设 $\boldsymbol{v}_i \in \mathbb{R}^n$ 且 $A\boldsymbol{v}_i = \boldsymbol{0}$。`} />,
    );

    expect(html).toContain("katex");
    expect(html).toContain('class="katex"');
    expect(html).toContain("style=\"height:");
    expect(html).not.toContain("_richInline");
    expect(html).not.toContain("$\\boldsymbol");
  });

  it("renders TeX parenthesis and bracket math delimiters", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText
        text={String.raw`两个球体 \(S_1(c_1,r_1)\) 和 \(S_2(c_2,r_2)\) 的条件：\[\|\mathbf{c}_1-\mathbf{c}_2\|\le r_1+r_2\]`}
      />,
    );

    expect(html).toContain("katex");
    expect(html).toContain("katex-display");
    expect(html).not.toContain("\\(");
    expect(html).not.toContain("\\[");
  });

  it("does not normalize TeX delimiters inside code", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MarkdownText text={"代码 `\\(x_1\\)` 保持字面量。"} />,
    );

    expect(html).toContain("\\(x_1\\)");
  });

  it("starts resolving local image URLs through the gateway media endpoint", () => {
    const messages: ChatMessage[] = [
      {
        id: "user-image",
        role: "user",
        createdAt: 1,
        images: [{ url: "/Users/enzo/Downloads/chart.png", alt: "chart.png", name: "chart.png" }],
      },
    ];

    const html = renderTimeline(
      <MessageTimeline messages={messages} />,
    );

    expect(html).toContain("图片加载中");
    expect(html).toContain("chart.png");
    expect(html).toContain("/Users/enzo/Downloads/chart.png");
  });

  it("shows turn navigation for multi-turn conversations", () => {
    const messages: ChatMessage[] = [
      { id: "user-1", role: "user", createdAt: 1, text: "第一轮问题" },
      { id: "assistant-1", role: "assistant", createdAt: 2, text: "第一轮回答" },
      { id: "user-2", role: "user", createdAt: 3, text: "第二轮追问" },
      { id: "assistant-2", role: "assistant", createdAt: 4, text: "第二轮回答" },
    ];

    const html = renderTimeline(
      <MessageTimeline messages={messages} />,
    );

    expect(html).toContain("aria-label=\"对话轮次定位\"");
    expect(html).toContain("aria-label=\"定位到第 1 轮对话\"");
    expect(html).toContain("aria-label=\"定位到第 2 轮对话\"");
    expect(html).not.toContain("aria-label=\"定位到第 3 轮对话\"");
    expect(html.match(/data-turn-anchor=\"true\"/g)).toHaveLength(2);
  });

  it("does not show turn navigation for a single user turn", () => {
    const messages: ChatMessage[] = [
      { id: "user-1", role: "user", createdAt: 1, text: "只有一轮" },
      { id: "assistant-1", role: "assistant", createdAt: 2, text: "回答" },
    ];

    const html = renderTimeline(
      <MessageTimeline messages={messages} />,
    );

    expect(html).not.toContain("对话轮次定位");
  });
  it("falls back to session usage stats for the latest completed assistant message", () => {
    const messages: ChatMessage[] = [
      { id: "user-1", role: "user", createdAt: 1, text: "问题" },
      { id: "assistant-1", role: "assistant", createdAt: 2, status: "complete", text: "回答" },
    ];

    const html = renderTimeline(
      <MessageTimeline
        messages={messages}
        sessionUsage={{
          model: "deepseek-v4-flash",
          input: 900,
          output: 300,
          total: 1200,
          cache_read: 100,
          calls: 1,
        } as any}
      />,
    );

    expect(html).toContain("1.2k");
    expect(html).toContain('title="详细统计"');
  });

  it("shows the host-provided assistant name and its initial when no avatar is set", () => {
    const messages: ChatMessage[] = [
      { id: "user-1", role: "user", createdAt: 1, text: "问题" },
      { id: "assistant-1", role: "assistant", createdAt: 2, status: "complete", text: "回答" },
    ];

    const html = renderTimeline(
      <MessageTimeline messages={messages} assistantName="Claude Code" />,
    );

    expect(html).toContain("<span>Claude Code</span>");
    expect(html).toContain("aria-label=\"Claude Code 头像\">C</span>");
  });

  it("紧凑密度：根元素带 data-density，不渲染头像列、助手名与轮次导航；默认密度不受影响", () => {
    const messages: ChatMessage[] = [
      { id: "user-1", role: "user", createdAt: 1, text: "第一轮问题" },
      { id: "assistant-1", role: "assistant", createdAt: 2, status: "complete", text: "第一轮回答" },
      { id: "user-2", role: "user", createdAt: 3, text: "第二轮追问" },
      { id: "assistant-2", role: "assistant", createdAt: 4, status: "complete", text: "第二轮回答" },
    ];

    const compact = renderTimeline(
      <MessageTimeline messages={messages} assistantName="Explore" density="compact" />,
    );
    expect(compact).toMatch(/^<div[^>]*role="log"[^>]*>/);
    expect(compact).toMatch(/^<div[^>]*data-density="compact"/);
    expect(compact).not.toContain("Explore 头像");
    expect(compact).not.toContain("查看 Explore 资料");
    expect(compact).not.toContain("<span>Explore</span>");
    expect(compact).not.toContain("对话轮次定位");
    expect(compact).toContain("第二轮回答");

    const normal = renderTimeline(<MessageTimeline messages={messages} assistantName="Explore" />);
    expect(normal).not.toContain("data-density");
    expect(normal).toContain("aria-label=\"Explore 头像\"");
    expect(normal).toContain("<span>Explore</span>");
    expect(normal).toContain("对话轮次定位");
  });
});

describe("MessageTimeline：上下文压缩提示（design.md 4.13）", () => {
  it("agent-compaction-* 系统消息渲染为居中分隔线，不用告警框", () => {
    const messages: ChatMessage[] = [
      { id: "agent-compaction-c1", role: "system", createdAt: 1, text: "上下文已自动压缩", status: "complete" },
      { id: "agent-notice-2", role: "system", createdAt: 2, text: "已中断本轮", status: "complete" },
    ];
    const html = renderTimeline(<MessageTimeline messages={messages} />);
    expect(html).toMatch(/class="[^"]*dividerNotice[^"]*" role="status"><span[^>]*>上下文已自动压缩<\/span>/);
    // 普通系统提示仍是告警框
    expect(html).toContain("已中断本轮");
    expect(html.match(/systemNotice(?!Icon|Body|Text|Title|Toggle)/g) ?? []).toHaveLength(1);
  });
});

describe("MessageTimeline：分叉相关（design.md 4.23）", () => {
  it("agent-timeline-notice-* 系统提示渲染为居中分隔线", () => {
    const messages: ChatMessage[] = [
      { id: "agent-timeline-notice-9", role: "system", createdAt: 1, text: "已从「原会话」分叉", status: "complete" },
    ];
    const html = renderTimeline(<MessageTimeline messages={messages} />);
    expect(html).toMatch(/class="[^"]*dividerNotice[^"]*" role="status"><span[^>]*>已从「原会话」分叉<\/span>/);
    expect(html).not.toMatch(/systemNotice(?!Icon|Body|Text|Title|Toggle)/);
  });

  it("有 firstSeq 的消息显示「从这里分叉」；进行中的回合（最后一条用户消息起）不显示", () => {
    const messages = [
      { id: "u1", role: "user", text: "第一问", createdAt: 1, firstSeq: 1 },
      { id: "a1", role: "assistant", text: "答", createdAt: 2, firstSeq: 3, status: "complete" },
      { id: "u2", role: "user", text: "第二问", createdAt: 3, firstSeq: 5 },
      { id: "a2", role: "assistant", text: "答二", createdAt: 4, status: "complete" },
      { id: "u3", role: "user", text: "没有 seq", createdAt: 5 },
    ] as ChatMessage[];
    const idle = renderTimeline(<MessageTimeline messages={messages} onFork={() => {}} />);
    expect(idle.match(/从这里分叉/g)).toHaveLength(3);
    const noHandler = renderTimeline(<MessageTimeline messages={messages} />);
    expect(noHandler).not.toContain("从这里分叉");
    // 正在运行：u3 起的回合未结束，只剩前两个回合的三条消息里 u2 仍可分叉（a2 没有 seq）
    const busy = renderTimeline(<MessageTimeline messages={messages} onFork={() => {}} turnStartedAt={1} />);
    expect(busy.match(/从这里分叉/g)).toHaveLength(3);
    const busyLast = renderTimeline(
      <MessageTimeline messages={messages.slice(0, 3)} onFork={() => {}} turnStartedAt={1} />,
    );
    // u2 是最后一条用户消息，其回合进行中：只有 u1、a1 可分叉
    expect(busyLast.match(/从这里分叉/g)).toHaveLength(2);
  });
});

describe("MessageTimeline 撤回操作（design.md 4.16）", () => {
  const messages: ChatMessage[] = [
    { id: "u1", role: "user", text: "你好", createdAt: 1 },
    { id: "u2", role: "user", text: "再问", createdAt: 2 },
  ] as ChatMessage[];

  it("仅在 retractMessageId 对应的用户消息上显示撤回", () => {
    const html = renderTimeline(
      <MessageTimeline messages={messages} retractMessageId="u2" onRetract={() => {}} />,
    );
    expect(html.match(/撤回/g)).toHaveLength(1);
    const without = renderTimeline(<MessageTimeline messages={messages} onRetract={() => {}} />);
    expect(without).not.toContain("撤回");
  });

  it("retractDisabled 时按钮禁用", () => {
    const html = renderTimeline(
      <MessageTimeline messages={messages} retractMessageId="u2" onRetract={() => {}} retractDisabled />,
    );
    expect(html).toMatch(/<button[^>]*disabled[^>]*>.*撤回/);
  });
});

describe("MessageTimeline 插话与重试（design.md 4.21 / 4.22）", () => {
  const user: ChatMessage = { id: "u1", role: "user", createdAt: 1, text: "做事", status: "complete" };
  const notice: ChatMessage = {
    id: "n1",
    role: "system",
    createdAt: 2,
    text: "已中断本轮",
    status: "complete",
    retryUserMessageId: "u1",
  };

  it("steer 块渲染为带「插话」标注的内联气泡", () => {
    const html = renderTimeline(
      <MessageTimeline
        messages={[
          user,
          {
            id: "a1",
            role: "assistant",
            createdAt: 2,
            status: "complete",
            blocks: [
              { type: "text", text: "开始" },
              { type: "steer", text: "顺便做 B" },
            ],
          },
        ]}
      />,
    );
    expect(html).toContain("steer-bubble");
    expect(html).toContain("插话");
    expect(html).toContain("顺便做 B");
  });

  it("retryNoticeId 命中的提示显示「重试」，最后一条用户消息显示「再次发送」并带提示", () => {
    const html = renderTimeline(
      <MessageTimeline
        messages={[user, notice]}
        retryNoticeId="n1"
        onRetry={() => undefined}
        resendMessageId="u1"
        resendHint="图片未保存，仅重发文字"
        onResend={() => undefined}
      />,
    );
    expect(html).toContain("重试");
    expect(html).toContain("再次发送");
    expect(html).toContain("图片未保存，仅重发文字");
  });

  it("没有传 retryNoticeId / resendMessageId 时不出现这两个按钮", () => {
    const html = renderTimeline(<MessageTimeline messages={[user, notice]} />);
    expect(html).not.toContain("重试");
    expect(html).not.toContain("再次发送");
  });
});
