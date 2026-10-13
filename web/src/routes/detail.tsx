import { useEffect, useMemo, useCallback, useRef, useState, type CSSProperties } from "react";
import { useAtom, useAtomValue } from "jotai";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Check, Copy, PanelRight } from "lucide-react";
import type { AgentPermissionResponse, ProviderInfo } from "@agentdeck/protocol";
import {
  ASSISTANT_FALLBACK_NAME,
  activeSessionIdAtom,
  assistantDisplayNameAtom,
  conversationFontSizeAtom,
  conversationFontSizeVars,
  conversationWidthMaxWidth,
  conversationWidthModeAtom,
  rightRailVisibleAtom,
} from "@/stores/ui";
import { chatRuntimeBySessionAtom, createEmptyChatRuntime, type PendingApproval } from "@/stores/chat";
import {
  agentListLoadedAtom,
  agentSnapshotsAtom,
  lastRemovedAgentAtom,
  sidecarConnectionAtom,
} from "@/stores/agents";
import {
  AgentSendError,
  humanizeSidecarError,
  isInactiveAgent,
  SESSION_PROVIDER_DELETED_MESSAGE,
  SESSION_PROVIDER_DISABLED_MESSAGE,
  SESSION_UNRECOVERABLE_MESSAGE,
  useAgentSession,
  useBackgroundTasks,
  useProviderSubagents,
} from "@/hooks/use-agent-session";
import { useAgentCatalog, useAgentCommands, useAgentProviders } from "@/hooks/use-agent-catalog";
import { useProviderConfig } from "@/hooks/use-provider-config";
import { relaySessionState } from "@/lib/provider-profiles";
import { useComposerTimer } from "@/hooks/use-composer-timer";
import { useStallWatchdog } from "@/hooks/use-stall-watchdog";
import { agentProviderLabel } from "@/lib/agent-session-display";
import { isRuntimeRunning } from "@/lib/session-activity";
import { prepareAgentPrompt } from "@/lib/agent-prompt";
import { isLocalMcpCommand, isLocalStatusCommand, mergeSlashCommands, supportsLocalMcpCommand } from "@/lib/slash-commands";
import { applyAgentSelectionChange, type AgentSelection } from "@/lib/agent-selection";
import {
  composerDraftStorageKey,
  readComposerDraftByKey,
  writeComposerDraftByKey,
} from "@/lib/composer-drafts";
import { formatElapsedTimer } from "@/lib/format";
import { TopBar, TopBarActionButton, TopBarActions } from "@/components/top-bar/top-bar";
import { GooseComposer } from "@/components/chat/goose-composer";
import { ApprovalDialog } from "@/components/chat/approval-dialog";
import { ContextUsageIndicator } from "@/components/chat/context-usage-indicator";
import { McpServersDialog } from "@/components/chat/mcp-servers-dialog";
import { StatusDialog } from "@/components/chat/status-dialog";
import { AgentSessionPicker } from "@/components/composer/agent-session-picker";
import { QueuePanel } from "@/components/composer/queue-panel";
import {
  enqueueQueuedPrompt,
  removeQueuedPrompt,
  shouldAutoDrainOnSettle,
  useQueuedPrompts,
  type QueuedPromptEntry,
} from "@/stores/composer-queue";
import type { ComposerSubmitPayload } from "@/components/chat/composer-types";
import { MessageTimeline } from "@/components/chat/message-timeline";
import { StallNotice } from "@/components/chat/stall-notice";
import { PreviewRail } from "@/components/chat/preview-rail/preview-rail";
import { SubagentTrack } from "@/components/chat/subagents/subagent-track";
import { BackgroundTaskTrack } from "@/components/chat/background-tasks/background-task-track";
import { SubagentPanel } from "@/components/chat/subagents/subagent-panel";
import { PREVIEW_PANEL_QUERY_KEY } from "@/lib/preview-rail";
import { ConversationWidthControl } from "@/components/chat/conversation-width-control";
import { hermesUIMessagesToChatMessages } from "@/components/chat/message-adapter";
import s from "./detail.module.css";

interface ComposerPrefillState {
  text: string;
  nonce: number;
  sessionId?: string;
}

function firstUserText(messages: { role: string; parts: { type: string; text?: string }[] }[]): string {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = message.parts.find((part) => part.type === "text")?.text?.trim();
    if (text) return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  }
  return "";
}

