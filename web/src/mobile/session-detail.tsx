// 会话详情：窗口化的时间线（打开取最近 300 条，滚到顶部向前分页）、审批 / 提问、状态行、输入区。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import type { AgentPermissionResponse } from "@agentdeck/protocol";
import { ApprovalDialog } from "@/components/chat/approval-dialog";
import { MessageTimeline } from "@/components/chat/message-timeline";
import { agentUIMessagesToChatMessages } from "@/components/chat/message-adapter";
import { ComposerStatusRow } from "@/components/chat/status-row/composer-status-row";
import { SubagentPanelBody } from "@/components/chat/subagents/subagent-panel";
import { agentSnapshotsAtom, sidecarConnectionAtom } from "@/stores/agents";
import {
  chatRuntimeBySessionAtom,
  createEmptyChatRuntime,
  retractableUserMessageId,
  type PendingApproval,
} from "@/stores/chat";
import { humanizeSidecarError, isInactiveAgent, useAgentSession, useProviderSubagents } from "@/hooks/use-agent-session";
import { useAgentProviders } from "@/hooks/use-agent-catalog";
import { useRetractMessage } from "@/hooks/use-retract-message";
import { isRuntimeRunning } from "@/lib/session-activity";
import { prepareAgentPrompt } from "@/lib/agent-prompt";
import { agentDisplayTitle, agentStatusLabel } from "@/lib/agent-session-display";
import { MobileComposer } from "./composer";
import { addImages, compressImage, describeImageSendFailure, imagesToAttachments, type DraftImage } from "./image-attachments";
import s from "./mobile.module.css";

/** 首屏只渲染最近这么多条消息（手机 WebView 全量渲染长会话首开要数秒、流式只有约 3fps），更早的按需展开 / 向前分页 */
export const INITIAL_WINDOW = 60;
export const WINDOW_STEP = 100;
export const OLDER_PAGE_LIMIT = 300;
/**
 * 同时渲染的消息数上限。5000+ 条会话全部展开后约 3 万个 DOM 节点，WebView 里滑动帧耗时 p95 达 76ms；
 * 所以窗口最多这么大，再往前翻就换成「较早的消息」视图：只渲染更早的一段（与已看过的部分重叠 CHUNK_OVERLAP 条以便衔接），
 * 顶部提示条可一键返回最新。
 */
export const MAX_RENDERED = 400;
export const CHUNK_OVERLAP = 20;

