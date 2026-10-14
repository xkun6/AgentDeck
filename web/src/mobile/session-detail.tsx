// 会话详情：窗口化的时间线（打开取最近 300 条，滚到顶部向前分页）、审批 / 提问、状态行、输入区。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import type { AgentPermissionResponse } from "@agentdeck/protocol";
import { ApprovalDialog } from "@/components/chat/approval-dialog";
import { MessageTimeline } from "@/components/chat/message-timeline";
import { agentUIMessagesToChatMessages } from "@/components/chat/message-adapter";
import { ComposerStatusRow } from "@/components/chat/status-row/composer-status-row";
import { agentSnapshotsAtom, sidecarConnectionAtom } from "@/stores/agents";
import {
  chatRuntimeBySessionAtom,
  createEmptyChatRuntime,
  retractableUserMessageId,
  type PendingApproval,
} from "@/stores/chat";
import { humanizeSidecarError, isInactiveAgent, useAgentSession } from "@/hooks/use-agent-session";
import { useAgentProviders } from "@/hooks/use-agent-catalog";
import { useRetractMessage } from "@/hooks/use-retract-message";
import { isRuntimeRunning } from "@/lib/session-activity";
import { prepareAgentPrompt } from "@/lib/agent-prompt";
import { AGENT_STATUS_LABELS, agentDisplayTitle } from "@/lib/agent-session-display";
import { MobileComposer } from "./composer";
import { addImages, compressImage, describeImageSendFailure, imagesToAttachments, type DraftImage } from "./image-attachments";
import s from "./mobile.module.css";

/** 首屏只渲染最近这么多条消息（手机 WebView 全量渲染长会话首开要数秒、流式只有约 3fps），更早的按需展开 / 向前分页 */
export const INITIAL_WINDOW = 60;
export const WINDOW_STEP = 100;
export const OLDER_PAGE_LIMIT = 300;