export function DetailRoute() {
  // URL 决定初始选中；activeSessionIdAtom 是运行时真相（侧栏点击会先同步写它）。
  // AgentDeck 中会话 id 就是 sidecar 的 agentId。
  const { taskId: urlTaskId } = useParams<{ taskId: string }>();
  const [activeSessionId, setActiveId] = useAtom(activeSessionIdAtom);
  const [conversationWidthMode, setConversationWidthMode] = useAtom(conversationWidthModeAtom);
  const conversationFontSizeMode = useAtomValue(conversationFontSizeAtom);
  const assistantDisplayName = useAtomValue(assistantDisplayNameAtom);
  const [rightRailVisible, setRightRailVisible] = useAtom(rightRailVisibleAtom);
  const [searchParams] = useSearchParams();
  const taskId = activeSessionId ?? urlTaskId;
  // provider 子代理（design.md 4.11）：输入框上方药丸 + 右侧只读面板（打开时替代预览面板）
  const subagents = useProviderSubagents(taskId);
  // 后台任务（design.md 4.15）：仅 Claude 会有；药丸紧邻子代理药丸
  const backgroundTasks = useBackgroundTasks(taskId);
  const [openSubagentId, setOpenSubagentId] = useState<string | null>(null);
  useEffect(() => setOpenSubagentId(null), [taskId]);

  const actions = useAgentSession();
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);
  const snapshots = useAtomValue(agentSnapshotsAtom);
  const agentListLoaded = useAtomValue(agentListLoadedAtom);
  const connected = useAtomValue(sidecarConnectionAtom) === "open";
  const runtime = useMemo(
    () => (taskId ? runtimeBySession[taskId] : undefined) ?? createEmptyChatRuntime(),
    [runtimeBySession, taskId],
  );
  const snapshot = taskId ? snapshots[taskId] : undefined;
  const providersQuery = useAgentProviders();
  const catalogQuery = useAgentCatalog(snapshot?.provider ?? null, snapshot?.cwd ?? "");
  const commandsQuery = useAgentCommands(taskId, snapshot?.status);
  const [mcpDialogOpen, setMcpDialogOpen] = useState(false);
  const [statusDialogOpen, setStatusDialogOpen] = useState(false);
  const runtimeIsBusy = isRuntimeRunning(runtime) || snapshot?.status === "running";
  // dormant（sidecar 重启后的历史会话）/ closed：发送时自动恢复；starting：恢复进行中
  const inactive = isInactiveAgent(snapshot);
  const resuming = snapshot?.status === "starting";
  // 发送时被告知无法恢复（NOT_SUPPORTED / AGENT_CLOSED / 中转已删除 PROVIDER_NOT_FOUND）
  const [sendUnrecoverable, setSendUnrecoverable] = useState<{ message: string; providerMissing: boolean } | null>(null);
  const providerConfigQuery = useProviderConfig();
  // 中转会话（design.md 4.7）：sidecar 启动时找不到 provider 会把 resumable 记为 false，
  // 但中转重新启用后发送时会重新判断，因此只有「已从配置删除」才在发送前判定为不可恢复。
  const relayState = relaySessionState(snapshot?.provider, providerConfigQuery.data?.providers);
  const relayDeleted = inactive && relayState === "deleted";
  // 会话所用中转仍在配置里但已停用：恢复会返回 PROVIDER_NOT_FOUND，提示启用而不是「已删除」
  const providerDisabled = relayState === "disabled";
  const staticUnrecoverable = relayDeleted || (inactive && snapshot?.resumable === false && relayState === "builtin");
  const unrecoverable = staticUnrecoverable || sendUnrecoverable !== null;
  const unrecoverableMessage = sendUnrecoverable?.message
    ?? (relayDeleted ? SESSION_PROVIDER_DELETED_MESSAGE : SESSION_UNRECOVERABLE_MESSAGE);
  const [recreateState, setRecreateState] = useState<{ pending: boolean; error?: string }>({ pending: false });
  const navigate = useNavigate();
  const lastRemoved = useAtomValue(lastRemovedAgentAtom);

  const [timelineState, setTimelineState] = useState<{ id?: string; loading: boolean; error?: string }>({
    loading: false,
  });
  const [sessionIdCopyState, setSessionIdCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [controlError, setControlError] = useState<string | undefined>();
  // 切换思考强度的提示（如「思考强度将在下一轮生效」），本轮结束后清除
  const [controlNotice, setControlNotice] = useState<string | undefined>();
  const sessionIdCopyTimer = useRef<number | null>(null);

  const sessionWorkspace = snapshot?.cwd ?? "";
  const composerDraftKey = useMemo(
    () => composerDraftStorageKey({ kind: "session", sessionId: taskId }),
    [taskId],
  );
  const storedComposerDraft = useMemo(
    () => readComposerDraftByKey(composerDraftKey),
    [composerDraftKey],
  );
  const onComposerDraftChange = useCallback((text: string) => {
    writeComposerDraftByKey(composerDraftKey, text);
  }, [composerDraftKey]);

  useEffect(() => {
    if (urlTaskId && urlTaskId !== activeSessionId) setActiveId(urlTaskId);
  }, [urlTaskId, activeSessionId, setActiveId]);

  // 正在查看的会话被删除（本页、侧栏、历史页或其它客户端）：回到首页。
  useEffect(() => {
    if (!lastRemoved || !taskId || lastRemoved.agentId !== taskId) return;
    navigate("/", { replace: true });
    setActiveId(null);
  }, [lastRemoved, navigate, setActiveId, taskId]);

  // 历史：从 agent.timeline 回放重建（经 reduceAgentEvent，按 seq 去重）。
  useEffect(() => {
    if (!taskId || !connected) return;
    let cancelled = false;
    setTimelineState({ id: taskId, loading: true });
    actions.loadTimeline(taskId).then(
      () => {
        if (!cancelled) setTimelineState({ id: taskId, loading: false });
      },
      (error: unknown) => {
        if (!cancelled) setTimelineState({ id: taskId, loading: false, error: humanizeSidecarError(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [actions, connected, taskId]);

  // ⌘B / Ctrl+B 切换右侧预览栏。
  const railVisibleRef = useRef(rightRailVisible);
  railVisibleRef.current = rightRailVisible;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setRightRailVisible(!railVisibleRef.current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setRightRailVisible]);

  const didAutoOpenRail = useRef(false);
  useEffect(() => {
    if (didAutoOpenRail.current) return;
    didAutoOpenRail.current = true;
    if (searchParams.has(PREVIEW_PANEL_QUERY_KEY) && !railVisibleRef.current) {
      setRightRailVisible(true);
    }
  }, [searchParams, setRightRailVisible]);

  useEffect(() => {
    return () => {
      if (sessionIdCopyTimer.current !== null) window.clearTimeout(sessionIdCopyTimer.current);
    };
  }, []);

  const copySessionId = useCallback(async () => {
    if (!taskId) return;
    let state: "copied" | "error" = "copied";
    try {
      await navigator.clipboard.writeText(taskId);
    } catch {
      state = "error";
    }
    setSessionIdCopyState(state);
    if (sessionIdCopyTimer.current !== null) window.clearTimeout(sessionIdCopyTimer.current);
    sessionIdCopyTimer.current = window.setTimeout(() => {
      setSessionIdCopyState("idle");
      sessionIdCopyTimer.current = null;
    }, 2200);
  }, [taskId]);

  const chatMessages = useMemo(
    () => hermesUIMessagesToChatMessages(runtime.messages),
    [runtime.messages],
  );

  // provider 种类（自定义中转取 extends 的值）：决定 /mcp 拦截与手动压缩是否可用
  const providerKind = providersQuery.data?.find((provider) => provider.id === snapshot?.provider)?.kind
    ?? (snapshot?.provider === "claude" || snapshot?.provider === "codex" ? snapshot.provider : undefined);

  const submitPayload = useCallback(async (payload: ComposerSubmitPayload) => {
    if (!taskId) return;
    const prepared = await prepareAgentPrompt(payload);
    try {
      await actions.sendPrompt(taskId, prepared.prompt, {
        displayText: prepared.displayText,
        displayImages: prepared.displayImages,
        providerDisabled,
      });
    } catch (error) {
      if (error instanceof AgentSendError && error.unrecoverable) {
        setSendUnrecoverable({ message: error.message, providerMissing: error.providerMissing });
      }
      throw error;
    }
  }, [actions, providerDisabled, taskId]);

  const onSend = useCallback(async (payload: ComposerSubmitPayload) => {
    if (!taskId) return;
    // `/mcp`：不发送也不排队（即使 Agent 正忙），直接打开 MCP 面板
    if (isLocalMcpCommand(payload, providerKind)) {
      setMcpDialogOpen(true);
      return;
    }
    // `/status`：同样本地拦截，打开状态面板
    if (isLocalStatusCommand(payload, providerKind)) {
      setStatusDialogOpen(true);
      return;
    }
    // Agent 正忙时先排队，空闲后自动发出。
    if (runtimeIsBusy) {
      enqueueQueuedPrompt(taskId, { text: payload.text, attachments: payload.attachments }, Date.now());
      return;
    }
    await submitPayload(payload);
  }, [providerKind, runtimeIsBusy, submitPayload, taskId]);

  // ---- 发送队列（空闲时自动发出 / 立即发送 / 编辑 / 删除） ----------------------
  const queuedPrompts = useQueuedPrompts(taskId);
  const [composerPrefill, setComposerPrefill] = useState<ComposerPrefillState>({ text: "", nonce: 0 });
  const drainingRef = useRef(false);
  const previousBusyRef = useRef(runtimeIsBusy);
  const userInterruptedRef = useRef(false);

  const drainEntry = useCallback(async (entry: QueuedPromptEntry) => {
    if (!taskId || drainingRef.current) return;
    drainingRef.current = true;
    try {
      await submitPayload({ text: entry.text, attachments: entry.attachments });
      removeQueuedPrompt(taskId, entry.id);
    } catch (error) {
      console.error("发送排队消息失败：", error);
    } finally {
      drainingRef.current = false;
    }
  }, [submitPayload, taskId]);

  useEffect(() => {
    const wasBusy = previousBusyRef.current;
    previousBusyRef.current = runtimeIsBusy;
    if (runtimeIsBusy && !wasBusy) {
      userInterruptedRef.current = false;
      return;
    }
    const interrupted = userInterruptedRef.current;
    if (!runtimeIsBusy && wasBusy && interrupted) {
      userInterruptedRef.current = false;
    }
    if (shouldAutoDrainOnSettle({
      isBusy: runtimeIsBusy,
      wasBusy,
      queueLength: queuedPrompts.length,
      userInterrupted: interrupted,
    })) {
      void drainEntry(queuedPrompts[0]!);
    }
  }, [drainEntry, queuedPrompts, runtimeIsBusy]);

  const onQueueSendNow = useCallback((id: string) => {
    const entry = queuedPrompts.find((item) => item.id === id);
    if (entry) void drainEntry(entry);
  }, [drainEntry, queuedPrompts]);

  const onQueueEdit = useCallback((entry: QueuedPromptEntry) => {
    setComposerPrefill((prefill) => ({ text: entry.text, nonce: prefill.nonce + 1, sessionId: taskId }));
    removeQueuedPrompt(taskId, entry.id);
  }, [taskId]);

  const onQueueDelete = useCallback((id: string) => {
    removeQueuedPrompt(taskId, id);
  }, [taskId]);

  useEffect(() => {
    setComposerPrefill({ text: "", nonce: 0 });
    previousBusyRef.current = false;
    userInterruptedRef.current = false;
    setControlError(undefined);
    setControlNotice(undefined);
    setSendUnrecoverable(null);
    setRecreateState({ pending: false });
    setMcpDialogOpen(false);
    setStatusDialogOpen(false);
  }, [taskId]);

  const onStop = useCallback(async () => {
    if (!taskId || !runtimeIsBusy) return;
    // 主动停止只抑制一次自动出队，避免刚停下的回合被队列立刻重新触发。
    userInterruptedRef.current = true;
    await actions.interrupt(taskId);
  }, [actions, runtimeIsBusy, taskId]);

  const onRespondPermission = useCallback(
    (approval: PendingApproval, response: AgentPermissionResponse) =>
      actions.respondPermission(approval.sessionId, approval.requestId, response),
    [actions],
  );

  // ---- 模型 / 模式切换 -----------------------------------------------------
  const providers: ProviderInfo[] | null = useMemo(() => {
    if (!snapshot) return null;
    const list = providersQuery.data ?? [];
    if (list.some((provider) => provider.id === snapshot.provider)) return list;
    return [...list, { id: snapshot.provider, kind: "acp", label: agentProviderLabel(snapshot.provider), available: true }];
  }, [providersQuery.data, snapshot]);
  const providerLabel = providers?.find((provider) => provider.id === snapshot?.provider)?.label
    ?? snapshot?.provider
    ?? "";
  // 助手显示名：用户自定义名称 → 当前会话的 Agent 名称 → 「Agent」。
  const assistantName = assistantDisplayName || providerLabel || ASSISTANT_FALLBACK_NAME;
  const catalog = useMemo(() => {
    if (!snapshot) return null;
    const modes = snapshot.availableModes?.length ? snapshot.availableModes : catalogQuery.data?.modes ?? [];
    return { models: catalogQuery.data?.models ?? [], modes };
  }, [catalogQuery.data, snapshot]);
  const selection: AgentSelection = {
    provider: snapshot?.provider ?? null,
    model: snapshot?.model ?? null,
    modeId: snapshot?.modeId ?? null,
    thinkingOptionId: snapshot?.thinkingOptionId ?? null,
  };

  useEffect(() => {
    if (!runtimeIsBusy) setControlNotice(undefined);
  }, [runtimeIsBusy]);

  const onSelectionChange = useCallback(async (next: AgentSelection) => {
    if (!taskId || !snapshot) return;
    setControlError(undefined);
    try {
      const result = await applyAgentSelectionChange(actions, taskId, snapshot, next);
      if (result.thinkingChanged) setControlNotice(result.notice);
    } catch (error) {
      setControlError(humanizeSidecarError(error));
    }
  }, [actions, snapshot, taskId]);

  // 不可恢复的会话：一键以同一 Agent / 工作区新建会话；原 Agent（中转）已删除时回到新任务页并带上工作区。
  const recreateProviderMissing = sendUnrecoverable?.providerMissing === true || relayDeleted;
  const onRecreate = useCallback(async () => {
    if (!snapshot) return;
    if (recreateProviderMissing) {
      setActiveId(null);
      navigate(snapshot.cwd ? `/?workspace=${encodeURIComponent(snapshot.cwd)}` : "/");
      return;
    }
    setRecreateState({ pending: true });
    try {
      const agent = await actions.createSession({ provider: snapshot.provider, cwd: snapshot.cwd });
      setActiveId(agent.id);
      navigate(`/tasks/${encodeURIComponent(agent.id)}`);
    } catch (error) {
      setRecreateState({ pending: false, error: humanizeSidecarError(error) });
    }
  }, [actions, navigate, recreateProviderMissing, setActiveId, snapshot]);

  // ---- 展示 ----------------------------------------------------------------
  const title = snapshot?.title?.trim()
    || snapshot?.preview?.trim()
    || firstUserText(runtime.messages)
    || (providerLabel ? `${providerLabel} 会话` : "会话详情");
  const model = snapshot?.model ?? "";
  const sub = snapshot
    ? [providerLabel, model ? `模型 ${model}` : "", snapshot.cwd].filter(Boolean).join(" · ")
    : undefined;
  // dormant / closed 下 sidecar 拒绝权限应答（AGENT_CLOSED），不展示审批
  const pendingApproval = inactive ? null : runtime.pendingApprovals[0] ?? null;
  const notFound = timelineState.id === taskId && Boolean(timelineState.error) && !snapshot;
  const missing = agentListLoaded && !snapshot && runtime.messages.length === 0;

  // ---- 斜杠命令 / 手动压缩 ---------------------------------------------------
  const slashCommands = useMemo(
    () => mergeSlashCommands(commandsQuery.data, providerKind),
    [commandsQuery.data, providerKind],
  );
  const { isStale: commandsStale, refetch: refetchCommands } = commandsQuery;
  const onSlashMenuOpen = useCallback(() => {
    if (commandsStale) void refetchCommands();
  }, [commandsStale, refetchCommands]);
  const compactSupported = supportsLocalMcpCommand(providerKind)
    || (providerKind === "acp" && Boolean(commandsQuery.data?.some((command) => command.name === "compact")));
  const compactUnavailable = unrecoverable || notFound || missing || resuming;
  const compactDisabledReason = runtimeIsBusy
    ? "Agent 正在响应，结束后再压缩"
    : resuming
      ? "会话正在恢复，请稍候"
      : compactUnavailable
        ? "会话不可用"
        : undefined;
  const onCompact = useCallback(() => {
    // 失败提示已由 sendPrompt 写进时间线
    submitPayload({ text: "/compact", attachments: [] }).catch(() => {});
  }, [submitPayload]);

  const composerTick = useComposerTimer(runtimeIsBusy, runtime.turnStartedAt);
  const stall = useStallWatchdog(runtime);
  const composerLoadingPlaceholder = runtimeIsBusy && runtime.turnStartedAt
    ? `${assistantName} 思考中 · ${formatElapsedTimer(composerTick)}`
    : undefined;
  const timelineStatus =
    runtime.statusMessage ||
    (notFound || missing ? timelineState.error ?? "会话不存在（Agent 服务可能已重启），请新建会话" : undefined) ||
    (runtimeIsBusy && chatMessages.length === 0 ? "任务运行中，等待输出…" : undefined);

  const sessionNotice: { tone: "info" | "danger"; text: string; detail?: string } | null = !snapshot
    ? null
    : unrecoverable
      ? { tone: "danger", text: unrecoverableMessage, detail: snapshot.lastError ?? undefined }
      : resuming
        ? { tone: "info", text: "正在恢复会话…" }
        : inactive && providerDisabled
          ? { tone: "info", text: SESSION_PROVIDER_DISABLED_MESSAGE }
          : inactive
            ? {
                tone: "info",
                text: snapshot.status === "closed"
                  ? "该会话已关闭，发送消息将尝试恢复"
                  : "历史会话，发送消息将自动恢复",
                detail: snapshot.lastError ?? undefined,
              }
            : null;

  const hasActiveComposerPrefill = composerPrefill.sessionId === taskId && composerPrefill.nonce > 0;
  const composerInitial = hasActiveComposerPrefill ? composerPrefill.text : storedComposerDraft;
  const composerInitialNonce = hasActiveComposerPrefill ? composerPrefill.nonce : 0;
  const pageStyle = useMemo(
    () => {
      const font = conversationFontSizeVars(conversationFontSizeMode);
      return {
        "--conversation-max-width": `min(${conversationWidthMaxWidth(conversationWidthMode)}, 100% - 64px)`,
        "--conversation-font-size": font.fontSize,
        "--conversation-line-height": font.lineHeight,
      } as CSSProperties;
    },
    [conversationFontSizeMode, conversationWidthMode],
  );

  return (
    <div className={s.page} data-conversation-width={conversationWidthMode} style={pageStyle}>
      <TopBar
        title={title}
        sub={sub}
        right={
          <>
            <ConversationWidthControl
              value={conversationWidthMode}
              onChange={setConversationWidthMode}
            />
            {taskId ? (
              <TopBarActionButton
                onClick={copySessionId}
                title={`复制会话 ID：${taskId}`}
                aria-label={`复制会话 ID ${taskId}`}
              >
                {sessionIdCopyState === "copied" ? (
                  <Check size={12} aria-hidden="true" />
                ) : (
                  <Copy size={12} aria-hidden="true" />
                )}
                <span>
                  {sessionIdCopyState === "copied"
                    ? "已复制"
                    : sessionIdCopyState === "error"
                      ? "复制失败"
                      : "复制会话 ID"}
                </span>
              </TopBarActionButton>
            ) : null}
            <TopBarActionButton
              onClick={() => setRightRailVisible(!rightRailVisible)}
              data-active={rightRailVisible ? "true" : undefined}
              title="预览面板（⌘B）"
              aria-label="预览面板"
              aria-pressed={rightRailVisible}
            >
              <PanelRight size={12} aria-hidden="true" />
              <span>预览</span>
            </TopBarActionButton>
            <TopBarActions />
          </>
        }
      />
      <div className={s.workArea}>
        <div className={s.chatColumn}>
          <MessageTimeline
            key={taskId}
            messages={chatMessages}
            loading={timelineState.loading && runtime.messages.length === 0}
            statusMessage={timelineStatus}
            pendingApproval={
              pendingApproval ? (
                <ApprovalDialog
                  key={pendingApproval.requestId}
                  approval={pendingApproval}
                  onRespond={onRespondPermission}
                />
              ) : undefined
            }
            turnStartedAt={runtimeIsBusy ? runtime.turnStartedAt : undefined}
            progressModel={runtimeIsBusy ? model || undefined : undefined}
            assistantName={assistantName}
          />
          <div className={s.composerArea}>
            {runtimeIsBusy && stall.isStalled ? (
              <StallNotice silenceMs={stall.silenceMs} onInterrupt={onStop} />
            ) : null}
            {sessionNotice ? (
              <div className={s.sessionNotice} data-tone={sessionNotice.tone} role="status">
                <div className={s.sessionNoticeText}>
                  <span>{sessionNotice.text}</span>
                  {sessionNotice.detail ? (
                    <span className={s.sessionNoticeDetail}>{sessionNotice.detail}</span>
                  ) : null}
                  {recreateState.error ? (
                    <span className={s.sessionNoticeDetail}>新建失败：{recreateState.error}</span>
                  ) : null}
                </div>
                {unrecoverable ? (
                  <button
                    type="button"
                    className={s.sessionNoticeAction}
                    onClick={() => void onRecreate()}
                    disabled={recreateState.pending}
                  >
                    {recreateState.pending
                      ? "正在新建…"
                      : recreateProviderMissing
                        ? "新建会话（同工作区）"
                        : "新建会话（同 Agent / 工作区）"}
                  </button>
                ) : null}
              </div>
            ) : null}
            <SubagentTrack
              subagents={subagents}
              parentSubagentId={null}
              onOpen={setOpenSubagentId}
              activeSubagentId={openSubagentId}
            />
            {taskId ? <BackgroundTaskTrack key={taskId} agentId={taskId} tasks={backgroundTasks} /> : null}
            <QueuePanel
              entries={queuedPrompts}
              busy={runtimeIsBusy}
              editingId={null}
              onSendNow={onQueueSendNow}
              onEdit={onQueueEdit}
              onDelete={onQueueDelete}
            />
            <GooseComposer
              key={`${taskId}:${composerDraftKey ?? "draft"}`}
              flushBottom
              initialWorkspacePath={sessionWorkspace}
              initial={composerInitial}
              initialNonce={composerInitialNonce}
              onDraftChange={onComposerDraftChange}
              onSend={onSend}
              loadingPlaceholder={composerLoadingPlaceholder}
              showMeta={false}
              loading={runtimeIsBusy}
              disabled={unrecoverable || notFound || missing}
              placeholder={unrecoverable ? unrecoverableMessage : undefined}
              onStop={onStop}
              // 运行时 usage 比快照新（压缩后会清掉已用量，见 stores/chat.ts）；没有时退回快照
              toolbarTrailing={
                <ContextUsageIndicator
                  usage={runtime.agentUsage ?? snapshot?.lastUsage}
                  onCompact={compactSupported ? onCompact : undefined}
                  compactDisabled={runtimeIsBusy || compactUnavailable}
                  compactDisabledReason={compactDisabledReason}
                />
              }
              slashCommands={slashCommands}
              onSlashMenuOpen={onSlashMenuOpen}
              toolbarExtra={
                snapshot ? (
                  <AgentSessionPicker
                    selection={selection}
                    onChange={(next) => void onSelectionChange(next)}
                    providers={providers}
                    catalog={catalog}
                    catalogLoading={catalogQuery.isLoading}
                    catalogError={controlError}
                    disabled={runtimeIsBusy || inactive || resuming}
                    thinkingDisabled={inactive || resuming}
                    notice={controlNotice}
                    providerLocked
                  />
                ) : null
              }
            />
          </div>
        </div>
        {openSubagentId && taskId ? (
          <SubagentPanel
            agentId={taskId}
            subagents={subagents}
            rootSubagentId={openSubagentId}
            onClose={() => setOpenSubagentId(null)}
          />
        ) : rightRailVisible && taskId ? (
          <PreviewRail
            sessionId={taskId}
            workspaceRoot={sessionWorkspace}
            onClose={() => setRightRailVisible(false)}
          />
        ) : null}
      </div>
      {taskId ? (
        <>
          <McpServersDialog open={mcpDialogOpen} agentId={taskId} onClose={() => setMcpDialogOpen(false)} />
          <StatusDialog open={statusDialogOpen} agentId={taskId} onClose={() => setStatusDialogOpen(false)} />
        </>
      ) : null}
    </div>
  );
}
