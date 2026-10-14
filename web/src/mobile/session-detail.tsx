import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import type { AgentPermissionResponse } from "@agentdeck/protocol";
import { ApprovalDialog } from "@/components/chat/approval-dialog";
import { MessageTimeline } from "@/components/chat/message-timeline";
import { agentUIMessagesToChatMessages } from "@/components/chat/message-adapter";
import { agentSnapshotsAtom, sidecarConnectionAtom } from "@/stores/agents";
import { chatRuntimeBySessionAtom, createEmptyChatRuntime, type PendingApproval } from "@/stores/chat";
import { humanizeSidecarError, isInactiveAgent, useAgentSession } from "@/hooks/use-agent-session";
import { isRuntimeRunning } from "@/lib/session-activity";
import { AGENT_STATUS_LABELS, agentDisplayTitle } from "@/lib/agent-session-display";
import { m0Log } from "./m0-log";
import s from "./mobile.module.css";

export function SessionDetail({ agentId, onBack }: { agentId: string; onBack: () => void }) {
  const actions = useAgentSession();
  const connected = useAtomValue(sidecarConnectionAtom) === "open";
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);
  const snapshot = useAtomValue(agentSnapshotsAtom)[agentId];
  const runtime = useMemo(() => runtimeBySession[agentId] ?? createEmptyChatRuntime(), [runtimeBySession, agentId]);
  const chatMessages = useMemo(() => agentUIMessagesToChatMessages(runtime.messages), [runtime.messages]);
  const busy = isRuntimeRunning(runtime) || snapshot?.status === "running";
  const inactive = isInactiveAgent(snapshot);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const openedAt = useRef(performance.now());
  const reportedPaint = useRef(false);

  // 首次打开耗时打点：进入 → timeline 拉取+归约完成 → 首次绘制。
  useEffect(() => {
    openedAt.current = performance.now();
    reportedPaint.current = false;
    m0Log(`open-session agent=${agentId.slice(0, 8)}`);
  }, [agentId]);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    setLoading(true);
    const started = performance.now();
    actions.loadTimeline(agentId).then(
      () => {
        if (cancelled) return;
        m0Log(`timeline-loaded agent=${agentId.slice(0, 8)} took=${Math.round(performance.now() - started)}ms`);
        setLoading(false);
      },
      (e: unknown) => {
        if (cancelled) return;
        setError(humanizeSidecarError(e));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [actions, agentId, connected]);

  useEffect(() => {
    if (reportedPaint.current || loading || runtime.messages.length === 0) return;
    reportedPaint.current = true;
    const count = runtime.messages.length;
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        m0Log(`first-paint agent=${agentId.slice(0, 8)} total=${Math.round(performance.now() - openedAt.current)}ms messages=${count}`),
      ),
    );
  }, [agentId, loading, runtime.messages.length]);

  const onRespond = useCallback(
    (approval: PendingApproval, response: AgentPermissionResponse) =>
      actions.respondPermission(approval.sessionId, approval.requestId, response),
    [actions],
  );

  const send = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setText("");
    setError(null);
    try {
      await actions.sendPrompt(agentId, value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const cancel = () => {
    actions.interrupt(agentId).catch((e: unknown) => setError(humanizeSidecarError(e)));
  };

  const pendingApproval = inactive ? null : runtime.pendingApprovals[0] ?? null;
  const title = snapshot ? agentDisplayTitle(snapshot, runtime) : "会话";

  return (
    <div className={s.page}>
      <header className={s.header}>
        <button type="button" className={s.iconButton} onClick={onBack} aria-label="返回">
          ‹
        </button>
        <h1 className={s.titleSmall}>{title}</h1>
        {snapshot ? <span className={s.conn}>{AGENT_STATUS_LABELS[snapshot.status]}</span> : null}
      </header>
      <div className={s.timeline}>
        <MessageTimeline
          key={agentId}
          messages={chatMessages}
          loading={loading && runtime.messages.length === 0}
          statusMessage={runtime.statusMessage || (!connected ? "正在连接 Agent 服务…" : undefined)}
          pendingApproval={
            pendingApproval ? (
              <ApprovalDialog key={pendingApproval.requestId} approval={pendingApproval} onRespond={onRespond} />
            ) : undefined
          }
          turnStartedAt={busy ? runtime.turnStartedAt : undefined}
          density="compact"
        />
      </div>
      {error ? <div className={s.error}>{error}</div> : null}
      <form
        className={s.inputBar}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          className={s.textarea}
          value={text}
          rows={1}
          placeholder={busy ? "Agent 运行中…" : "给 Agent 发消息"}
          onChange={(event) => setText(event.target.value)}
        />
        {busy ? (
          <button type="button" className={s.dangerButton} onClick={cancel}>
            取消
          </button>
        ) : (
          <button type="submit" className={s.primaryButton} disabled={!text.trim() || !connected}>
            发送
          </button>
        )}
      </form>
    </div>
  );
}
