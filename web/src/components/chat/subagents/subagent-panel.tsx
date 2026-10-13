// 只读子代理时间线面板（design.md 4.11）：右侧分栏，形态与预览面板相同（拖宽把手 + 头部 + 主体）。
// 参照 paseo packages/app/src/panels/provider-subagent-panel.tsx：复用主时间线渲染（MessageTimeline），
// 无输入框、无审批卡片；顶部「加载更早记录」向前翻页；底部本层级子代理药丸可进入孙代理，头部可返回上一级。
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, X } from "lucide-react";
import type { ProviderSubagentDescriptor, ProviderSubagentTimelineRow } from "@agentdeck/protocol";
import { useSubagentTimeline } from "@/hooks/use-agent-session";
import { createEmptyChatRuntime, reduceAgentEvent, type ChatSessionRuntime } from "@/stores/chat";
import { hermesUIMessagesToChatMessages } from "../message-adapter";
import { MessageTimeline } from "../message-timeline";
import { PanelResizeHandle, usePanelWidth } from "../panel-resize";
import { subagentDotStatus, subagentRowLabel, subagentStatusText } from "./subagent-presentation";
import { SubagentTrack } from "./subagent-track";
import s from "./subagent-panel.module.css";

/** 把子代理时间线行按主时间线规则归约成会话运行时；子代理已结束时把残留的 streaming 消息收尾为 complete。 */
export function buildSubagentRuntime(
  sessionId: string,
  rows: readonly ProviderSubagentTimelineRow[],
  settled: boolean,
): ChatSessionRuntime {
  let runtime = createEmptyChatRuntime(0);
  for (const row of rows) {
    runtime = reduceAgentEvent(
      runtime,
      {
        agentId: sessionId,
        seq: row.seq,
        epoch: "subagent",
        timestamp: row.timestamp,
        event: { type: "timeline", item: row.item },
      },
      row.timestamp,
    );
  }
  if (!settled) return runtime;
  return {
    ...runtime,
    streamStatus: "complete",
    messages: runtime.messages.map((message) =>
      message.status === "streaming" ? { ...message, status: "complete" } : message,
    ),
  };
}

export interface SubagentPanelProps {
  agentId: string;
  /** 该会话全部层级的子代理 */
  subagents: readonly ProviderSubagentDescriptor[];
  /** 从输入框上方药丸打开的子代理 */
  rootSubagentId: string;
  onClose: () => void;
}

export function SubagentPanel({ agentId, subagents, rootSubagentId, onClose }: SubagentPanelProps) {
  // 层级栈：最后一个是当前查看的子代理
  const [stack, setStack] = useState<string[]>([rootSubagentId]);
  useEffect(() => setStack([rootSubagentId]), [rootSubagentId]);
  const currentId = stack[stack.length - 1] ?? rootSubagentId;
  const { width, onResizeStart } = usePanelWidth(460, 360, 840);

  return (
    <aside className={s.panel} aria-label="子代理面板" style={{ width, flexBasis: width }}>
      <PanelResizeHandle ariaLabel="调整子代理面板宽度" onPointerDown={onResizeStart} />
      <SubagentPanelBody
        key={currentId}
        agentId={agentId}
        subagents={subagents}
        subagentId={currentId}
        canGoBack={stack.length > 1}
        onBack={() => setStack((current) => (current.length > 1 ? current.slice(0, -1) : current))}
        onOpenChild={(childId) => setStack((current) => [...current, childId])}
        onClose={onClose}
      />
    </aside>
  );
}

interface SubagentPanelBodyProps {
  agentId: string;
  subagents: readonly ProviderSubagentDescriptor[];
  subagentId: string;
  canGoBack: boolean;
  onBack: () => void;
  onOpenChild: (subagentId: string) => void;
  onClose: () => void;
}

function SubagentPanelBody({
  agentId,
  subagents,
  subagentId,
  canGoBack,
  onBack,
  onOpenChild,
  onClose,
}: SubagentPanelBodyProps) {
  const descriptor = subagents.find((subagent) => subagent.id === subagentId);
  const timeline = useSubagentTimeline(agentId, subagentId);
  const running = descriptor?.status === "running";
  const messages = useMemo(
    () =>
      hermesUIMessagesToChatMessages(
        buildSubagentRuntime(`${agentId}:${subagentId}`, timeline.rows, !running).messages,
      ),
    [agentId, running, subagentId, timeline.rows],
  );
  const title = descriptor?.title?.trim() || "子代理";
  const description = descriptor?.description?.trim();

  return (
    <>
      <header className={s.header}>
        {canGoBack ? (
          <button type="button" className={s.iconButton} onClick={onBack} aria-label="返回上一级">
            <ArrowLeft size={16} aria-hidden="true" />
          </button>
        ) : null}
        <div className={s.heading}>
          <div className={s.titleRow}>
            {descriptor ? (
              <span className={s.dot} data-status={subagentDotStatus(descriptor.status)} aria-hidden="true" />
            ) : null}
            <span className={s.title} title={descriptor ? subagentRowLabel(descriptor) : title}>
              {title}
            </span>
            {descriptor ? <span className={s.status}>{subagentStatusText(descriptor.status)}</span> : null}
          </div>
          {description ? (
            <div className={s.description} title={description}>
              {description}
            </div>
          ) : null}
          {descriptor?.subtitle ? <div className={s.subtitle}>{descriptor.subtitle}</div> : null}
        </div>
        <button type="button" className={s.iconButton} onClick={onClose} aria-label="关闭子代理面板">
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      {timeline.hasOlder ? (
        <div className={s.olderBar}>
          <button
            type="button"
            className={s.olderButton}
            disabled={timeline.loading}
            onClick={() => void timeline.loadOlder()}
          >
            {timeline.loading ? "加载中…" : "加载更早记录"}
          </button>
        </div>
      ) : null}
      {timeline.error ? <div className={s.error}>{timeline.error}</div> : null}
      <div className={s.body} data-testid="subagent-panel-timeline">
        <MessageTimeline
          key={subagentId}
          messages={messages}
          loading={!timeline.loaded && timeline.loading}
          assistantName={title}
          turnStartedAt={running ? descriptor?.createdAt : undefined}
        />
      </div>
      <div className={s.footer}>
        <SubagentTrack subagents={subagents} parentSubagentId={subagentId} onOpen={onOpenChild} />
      </div>
    </>
  );
}