export function SessionDetail({
  agentId,
  onBack,
  openSubagentId = null,
  onOpenSubagent = () => {},
  onCloseSubagent = () => {},
  compress = compressImage,
}: {
  agentId: string;
  onBack: () => void;
  /** 当前打开的子代理（由 hash 路由驱动）；非空时在页面上盖一层全屏只读子代理时间线 */
  openSubagentId?: string | null;
  onOpenSubagent?: (subagentId: string) => void;
  onCloseSubagent?: () => void;
  /** 图片压缩实现，测试注入 */
  compress?: (file: File) => Promise<DraftImage>;
}) {
  const actions = useAgentSession();
  const connected = useAtomValue(sidecarConnectionAtom) === "open";
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);
  const snapshot = useAtomValue(agentSnapshotsAtom)[agentId];
  const subagents = useProviderSubagents(agentId);
  const providers = useAgentProviders().data ?? null;
  const runtime = useMemo(() => runtimeBySession[agentId] ?? createEmptyChatRuntime(), [runtimeBySession, agentId]);
  const allMessages = useMemo(() => agentUIMessagesToChatMessages(runtime.messages), [runtime.messages]);
  const [windowSize, setWindowSize] = useState(INITIAL_WINDOW);
  // 「较早的消息」视图：以该视图最后一条消息的 id 为锚（向前分页会改变数组下标，id 不会）；null = 跟随最新
  const [historyEndId, setHistoryEndId] = useState<string | null>(null);
  // 切换视图时换 key 重挂时间线，让它按「首次渲染」贴底（避免和前插 / 裁剪的滚动补偿互相打架）
  const [viewKey, setViewKey] = useState(0);
  const historyEnd = useMemo(() => {
    if (historyEndId === null) return -1;
    const index = allMessages.findIndex((message) => message.id === historyEndId);
    return index < 0 ? -1 : index + 1;
  }, [allMessages, historyEndId]);
  const inHistory = historyEnd > 0;
  const viewStart = inHistory ? Math.max(0, historyEnd - MAX_RENDERED) : Math.max(0, allMessages.length - windowSize);
  const hidden = viewStart;
  const chatMessages = useMemo(
    () => (inHistory ? allMessages.slice(viewStart, historyEnd) : viewStart > 0 ? allMessages.slice(viewStart) : allMessages),
    [allMessages, inHistory, viewStart, historyEnd],
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
  const enterHistory = useCallback(
    (endIndex: number) => {
      const anchor = allMessages[Math.min(Math.max(endIndex, 1), allMessages.length) - 1];
      if (!anchor) return;
      setHistoryEndId(anchor.id);
      setViewKey((key) => key + 1);
    },
    [allMessages],
  );
  const backToLatest = useCallback(() => {
    setHistoryEndId(null);
    setWindowSize(INITIAL_WINDOW);
    setViewKey((key) => key + 1);
  }, []);

  const loadEarlier = useCallback(() => {
    if (hidden > 0) {
      if (inHistory) {
        enterHistory(viewStart + CHUNK_OVERLAP);
      } else if (Math.min(windowSize + WINDOW_STEP, allMessages.length) <= MAX_RENDERED) {
        setWindowSize((n) => n + WINDOW_STEP);
      } else {
        // 窗口已到上限：换成更早的一段，而不是继续把全部消息塞进 DOM
        enterHistory(allMessages.length - windowSize + CHUNK_OVERLAP);
      }
      return;
    }
    if (!hasOlder || loadingOlderRef.current || !connected) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    actions
      .loadOlderTimeline(agentId, OLDER_PAGE_LIMIT)
      .then(({ hasOlder: more }) => {
        setHasOlder(more);
        setWindowSize((n) => Math.min(n + WINDOW_STEP, MAX_RENDERED));
      })
      .catch((e: unknown) => setError(humanizeSidecarError(e)))
      .finally(() => {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      });
  }, [actions, agentId, allMessages.length, connected, enterHistory, hasOlder, hidden, inHistory, viewStart, windowSize]);

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
    if (inHistory) backToLatest();
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
    if (inHistory) backToLatest();
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
  // 审批卡片只出现在最新消息之后：正在看较早的消息时来了待审批，直接回到最新，避免错过
  useEffect(() => {
    if (pendingApproval && inHistory) backToLatest();
  }, [pendingApproval, inHistory, backToLatest]);
  const title = snapshot ? agentDisplayTitle(snapshot, runtime, providers) : "会话";
  const outputSpeed = runtime.agentUsage?.outputTokensPerSecond ?? snapshot?.lastUsage?.outputTokensPerSecond;

  return (
    <div className={s.page}>
      <header className={s.header}>
        <button type="button" className={s.iconButton} onClick={onBack} aria-label="返回">
          ‹
        </button>
        <h1 className={s.titleSmall}>{title}</h1>
        {snapshot ? <span className={s.conn}>{agentStatusLabel(snapshot)}</span> : null}
      </header>
      {inHistory ? (
        <div className={s.historyBar} role="status">
          <span>正在查看较早的消息</span>
          <button type="button" className={s.textButton} onClick={backToLatest}>
            返回最新
          </button>
        </div>
      ) : null}
      <div className={s.timeline}>
        <MessageTimeline
          key={`${agentId}:${viewKey}`}
          messages={chatMessages}
          loading={loading && runtime.messages.length === 0}
          statusMessage={runtime.statusMessage || (!connected ? "正在连接电脑…" : undefined)}
          pendingApproval={
            pendingApproval ? (
              <div className={s.approvalWrap}>
                <ApprovalDialog
                  key={pendingApproval.requestId}
                  approval={pendingApproval}
                  remaining={runtime.pendingApprovals.length - 1}
                  onRespond={onRespond}
                />
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
                    ? `显示更早的 ${Math.min(hidden, inHistory || windowSize + WINDOW_STEP > MAX_RENDERED ? MAX_RENDERED - CHUNK_OVERLAP : WINDOW_STEP)} 条（还有 ${hidden} 条未显示）`
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
        subagents={subagents}
        openSubagentId={openSubagentId}
        onOpenSubagent={onOpenSubagent}
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
        onRemoveImage={(id) => {
          setImages((list) => list.filter((image) => image.id !== id));
          // 图片变了，之前「最多附 4 张」之类的选图提示不再成立
          setError(null);
        }}
        onSend={() => void send()}
        onSteer={() => void steer()}
        onCancel={cancel}
      />
      {openSubagentId !== null ? (
        <div className={s.subagentOverlay} role="dialog" aria-label="子代理">
          <SubagentPanelBody
            key={openSubagentId}
            agentId={agentId}
            subagents={subagents}
            subagentId={openSubagentId}
            canGoBack={false}
            onBack={() => {}}
            onOpenChild={onOpenSubagent}
            onClose={onCloseSubagent}
          />
        </div>
      ) : null}
    </div>
  );
}