export function SessionDetail({
  agentId,
  onBack,
  compress = compressImage,
}: {
  agentId: string;
  onBack: () => void;
  /** 图片压缩实现，测试注入 */
  compress?: (file: File) => Promise<DraftImage>;
}) {
  const actions = useAgentSession();
  const connected = useAtomValue(sidecarConnectionAtom) === "open";
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);
  const snapshot = useAtomValue(agentSnapshotsAtom)[agentId];
  const providers = useAgentProviders().data ?? null;
  const runtime = useMemo(() => runtimeBySession[agentId] ?? createEmptyChatRuntime(), [runtimeBySession, agentId]);
  const allMessages = useMemo(() => agentUIMessagesToChatMessages(runtime.messages), [runtime.messages]);
  const [windowSize, setWindowSize] = useState(INITIAL_WINDOW);
  const hidden = Math.max(0, allMessages.length - windowSize);
  const chatMessages = useMemo(
    () => (hidden > 0 ? allMessages.slice(-windowSize) : allMessages),
    [allMessages, hidden, windowSize],
  );
  const busy = isRuntimeRunning(runtime) || snapshot?.status === "running";
  const inactive = isInactiveAgent(snapshot);
  const steerSupported =
    providers?.find((provider) => provider.id === snapshot?.provider)?.capabilities?.steer === true;
  const [loading, setLoading] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingOlderRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [images, setImages] = useState<DraftImage[]>([]);
  const [imagesBusy, setImagesBusy] = useState(false);
  const imagesRef = useRef(images);
  imagesRef.current = images;

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    setLoading(true);
    actions.loadTimeline(agentId).then(
      () => {
        if (cancelled) return;
        setHasOlder(actions.historyState(agentId).hasOlder);
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

  // 滚到顶部 / 点「加载更早」：先展开本地已有的，再向 sidecar 取更早一页（beforeSeq）
  const loadEarlier = useCallback(() => {
    if (hidden > 0) {
      setWindowSize((n) => n + WINDOW_STEP);
      return;
    }
    if (!hasOlder || loadingOlderRef.current || !connected) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    actions
      .loadOlderTimeline(agentId, OLDER_PAGE_LIMIT)
      .then(({ hasOlder: more }) => {
        setHasOlder(more);
        setWindowSize((n) => n + WINDOW_STEP);
      })
      .catch((e: unknown) => setError(humanizeSidecarError(e)))
      .finally(() => {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      });
  }, [actions, agentId, connected, hasOlder, hidden]);

  const onRespond = useCallback(
    (approval: PendingApproval, response: AgentPermissionResponse) =>
      actions.respondPermission(approval.sessionId, approval.requestId, response),
    [actions],
  );

  // 选图后依次压缩（长边 ≤ 2048、JPEG 0.85、≤ 5MB），超出 4 张或单张失败给出提示
  const pickImages = async (files: File[]) => {
    setImagesBusy(true);
    try {
      const result = await addImages(imagesRef.current, files, compress);
      setImages(result.images);
      setError(result.errors.length > 0 ? result.errors.join("；") : null);
    } finally {
      setImagesBusy(false);
    }
  };

  const send = async () => {
    const value = text.trim();
    const draft = images;
    if (!value && draft.length === 0) return;
    setText("");
    setImages([]);
    setError(null);
    try {
      const prepared = await prepareAgentPrompt({ text: value, attachments: imagesToAttachments(draft) });
      await actions.sendPrompt(agentId, prepared.prompt, { displayText: value, displayImages: prepared.displayImages });
    } catch (e) {
      setText(value);
      setImages(draft);
      setError(describeImageSendFailure(e instanceof Error ? e.message : String(e), draft.length));
    }
  };

  const steer = async () => {
    const value = text.trim();
    const draft = images;
    if (!value && draft.length === 0) return;
    setError(null);
    try {
      const prepared = await prepareAgentPrompt({ text: value, attachments: imagesToAttachments(draft) });
      await actions.steerPrompt(agentId, prepared.prompt);
      setText("");
      setImages([]);
    } catch (e) {
      setError(describeImageSendFailure(e instanceof Error ? e.message : String(e), draft.length));
    }
  };

  const cancel = () => {
    actions.interrupt(agentId).catch((e: unknown) => setError(humanizeSidecarError(e)));
  };

  const retractMessageId = retractableUserMessageId(runtime);
  const retraction = useRetractMessage({
    retract: () => actions.retract(agentId),
    onPrefill: (prefill) => setText(prefill.text),
  });

  const pendingApproval = inactive ? null : (runtime.pendingApprovals[0] ?? null);
  const title = snapshot ? agentDisplayTitle(snapshot, runtime, providers) : "会话";
  const outputSpeed = runtime.agentUsage?.outputTokensPerSecond ?? snapshot?.lastUsage?.outputTokensPerSecond;

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
          statusMessage={runtime.statusMessage || (!connected ? "正在连接电脑…" : undefined)}
          pendingApproval={
            pendingApproval ? (
              <div className={s.approvalWrap}>
                <ApprovalDialog key={pendingApproval.requestId} approval={pendingApproval} onRespond={onRespond} />
              </div>
            ) : undefined
          }
          turnStartedAt={busy ? runtime.turnStartedAt : undefined}
          density="compact"
          retractMessageId={retractMessageId}
          onRetract={() => void retraction.run()}
          retractDisabled={retraction.retracting}
          onReachTop={loadEarlier}
          topSlot={
            hidden > 0 || hasOlder ? (
              <button type="button" className={s.moreButton} onClick={loadEarlier} disabled={loadingOlder}>
                {loadingOlder
                  ? "正在加载更早的消息…"
                  : hidden > 0
                    ? `显示更早的 ${Math.min(hidden, WINDOW_STEP)} 条（还有 ${hidden} 条未显示）`
                    : "加载更早的消息"}
              </button>
            ) : undefined
          }
        />
      </div>
      {retraction.notice ? <div className={s.notice}>{retraction.notice}</div> : null}
      {error ? (
        <div className={s.error} role="alert">
          {error}
        </div>
      ) : null}
      <ComposerStatusRow
        agentId={undefined}
        subagents={[]}
        openSubagentId={null}
        onOpenSubagent={() => {}}
        backgroundTasks={[]}
        openTaskId={null}
        onOpenTask={() => {}}
        todos={runtime.agentTodos}
        busy={busy}
        rateLimits={snapshot?.rateLimits}
        usage={outputSpeed === undefined ? undefined : { outputTokensPerSecond: outputSpeed }}
      />
      <MobileComposer
        value={text}
        onChange={setText}
        busy={busy}
        connected={connected}
        steerSupported={steerSupported}
        images={images}
        imagesBusy={imagesBusy}
        onAddImages={(files) => void pickImages(files)}
        onRemoveImage={(id) => setImages((list) => list.filter((image) => image.id !== id))}
        onSend={() => void send()}
        onSteer={() => void steer()}
        onCancel={cancel}
      />
    </div>
  );
}
