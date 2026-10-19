import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, WheelEvent } from "react";
import { useAtomValue } from "jotai";
import { AlertTriangle, ChevronRight, FileDiff, GitFork, Info, RotateCcw, Undo2 } from "lucide-react";
import { ASSISTANT_FALLBACK_NAME, assistantAvatarDataUrlAtom, showReasoningAtom } from "@/stores/ui";
import { AGENT_COMPACTION_NOTICE_PREFIX, AGENT_TIMELINE_NOTICE_PREFIX } from "@/stores/chat";
import type { AssistantMessageStats, ChatMessage, ChatToolItem } from "./chat-types";
import { AssistantProfileCard } from "./assistant-profile-card";
import { MessageImage } from "./message-image";
import { findMessageIdForSeq } from "./focus-seq";
import { MessageSkeleton } from "./message-skeleton";
import { MessageText } from "./message-text";
import {
  SentTranslation,
  TimelineTranslationContext,
  TranslatedMessageText,
  TranslatedReasoningText,
  useTimelineTranslation,
  type TimelineTranslation,
} from "./translated-text";
import { DelegateCard } from "./delegate-card";
import { SubAgentToolDetail } from "./subagents/subagent-tool-detail";
import { CopyButton } from "@/components/ui/copy-button";
import s from "./message-timeline.module.css";
import { summarizeToolActivity } from "./tool-activity";
import { groupConsecutiveTools, groupElapsedMs } from "./group-tools";
import { truncateMiddle } from "@/lib/truncate-middle";
import {
  formatDurationMs,
  formatElapsedTimer,
  formatTokPerSec,
  formatTokens,
} from "@/lib/format";
import type { SessionUsageResult, SnapshotTurn } from "@agentdeck/protocol";
import { snapshotForMessage } from "@/lib/snapshots";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
const BOTTOM_FOLLOW_THRESHOLD_PX = 120;
const BOTTOM_REATTACH_THRESHOLD_PX = 8;
const REACH_TOP_THRESHOLD_PX = 80;

interface MessageTimelineProps {
  messages: ChatMessage[];
  loading?: boolean;
  statusMessage?: string;
  pendingApproval?: ReactNode;
  turnStartedAt?: number;
  sessionUsage?: SessionUsageResult | null;
  progressModel?: string;
  /** 助手显示名（宿主按自定义名称 → 会话 Agent 名称解析），缺省为「Agent」。 */
  assistantName?: string;
  /** compact：窄容器（子代理面板）用，不渲染头像列/助手名与轮次导航，收窄左右留白。 */
  density?: "default" | "compact";
  /** 可撤回的用户消息 id（design.md 4.16）：该消息气泡上显示「撤回」操作。 */
  retractMessageId?: string;
  onRetract?: () => void;
  retractDisabled?: boolean;
  /** 回合以失败 / 中断结束时，该回合末尾提示消息的 id：其上显示「重试」（design.md 4.21）。 */
  retryNoticeId?: string;
  onRetry?: () => void;
  /** 最后一条用户消息 id：显示「再次发送」；hint 为提示（如「图片未保存，仅重发文字」）。 */
  resendMessageId?: string;
  resendHint?: string;
  onResend?: () => void;
  /** 重试 / 再次发送进行中 */
  resendDisabled?: boolean;
  /** 全文搜索定位（design.md 4.19）：滚动到包含该 seq 的消息并短暂高亮；找不到则保持贴底。 */
  focusSeq?: number | null;
  /** 「从这里分叉」（design.md 4.23）：传该消息所在回合内的一个时间线 seq；不传则不显示该操作。 */
  onFork?: (seq: number) => void;
  /** 按回合文件快照索引（design.md 4.24）：已结束且有文件变化的回合末尾显示「本回合修改了 N 个文件」。 */
  snapshotTurns?: readonly SnapshotTurn[];
  /** 点击该小条：在右侧预览栏打开快照面板并展开该回合。 */
  onOpenSnapshot?: (turnId: string) => void;
  /** 手机端向前分页：用户滚动到顶部附近时回调（宿主自行防抖 / 判断是否还有更早内容）。 */
  onReachTop?: () => void;
  /** 渲染在消息列表最上方的插槽（手机端「加载更早」入口）。 */
  topSlot?: ReactNode;
  /** 会话翻译（design.md 4.35）：开启时已完成的助手文本显示译文；缺省不翻译。 */
  translation?: TimelineTranslation;
}

const NO_TRANSLATION: TimelineTranslation = { enabled: false, translateReasoning: false };

/** 定位后消息高亮持续的时间（与 CSS 动画时长一致） */
const FOCUS_HIGHLIGHT_MS = 2000;

interface TurnAnchor {
  id: string;
  index: number;
  title: string;
}

/** 未设置头像时显示的名称首字（拉丁字母转大写）。 */
export function avatarInitial(name: string): string {
  const first = Array.from(name.trim())[0] ?? "A";
  return first.toUpperCase();
}

export function resolveBottomFollowState(
  bottomDistance: number,
  userDetachedFromBottom: boolean,
): { nearBottom: boolean; userDetachedFromBottom: boolean } {
  const distance = Math.max(0, bottomDistance);
  if (userDetachedFromBottom) {
    const reattached = distance <= BOTTOM_REATTACH_THRESHOLD_PX;
    return {
      nearBottom: reattached,
      userDetachedFromBottom: !reattached,
    };
  }
  return {
    nearBottom: distance < BOTTOM_FOLLOW_THRESHOLD_PX,
    userDetachedFromBottom: false,
  };
}

function distanceFromBottom(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight);
}

// 只有"用户主动上滑"才应脱离贴底跟随。程序触发的轮次跳转平滑滚动同样会让 scrollTop
// 递减，但绝不能被当成用户手势——否则会把自己的跳转动画硬取消掉。
export function shouldDetachOnScroll(
  scrollTop: number,
  lastScrollTop: number,
  programmaticScroll: boolean,
): boolean {
  if (programmaticScroll) return false;
  return scrollTop < lastScrollTop - 1;
}

export function shouldForceBottomOnMessageChange(
  previousMessageCount: number,
  nextMessageCount: number,
  sessionChanged: boolean,
  previousLastUserMessageId: string | undefined,
  nextLastUserMessageId: string | undefined,
): boolean {
  if (nextMessageCount === 0) return false;
  if (previousMessageCount === 0 || sessionChanged) return true;
  return nextLastUserMessageId !== undefined && nextLastUserMessageId !== previousLastUserMessageId;
}

// Intl 格式化器创建很贵（Android WebView 上 800 条消息的 toLocale*String 约 600ms），按模块缓存复用。
const DAY_FORMAT = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" });
const TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" });

function formatDay(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  if (date.toDateString() === now.toDateString()) return "今天";
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return DAY_FORMAT.format(date);
}

function formatTime(timestamp: number): string {
  return TIME_FORMAT.format(new Date(timestamp));
}

function turnAnchorTitle(message: ChatMessage, index: number): string {
  const preview = getCopyableText(message)?.replace(/\s+/g, " ").trim();
  return preview
    ? `第 ${index + 1} 轮：${truncateMiddle(preview, 34)}`
    : `第 ${index + 1} 轮`;
}

const PROGRESS_TRANSLATIONS: Record<string, string> = {
  analyzing: "分析中",
  brainstorming: "头脑风暴中",
  cogitating: "沉思中",
  computing: "计算中",
  contemplating: "推理中",
  deliberating: "思考中",
  decrypting: "解密中",
  forging: "锻造中",
  formulating: "构思中",
  "hammering plans": "敲定方案中",
  "jacking in": "接入中",
  mulling: "琢磨中",
  musing: "遐想中",
  plotting: "谋划中",
  pondering: "斟酌中",
  processing: "处理中",
  reasoning: "推理中",
  reflecting: "反思中",
  ruminating: "深思中",
  synthesizing: "综合分析中",
  uploading: "上传中",
};

function localizeProgressLabel(text?: string): string {
  if (!text) return "思考中";
  const normalized = text.replace(/\s+/g, " ").trim();
  const base = normalized.replace(/\.{2,}|…/g, "").trim();
  if (!base) return "思考中";
  for (const [en, zh] of Object.entries(PROGRESS_TRANSLATIONS)) {
    if (base.toLowerCase().endsWith(en)) {
      return base.slice(0, base.length - en.length) + zh;
    }
  }
  return normalized;
}

const LONG_THINKING_THRESHOLD_S = 120;

/** 时间线末尾有待审批请求：进度块显示「等待审批」并暂停计时（审批等待不算 Agent 的耗时） */
const WaitingApprovalContext = createContext(false);

interface ProgressBlockProps {
  turnStartedAt?: number;
  sessionUsage?: SessionUsageResult | null;
  progressModel?: string;
  progressText?: string;
}

function ProgressBlock({ turnStartedAt, sessionUsage, progressModel, progressText }: ProgressBlockProps) {
  const [elapsed, setElapsed] = useState(0);
  const waitingApproval = useContext(WaitingApprovalContext);
  // 审批等待的累计时长与本次等待的起点：从耗时里扣除，等待期间计时冻结
  const pausedRef = useRef<{ total: number; since: number | null }>({ total: 0, since: null });
  useEffect(() => {
    pausedRef.current = { total: 0, since: null };
  }, [turnStartedAt]);
  useEffect(() => {
    const paused = pausedRef.current;
    if (waitingApproval && paused.since === null) {
      paused.since = Date.now();
    } else if (!waitingApproval && paused.since !== null) {
      paused.total += Date.now() - paused.since;
      paused.since = null;
    }
  }, [waitingApproval, turnStartedAt]);
  useEffect(() => {
    if (!turnStartedAt) return;
    const compute = () => {
      const now = Date.now();
      const { total, since } = pausedRef.current;
      return now - turnStartedAt - total - (since !== null ? now - since : 0);
    };
    setElapsed(compute());
    const timer = window.setInterval(() => setElapsed(compute()), 1000);
    return () => window.clearInterval(timer);
  }, [turnStartedAt, waitingApproval]);

  const label = waitingApproval ? "等待审批" : localizeProgressLabel(progressText);
  const elapsedSeconds = Math.floor(elapsed / 1000);
  const showLongHint = elapsedSeconds >= LONG_THINKING_THRESHOLD_S;

  const tokenValue =
    typeof sessionUsage?.context_used === "number" &&
    Number.isFinite(sessionUsage.context_used) &&
    sessionUsage.context_used > 0
      ? sessionUsage.context_used
      : undefined;
  const model = progressModel || sessionUsage?.model;

  return (
    <div className={s.progressBlock} role="status" aria-live="polite">
      <span className={s.thinkingDot} />
      <span className={s.thinkingLabel}>
        {label}{showLongHint ? "（耗时较长）" : ""}
      </span>
      {(tokenValue || model) ? (
        <span className={s.thinkingMeta}>
          {tokenValue ? <span>{formatTokens(tokenValue)} tokens</span> : null}
          {tokenValue && model ? <span className={s.thinkingSep}>·</span> : null}
          {model ? <span className={s.thinkingModel}>{truncateMiddle(model, 24)}</span> : null}
        </span>
      ) : null}
      <span className={s.thinkingTimer}>{formatElapsedTimer(elapsed)}</span>
    </div>
  );
}

function ReasoningBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  const translation = useTimelineTranslation();
  // 翻译思考块（design.md 4.35）：展开且已结束时才请求
  const translate = translation.enabled && translation.translateReasoning && !streaming;

  return (
    <div className={s.reasoning}>
      <button
        type="button"
        className={s.disclosure}
        onClick={() => setOpen((value) => !value)}
        data-open={open}
      >
        <span className={s.chevron}>›</span>
        <span>{streaming ? "正在思考" : "推理过程"}</span>
      </button>
      {open ? (
        translate ? (
          <TranslatedReasoningText text={text} className={s.reasoningBody} />
        ) : (
          <pre className={s.reasoningBody}>{text}</pre>
        )
      ) : null}
    </div>
  );
}

function MoaReferenceBlock({
  label,
  text,
  index,
  count,
}: {
  label: string;
  text: string;
  index?: number;
  count?: number;
}) {
  const [open, setOpen] = useState(false);
  const position = index !== undefined && count !== undefined ? `（${index + 1}/${count}）` : "";

  return (
    <div className={s.reasoning}>
      <button
        type="button"
        className={s.disclosure}
        onClick={() => setOpen((value) => !value)}
        data-open={open}
      >
        <span className={s.chevron}>›</span>
        <span>{`参考模型 ${label}${position}`}</span>
      </button>
      {open ? <pre className={s.reasoningBody}>{text}</pre> : null}
    </div>
  );
}

// 系统通知超过此长度默认折叠——后台进程通知（notify_on_complete）会携带
// 完整命令与输出尾部（stream-json 委派动辄数 KB），对 agent 是必要输入，
// 对人只需首行摘要（"后台进程通知：proc_x completed normally (exit 0)"）。
const SYSTEM_NOTICE_COLLAPSE_THRESHOLD = 280;
const SYSTEM_NOTICE_SUMMARY_MAX = 160;

function formatNoticeLength(length: number): string {
  return length > 1000 ? `${(length / 1000).toFixed(1)}k 字符` : `${length} 字符`;
}

function SystemNoticeText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (text.length <= SYSTEM_NOTICE_COLLAPSE_THRESHOLD) {
    return <div className={s.systemNoticeText}>{text}</div>;
  }
  const firstLine = text.split("\n")[0] ?? text;
  const summary =
    firstLine.length > SYSTEM_NOTICE_SUMMARY_MAX
      ? `${firstLine.slice(0, SYSTEM_NOTICE_SUMMARY_MAX)}…`
      : firstLine;
  return (
    <>
      <div className={s.systemNoticeText}>{open ? text : summary}</div>
      <button
        type="button"
        className={s.systemNoticeToggle}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "收起" : `展开全文（${formatNoticeLength(text.length)}）`}
      </button>
    </>
  );
}

function formatToolElapsed(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 100) return "<0.1s";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;

  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** agentdeck 互通工具（design.md 4.26）渲染为委派卡片，其余工具走通用卡片 */
function ToolCard({ tool }: { tool: ChatToolItem }) {
  return tool.delegate ? <DelegateCard tool={tool} /> : <GenericToolCard tool={tool} />;
}

function GenericToolCard({ tool }: { tool: ChatToolItem }) {
  const [open, setOpen] = useState(tool.status === "error");
  const [elapsed, setElapsed] = useState(() =>
    tool.status === "running" ? Math.max(0, Date.now() - tool.startedAt) : 0,
  );

  useEffect(() => {
    if (tool.status === "error") setOpen(true);
  }, [tool.status]);

  useEffect(() => {
    if (tool.status !== "running") return;
    setElapsed(Math.max(0, Date.now() - tool.startedAt));
    const timer = window.setInterval(() => {
      setElapsed(Date.now() - tool.startedAt);
    }, 500);
    return () => window.clearInterval(timer);
  }, [tool.startedAt, tool.status]);

  const elapsedLabel = formatToolElapsed(
    tool.status === "running"
      ? elapsed
      : tool.completedAt
        ? Math.max(0, tool.completedAt - tool.startedAt)
        : undefined,
  );
  const body = tool.error ?? tool.summary ?? tool.preview;
  const hasImages = Boolean(tool.images?.length);
  const subAgent = tool.subAgent;
  const hasBody = Boolean(subAgent || body || tool.arguments || hasImages);

  return (
    <div className={s.toolCard} data-status={tool.status}>
      <button
        type="button"
        className={s.toolHeader}
        onClick={() => setOpen((value) => !value)}
        disabled={!hasBody}
        data-open={open}
      >
        <span className={s.toolStatusDot} data-status={tool.status} />
        <span className={s.toolName}>{tool.name}</span>
        {tool.context ? (
          <span className={s.toolContext} title={tool.context}>
            {truncateMiddle(tool.context)}
          </span>
        ) : null}
        {elapsedLabel ? <span className={s.toolElapsed}>{elapsedLabel}</span> : null}
      </button>
      {open && hasBody && subAgent ? (
        <div className={s.toolBody}>
          <SubAgentToolDetail info={subAgent} status={tool.status} />
          {tool.error ? <pre data-error="true">{tool.error}</pre> : null}
        </div>
      ) : null}
      {open && hasBody && !subAgent ? (
        <div className={s.toolBody}>
          {hasImages ? (
            <div className={s.toolImages}>
              {tool.images!.map((image, index) => (
                <MessageImage
                  key={`${image.url ?? image.name ?? image.alt ?? "image"}-${index}`}
                  image={image}
                />
              ))}
            </div>
          ) : null}
          {tool.arguments ? (
            <pre>{JSON.stringify(tool.arguments, null, 2)}</pre>
          ) : null}
          {body ? <pre data-error={tool.status === "error"}>{body}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}

function ToolGroupCard({ tools }: { tools: ChatToolItem[] }) {
  const [open, setOpen] = useState(false);
  const head = tools[0];
  const elapsedLabel = formatToolElapsed(groupElapsedMs(tools));

  return (
    <div className={s.toolCard} data-status="done">
      <button
        type="button"
        className={s.toolHeader}
        onClick={() => setOpen((value) => !value)}
        data-open={open}
      >
        <span className={s.toolStatusDot} data-status="done" />
        <span className={s.toolName}>{head.name}</span>
        {head.context ? (
          <span className={s.toolContext} title={head.context}>
            {truncateMiddle(head.context)}
          </span>
        ) : null}
        <span className={s.toolBadge}>×{tools.length}</span>
        {elapsedLabel ? <span className={s.toolElapsed}>{elapsedLabel}</span> : null}
      </button>
      {open ? (
        <div className={s.toolGroupBody}>
          {tools.map((tool, index) => (
            <ToolCard key={`${tool.tool_id}-${index}`} tool={tool} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ToolActivity({ tools }: { tools: ChatToolItem[] }) {
  const hasError = tools.some((tool) => tool.status === "error");
  const hasRunning = tools.some((tool) => tool.status === "running");
  const [open, setOpen] = useState(hasError);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (hasError) setOpen(true);
  }, [hasError]);

  useEffect(() => {
    if (!hasRunning) return;
    setNow(Date.now());
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 500);
    return () => window.clearInterval(timer);
  }, [hasRunning]);

  const summary = useMemo(() => summarizeToolActivity(tools, now), [now, tools]);
  const elapsedLabel = formatToolElapsed(summary.elapsedMs);

  return (
    <div className={s.toolActivity} data-status={summary.status}>
      <button
        type="button"
        className={s.toolActivitySummary}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        data-open={open}
      >
        <ChevronRight
          className={s.toolActivityChevron}
          size={16}
          strokeWidth={2.25}
          aria-hidden="true"
        />
        <span className={s.toolStatusDot} data-status={summary.status} />
        <span className={s.toolActivityLabel}>{summary.label}</span>
        {summary.meta ? <span className={s.toolActivityMeta}>{summary.meta}</span> : null}
        {elapsedLabel ? <span className={s.toolElapsed}>{elapsedLabel}</span> : null}
      </button>
      {summary.error && !open ? (
        <div className={s.toolActivityError}>{summary.error}</div>
      ) : null}
      {open ? (
        <div className={s.toolActivityDetails}>
          {groupConsecutiveTools(tools).map((entry, index) =>
            entry.kind === "group" ? (
              <ToolGroupCard key={entry.key} tools={entry.tools} />
            ) : (
              <ToolCard key={`${entry.tool.tool_id}-${index}`} tool={entry.tool} />
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

function ToolChain({ tools }: { tools: ChatToolItem[] }) {
  if (tools.length === 0) return null;
  return (
    <div className={s.toolChain}>
      <ToolActivity tools={tools} />
    </div>
  );
}

interface MessageBlocksProps {
  message: ChatMessage;
  streaming: boolean;
  turnStartedAt?: number;
  sessionUsage?: SessionUsageResult | null;
  progressModel?: string;
}

function MessageBlocks({ message, streaming, turnStartedAt, sessionUsage, progressModel }: MessageBlocksProps) {
  const showReasoning = useAtomValue(showReasoningAtom);
  const translation = useTimelineTranslation();
  const blocks = message.blocks ?? [];
  const items: ReactNode[] = [];
  let pendingTools: ChatToolItem[] = [];

  const flushTools = (key: string) => {
    if (pendingTools.length === 0) return;
    items.push(<ToolChain key={key} tools={pendingTools} />);
    pendingTools = [];
  };

  blocks.forEach((block, index) => {
    if (block.type === "tool") {
      pendingTools.push(block.tool);
      return;
    }

    flushTools(`tools-${index}`);

    if (block.type === "progress") {
      return;
    }

    if (block.type === "text") {
      items.push(
        block.source === "command" ? (
          <div key={`text-${index}`} className={s.turnText}>
            <div className={s.commandOutputLabel}>命令输出</div>
            <pre className={s.commandOutput}>{block.text}</pre>
          </div>
        ) : translation.enabled && !(streaming && index === blocks.length - 1) ? (
          // 已完成的文本块才翻译（design.md 4.35）：消息已结束，或后面已有其它块
          <div key={`text-${index}`} className={s.turnText}>
            <TranslatedMessageText text={block.text} />
          </div>
        ) : (
          <div key={`text-${index}`} className={s.turnText}>
            <MessageText text={block.text} streaming={streaming && index === blocks.length - 1} />
          </div>
        ),
      );
      return;
    }

    if (block.type === "steer") {
      // 运行中插话（design.md 4.22）：当前助手消息流里的内联用户气泡
      items.push(
        <div key={`steer-${index}`} className={s.steerBubble} data-testid="steer-bubble">
          <span className={s.steerLabel}>插话</span>
          <span className={s.steerText}>
            {block.text}
            {block.translatedText ? <SentTranslation text={block.translatedText} /> : null}
          </span>
        </div>,
      );
      return;
    }

    if (block.type === "image") {
      items.push(
        <div key={`image-${index}`} className={s.imageBlock}>
          <MessageImage image={block.image} />
        </div>,
      );
      return;
    }

    if (block.type === "moa_reference") {
      // MoA 参考模型输出块——不受 showReasoning 门控：它是委员会成员的
      // 实际回答（MoA 的核心卖点），不是模型的内心独白；默认折叠不扰。
      items.push(
        <MoaReferenceBlock
          key={`moa-ref-${index}`}
          label={block.label}
          text={block.text}
          index={block.index}
          count={block.count}
        />,
      );
      return;
    }

    if (!showReasoning) return;

    items.push(
      <ReasoningBlock
        key={`reasoning-${index}`}
        text={block.text}
        streaming={streaming && index === blocks.length - 1}
      />,
    );
  });

  flushTools("tools-last");

  if (streaming) {
    const progressPart = blocks?.find((b) => b.type === "progress");
    items.push(
      <ProgressBlock
        key="tail-progress"
        turnStartedAt={turnStartedAt}
        sessionUsage={sessionUsage}
        progressModel={progressModel}
        progressText={progressPart?.type === "progress" ? progressPart.text : undefined}
      />,
    );
  }

  return <>{items}</>;
}

/**
 * 消息有没有可显示的内容。只有思考内容、而思考显示又关着时（失败 / 中断的回合常见）整行不渲染，
 * 否则会留下一行只有时间 / 复制 / TTFT 的空消息；流式进行中仍保留（显示「思考中」进度）。
 */
function hasVisibleContent(message: ChatMessage, showReasoning: boolean): boolean {
  if (message.text || message.images?.length || message.tools?.length) return true;
  if (message.blocks?.some((block) => block.type !== "reasoning")) return true;
  const hasReasoning = Boolean(message.reasoning) || Boolean(message.blocks?.length);
  if (!hasReasoning) return false;
  return showReasoning || message.status === "streaming";
}

function getCopyableText(message: ChatMessage): string | undefined {
  if (message.blocks?.length) {
    const text = message.blocks
      .filter((block) => block.type === "text" || block.type === "reasoning")
      .map((block) => block.text)
      .join("\n\n")
      .trim();
    return text || undefined;
  }
  return message.text || message.reasoning;
}

const FINISH_REASON_LABEL: Record<string, string> = {
  stop: "正常",
  end_turn: "正常",
  length: "上下文截断",
  tool_use: "调用工具",
  tool_calls: "调用工具",
  error: "错误",
  interrupted: "中断",
  content_filter: "内容过滤",
};

function finishReasonRisk(reason: string | undefined): "warn" | "err" | undefined {
  if (!reason) return undefined;
  if (reason === "length" || reason === "content_filter") return "warn";
  if (reason === "error") return "err";
  return undefined;
}

function sessionUsageFallbackStats(
  message: ChatMessage,
  sessionUsage: SessionUsageResult | null | undefined,
): AssistantMessageStats | undefined {
  if (message.role !== "assistant" || message.status === "streaming" || message.status === "error") return undefined;
  if (!sessionUsage) return undefined;

  const stats: AssistantMessageStats = {};
  const tokensInput = sessionUsage.input ?? sessionUsage.prompt;
  const tokensOutput = sessionUsage.output ?? sessionUsage.completion;
  const tokensTotal = sessionUsage.total ?? (
    typeof tokensInput === "number" || typeof tokensOutput === "number"
      ? (tokensInput ?? 0) + (tokensOutput ?? 0)
      : undefined
  );

  if (typeof tokensInput === "number") stats.tokensInput = tokensInput;
  if (typeof tokensOutput === "number") stats.tokensOutput = tokensOutput;
  if (typeof tokensTotal === "number") stats.tokensTotal = tokensTotal;
  if (typeof sessionUsage.cache_read === "number") stats.cacheRead = sessionUsage.cache_read;
  if (typeof sessionUsage.cache_write === "number") stats.cacheWrite = sessionUsage.cache_write;
  if (typeof sessionUsage.calls === "number") stats.apiCalls = sessionUsage.calls;
  if (typeof sessionUsage.model === "string" && sessionUsage.model) stats.model = sessionUsage.model;

  const costStatus = typeof sessionUsage.cost_status === "string"
    ? sessionUsage.cost_status.toLowerCase()
    : undefined;
  if (
    typeof sessionUsage.cost_usd === "number" &&
    Number.isFinite(sessionUsage.cost_usd) &&
    costStatus !== "stale_pricing" &&
    costStatus !== "unknown"
  ) {
    stats.costUsd = sessionUsage.cost_usd;
  }

  return Object.keys(stats).length > 0 ? stats : undefined;
}

function MessageStatsFooter({ stats }: { stats: AssistantMessageStats }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (!wrapRef.current) return;
      if (wrapRef.current.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const inlineParts: string[] = [];
  if (stats.ttftMs !== undefined) inlineParts.push(`TTFT ${formatDurationMs(stats.ttftMs)}`);
  if (stats.durationMs !== undefined) inlineParts.push(formatDurationMs(stats.durationMs));
  if (stats.tokensTotal !== undefined) inlineParts.push(formatTokens(stats.tokensTotal));
  if (stats.tokPerSec !== undefined) inlineParts.push(`${formatTokPerSec(stats.tokPerSec)} tok/s`);

  if (inlineParts.length === 0) return null;

  const risk = finishReasonRisk(stats.finishReason);

  return (
    <span ref={wrapRef} className={s.messageStats} data-risk={risk}>
      <span className={s.messageStatsInline}>
        {inlineParts.map((part, idx) => (
          <span key={idx}>{part}</span>
        ))}
      </span>
      <button
        type="button"
        className={s.messageStatsToggle}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label="查看详细统计"
        title="详细统计"
      >
        <Info size={12} strokeWidth={2} aria-hidden="true" />
      </button>
      {open ? (
        <div className={s.messageStatsPopover} role="dialog">
          <dl>
            {stats.model ? (
              <>
                <dt>模型</dt>
                <dd className={s.messageStatsModel}>{stats.model}</dd>
              </>
            ) : null}
            {stats.tokensInput !== undefined ? (
              <>
                <dt>输入</dt>
                <dd>{formatTokens(stats.tokensInput)}</dd>
              </>
            ) : null}
            {stats.tokensOutput !== undefined ? (
              <>
                <dt>输出</dt>
                <dd>{formatTokens(stats.tokensOutput)}</dd>
              </>
            ) : null}
            {stats.cacheRead !== undefined || stats.cacheWrite !== undefined ? (
              <>
                <dt>缓存</dt>
                <dd>
                  {formatTokens(stats.cacheRead)} 读 / {formatTokens(stats.cacheWrite)} 写
                </dd>
              </>
            ) : null}
            {stats.apiCalls !== undefined ? (
              <>
                <dt>API</dt>
                <dd>{stats.apiCalls} 次调用</dd>
              </>
            ) : null}
            {stats.finishReason ? (
              <>
                <dt>结束</dt>
                <dd data-risk={risk}>
                  {FINISH_REASON_LABEL[stats.finishReason] ?? stats.finishReason}
                </dd>
              </>
            ) : null}
          </dl>
        </div>
      ) : null}
    </span>
  );
}

/** 回合末尾「本回合修改了 N 个文件」小条（design.md 4.24）；回合没有文件变化时不渲染。 */
function TurnSnapshotBar({
  turn,
  compact,
  onOpen,
}: {
  turn: SnapshotTurn | undefined;
  compact: boolean;
  onOpen: (turnId: string) => void;
}) {
  if (!turn) return null;
  return (
    <div className={s.snapshotBar} data-compact={compact ? "true" : undefined}>
      <button type="button" className={s.snapshotBarButton} onClick={() => onOpen(turn.turnId)}>
        <FileDiff size={12} aria-hidden />
        本回合修改了 {turn.changedFiles.length} 个文件
      </button>
    </div>
  );
}

interface MessageBubbleProps {
  message: ChatMessage;
  turnStartedAt?: number;
  sessionUsage?: SessionUsageResult | null;
  progressModel?: string;
  assistantName: string;
  compact?: boolean;
  onRetract?: () => void;
  retractDisabled?: boolean;
  onRetry?: () => void;
  onResend?: () => void;
  resendHint?: string;
  resendDisabled?: boolean;
  onFork?: (seq: number) => void;
}

function MessageBubble({
  message,
  turnStartedAt,
  sessionUsage,
  progressModel,
  assistantName,
  compact = false,
  onRetract,
  retractDisabled = false,
  onRetry,
  onResend,
  resendHint,
  resendDisabled = false,
  onFork,
}: MessageBubbleProps) {
  const showReasoning = useAtomValue(showReasoningAtom);
  const assistantAvatarDataUrl = useAtomValue(assistantAvatarDataUrlAtom);
  const isUser = message.role === "user";
  const isToolOnly = message.role === "tool";
  const isSystem = message.role === "system";
  const streaming = message.status === "streaming";
  const copyable = getCopyableText(message);
  const hasBlocks = !isUser && Boolean(message.blocks?.length);
  const messageStats = message.stats ?? sessionUsageFallbackStats(message, sessionUsage);

  if (isToolOnly) {
    return (
      <div className={s.messageRow} data-role="assistant">
        {/* 与带头像的行保持左缘对齐的占位列。 */}
        {compact ? null : <div className={s.avatarCol} aria-hidden />}
        <div className={s.messageContent}>
          <ToolChain tools={message.tools ?? []} />
        </div>
      </div>
    );
  }

  if (
    isSystem &&
    (message.id.startsWith(AGENT_COMPACTION_NOTICE_PREFIX) ||
      message.id.startsWith(AGENT_TIMELINE_NOTICE_PREFIX))
  ) {
    // 上下文压缩（design.md 4.13）/ 会话分叉等系统提示（4.23）：居中细线分隔，不用告警框
    return (
      <div className={s.messageRow} data-role="system">
        <div className={s.dividerNotice} role="status">
          <span className={s.dividerNoticeText}>{message.text}</span>
        </div>
      </div>
    );
  }

  if (isSystem) {
    const text = message.text || message.reasoning || "";
    return (
      <div className={s.messageRow} data-role="system">
        <div
          className={s.systemNotice}
          data-error={message.error ? "true" : undefined}
          role={message.error ? "alert" : "status"}
        >
          <AlertTriangle
            className={s.systemNoticeIcon}
            size={16}
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <div className={s.systemNoticeBody}>
            {message.error ? <div className={s.systemNoticeTitle}>请求失败</div> : null}
            {message.error ? (
              <div className={s.systemNoticeText}>{text}</div>
            ) : (
              <SystemNoticeText text={text} />
            )}
            {onRetry ? (
              <button
                type="button"
                className={s.retryButton}
                onClick={onRetry}
                disabled={resendDisabled}
                title={resendHint}
              >
                <RotateCcw size={12} aria-hidden />
                重试
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={s.messageRow} data-role={isUser ? "user" : "assistant"}>
      {/* IM 式布局：助手头像独立于气泡左侧一列（点击弹资料卡）；用户侧
          不显示头像与昵称，气泡右贴。 */}
      {!isUser && !compact ? (
        <div className={s.avatarCol}>
          <AssistantProfileCard
            name={assistantName}
            model={progressModel || sessionUsage?.model}
            trigger={
              <button type="button" className={s.avatarButton} title={`查看 ${assistantName} 资料`}>
                {assistantAvatarDataUrl ? (
                  <img
                    className={s.rowAvatar}
                    src={assistantAvatarDataUrl}
                    alt={`${assistantName} 头像`}
                  />
                ) : (
                  <span className={s.rowAvatarInitial} aria-label={`${assistantName} 头像`}>
                    {avatarInitial(assistantName)}
                  </span>
                )}
              </button>
            }
          />
        </div>
      ) : null}
      <div className={s.messageContent}>
        {!isUser && !compact ? (
          <div className={s.assistantName}>
            <span>{assistantName}</span>
          </div>
        ) : null}
        <div className={s.bubble} data-role={isUser ? "user" : "assistant"}>
          {hasBlocks ? (
            <MessageBlocks
              message={message}
              streaming={streaming}
              turnStartedAt={turnStartedAt}
              sessionUsage={sessionUsage}
              progressModel={progressModel}
            />
          ) : (
            <>
              {message.text ? <MessageText text={message.text} streaming={streaming} /> : null}
              {isUser && message.translatedText ? <SentTranslation text={message.translatedText} /> : null}
              {message.images?.length ? (
                <div className={s.messageImages}>
                  {message.images.map((image, index) => (
                    <MessageImage
                      key={`${image.url ?? image.name ?? image.alt ?? "image"}-${index}`}
                      image={image}
                    />
                  ))}
                </div>
              ) : null}
              {showReasoning && message.reasoning ? (
                <ReasoningBlock text={message.reasoning} streaming={streaming && !message.text} />
              ) : null}
              {message.tools?.length ? <ToolChain tools={message.tools} /> : null}
              {streaming ? <ProgressBlock progressModel={progressModel} /> : null}
            </>
          )}
        </div>
        <div className={s.messageActions}>
          <span className={s.messageActionsControls}>
            <span>{formatTime(message.createdAt)}</span>
            {copyable ? (
              <CopyButton text={copyable} showStatusIcon={false}>
                复制
              </CopyButton>
            ) : null}
            {isUser && onRetract ? (
              <button
                type="button"
                className={s.retractButton}
                onClick={onRetract}
                disabled={retractDisabled}
              >
                <Undo2 size={12} aria-hidden />
                撤回
              </button>
            ) : null}
            {isUser && onResend ? (
              <button
                type="button"
                className={s.retractButton}
                onClick={onResend}
                disabled={resendDisabled}
                title={resendHint}
              >
                <RotateCcw size={12} aria-hidden />
                再次发送
              </button>
            ) : null}
            {onFork && message.firstSeq !== undefined && !streaming ? (
              <button
                type="button"
                className={s.retractButton}
                onClick={() => onFork(message.firstSeq!)}
              >
                <GitFork size={12} aria-hidden />
                从这里分叉
              </button>
            ) : null}
          </span>
          {messageStats ? <MessageStatsFooter stats={messageStats} /> : null}
        </div>
      </div>
    </div>
  );
}

export function MessageTimeline({
  messages,
  loading = false,
  statusMessage,
  pendingApproval,
  turnStartedAt,
  sessionUsage,
  progressModel,
  assistantName = ASSISTANT_FALLBACK_NAME,
  density = "default",
  retractMessageId,
  onRetract,
  retractDisabled,
  retryNoticeId,
  onRetry,
  resendMessageId,
  resendHint,
  onResend,
  resendDisabled,
  focusSeq,
  onFork,
  snapshotTurns,
  onOpenSnapshot,
  onReachTop,
  topSlot,
  translation = NO_TRANSLATION,
}: MessageTimelineProps) {
  const compact = density === "compact";
  const messageNodeRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const focusedKeyRef = useRef<string | null>(null);
  const focusTimerRef = useRef<number | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const turnAnchorRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const nearBottomRef = useRef(true);
  const userDetachedFromBottomRef = useRef(false);
  const autoAnchorRef = useRef(false);
  const autoAnchorTimerRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef(0);
  const scrollHeightRef = useRef(0);
  // 程序触发的轮次跳转（平滑滚动）守卫：跳转动画期间 onScroll 会被误判为用户上滑而
  // 触发 detachFromBottomAutoFollow 硬取消滚动，这里用标记把跳转滚动与用户手势区分开。
  const programmaticScrollRef = useRef(false);
  const programmaticTargetRef = useRef(0);
  const programmaticTimerRef = useRef<number | null>(null);
  const messageCountRef = useRef(0);
  const firstMessageIdRef = useRef<string | undefined>(undefined);
  const lastUserMessageIdRef = useRef<string | undefined>(undefined);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const showReasoning = useAtomValue(showReasoningAtom);
  const visibleMessages = useMemo(
    () => messages.filter((message) => hasVisibleContent(message, showReasoning)),
    [messages, showReasoning],
  );
  // 进行中的回合（从最后一条用户消息起）还没结束，不能作为分叉点（design.md 4.23）
  const runningTurnStartIndex = useMemo(() => {
    if (turnStartedAt === undefined) return Number.POSITIVE_INFINITY;
    for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
      if (visibleMessages[index]!.role === "user") return index;
    }
    return 0;
  }, [turnStartedAt, visibleMessages]);
  const turnAnchors = useMemo<TurnAnchor[]>(() => {
    const anchors: TurnAnchor[] = [];
    for (const message of visibleMessages) {
      if (message.role !== "user") continue;
      const index = anchors.length;
      anchors.push({
        id: message.id,
        index,
        title: turnAnchorTitle(message, index),
      });
    }
    return anchors;
  }, [visibleMessages]);
  const showTurnRail = !compact && turnAnchors.length > 1;

  const setTurnAnchorNode = useCallback((id: string, node: HTMLDivElement | null) => {
    if (node) {
      turnAnchorRefs.current.set(id, node);
    } else {
      turnAnchorRefs.current.delete(id);
    }
  }, []);

  const updateActiveTurnFromScroll = useCallback(() => {
    const container = containerRef.current;
    // 轮次导航条只在非 compact 下渲染；compact 下每次滚动遍历全部轮次并 setState 会让整表重渲染。
    if (!container || turnAnchors.length < 2 || compact) return;

    const containerRect = container.getBoundingClientRect();
    const thresholdY = containerRect.top + Math.min(container.clientHeight * 0.35, 180);
    let currentId = turnAnchors[0]?.id ?? null;

    for (const turn of turnAnchors) {
      const node = turnAnchorRefs.current.get(turn.id);
      if (!node) continue;
      if (node.getBoundingClientRect().top <= thresholdY) {
        currentId = turn.id;
      } else {
        break;
      }
    }

    if (currentId) {
      setActiveTurnId((previous) => previous === currentId ? previous : currentId);
    }
  }, [compact, turnAnchors]);

  const scrollToTurn = useCallback((id: string) => {
    const container = containerRef.current;
    const node = turnAnchorRefs.current.get(id);
    if (!container || !node) return;

    if (autoAnchorTimerRef.current !== null) {
      window.clearTimeout(autoAnchorTimerRef.current);
      autoAnchorTimerRef.current = null;
    }
    autoAnchorRef.current = false;

    const containerRect = container.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const top = container.scrollTop + nodeRect.top - containerRect.top - 12;
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const targetTop = Math.min(Math.max(0, top), maxTop);
    nearBottomRef.current = container.scrollHeight - targetTop - container.clientHeight < BOTTOM_FOLLOW_THRESHOLD_PX;
    userDetachedFromBottomRef.current = !nearBottomRef.current;
    // 标记这是一次程序跳转：handleScroll 在到达目标前不得把它当成用户上滑。
    // 兜底定时器防止动画因目标 clamp / 内容重排始终差几像素而无法清除标记。
    programmaticScrollRef.current = true;
    programmaticTargetRef.current = targetTop;
    if (programmaticTimerRef.current !== null) {
      window.clearTimeout(programmaticTimerRef.current);
    }
    programmaticTimerRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
      programmaticTimerRef.current = null;
    }, 700);
    container.scrollTo({ top: targetTop, behavior: "smooth" });
    lastScrollTopRef.current = container.scrollTop;
    setActiveTurnId(id);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto", force = false) => {
    const container = containerRef.current;
    if (!container) return;
    if (force) {
      programmaticScrollRef.current = false;
      if (programmaticTimerRef.current !== null) {
        window.clearTimeout(programmaticTimerRef.current);
        programmaticTimerRef.current = null;
      }
      nearBottomRef.current = true;
      userDetachedFromBottomRef.current = false;
    }
    if (userDetachedFromBottomRef.current) return;
    userDetachedFromBottomRef.current = false;
    nearBottomRef.current = true;
    container.scrollTo({
      top: container.scrollHeight,
      behavior,
    });
    if (behavior === "auto") {
      lastScrollTopRef.current = container.scrollTop;
    }
  }, []);

  const clearAutoAnchor = useCallback(() => {
    if (autoAnchorTimerRef.current !== null) {
      window.clearTimeout(autoAnchorTimerRef.current);
      autoAnchorTimerRef.current = null;
    }
    autoAnchorRef.current = false;
  }, []);

  const detachFromBottomAutoFollow = useCallback(() => {
    const container = containerRef.current;
    // 用户的显式手势（滚轮/拖动）应能中断进行中的轮次跳转并夺回滚动控制。
    programmaticScrollRef.current = false;
    if (programmaticTimerRef.current !== null) {
      window.clearTimeout(programmaticTimerRef.current);
      programmaticTimerRef.current = null;
    }
    clearAutoAnchor();
    userDetachedFromBottomRef.current = true;
    nearBottomRef.current = false;
    if (container) {
      // Cancel any in-flight smooth/initial auto scroll so an explicit user
      // upward gesture cannot be pulled back to the bottom by a later layout
      // settle, ResizeObserver tick, or timeout from the initial history render.
      container.scrollTo({ top: container.scrollTop, behavior: "auto" });
      lastScrollTopRef.current = container.scrollTop;
    }
  }, [clearAutoAnchor]);

  useEffect(() => {
    const knownIds = new Set(turnAnchors.map((turn) => turn.id));
    for (const id of Array.from(turnAnchorRefs.current.keys())) {
      if (!knownIds.has(id)) turnAnchorRefs.current.delete(id);
    }
  }, [turnAnchors]);

  useEffect(() => {
    if (turnAnchors.length < 2) {
      setActiveTurnId((previous) => previous === null ? previous : null);
      return;
    }

    const hasActive = activeTurnId != null && turnAnchors.some((turn) => turn.id === activeTurnId);
    if (hasActive && !nearBottomRef.current) return;

    const lastId = turnAnchors[turnAnchors.length - 1]?.id ?? null;
    setActiveTurnId((previous) => previous === lastId ? previous : lastId);
  }, [activeTurnId, turnAnchors]);

  useIsomorphicLayoutEffect(() => {
    const previousMessageCount = messageCountRef.current;
    const previousFirstMessageId = firstMessageIdRef.current;
    const previousLastUserMessageId = lastUserMessageIdRef.current;
    const nextFirstMessageId = visibleMessages[0]?.id;
    const nextLastUserMessageId = turnAnchors[turnAnchors.length - 1]?.id;
    const firstMessageChanged =
      previousFirstMessageId !== undefined &&
      nextFirstMessageId !== undefined &&
      previousFirstMessageId !== nextFirstMessageId;
    // 首条消息还在列表里 = 在前面插入了更早的历史（手机端向前分页 / 展开窗口），不是换了会话
    const historyPrepended =
      firstMessageChanged && visibleMessages.some((message) => message.id === previousFirstMessageId);
    const sessionChanged = firstMessageChanged && !historyPrepended;
    const forceBottom = shouldForceBottomOnMessageChange(
      previousMessageCount,
      visibleMessages.length,
      sessionChanged,
      previousLastUserMessageId,
      nextLastUserMessageId,
    );

    messageCountRef.current = visibleMessages.length;
    firstMessageIdRef.current = nextFirstMessageId;
    lastUserMessageIdRef.current = nextLastUserMessageId;

    if (visibleMessages.length === 0) {
      nearBottomRef.current = true;
      userDetachedFromBottomRef.current = false;
      lastScrollTopRef.current = 0;
      return;
    }

    if (sessionChanged) {
      nearBottomRef.current = true;
      userDetachedFromBottomRef.current = false;
      lastScrollTopRef.current = 0;
    }

    const container = containerRef.current;
    if (historyPrepended && container && !nearBottomRef.current) {
      // 保持用户正在看的内容不动：scrollTop 补上新增的高度（手机 CSS 关了 overflow-anchor，由这里统一处理）
      container.scrollTop += container.scrollHeight - scrollHeightRef.current;
      lastScrollTopRef.current = container.scrollTop;
    }
    if (!container || (!forceBottom && !nearBottomRef.current)) return;
    const initialHistoryRender = previousMessageCount === 0 || sessionChanged;
    // Bottom-follow must move synchronously. A smooth scroll targets the current
    // scrollHeight, but streaming can grow the message again before the animation
    // arrives; the intermediate scroll event then looks far from the bottom and
    // disables its own ResizeObserver follow-up even though the user never scrolled.
    scrollToBottom("auto", forceBottom);

    // 长会话里 Markdown、表格、代码块等内容会在本次提交后继续改变实际高度。
    // 初次进入历史会话时不要依赖一次平滑滚动，否则 WebKit/Tauri 里可能先滚到
    // 一个尚未稳定的中间位置，用户看到空白，手动滚动后才触发重绘。
    if (initialHistoryRender) {
      clearAutoAnchor();
      autoAnchorRef.current = true;
      window.requestAnimationFrame(() => {
        scrollToBottom("auto");
        window.requestAnimationFrame(() => scrollToBottom("auto"));
      });
      autoAnchorTimerRef.current = window.setTimeout(() => {
        if (userDetachedFromBottomRef.current) {
          autoAnchorRef.current = false;
          autoAnchorTimerRef.current = null;
          return;
        }
        scrollToBottom("auto");
        nearBottomRef.current = true;
        userDetachedFromBottomRef.current = false;
        autoAnchorRef.current = false;
        autoAnchorTimerRef.current = null;
      }, 650);
    }
  }, [clearAutoAnchor, pendingApproval, scrollToBottom, statusMessage, turnAnchors, visibleMessages]);

  // 记录本次提交后的内容高度，供下一次「前插历史」时计算增量
  useIsomorphicLayoutEffect(() => {
    scrollHeightRef.current = containerRef.current?.scrollHeight ?? 0;
  });

  const focusTargetId = useMemo(
    () => (focusSeq ? findMessageIdForSeq(visibleMessages, focusSeq) : undefined),
    [focusSeq, visibleMessages],
  );

  // 全文搜索定位：声明在贴底逻辑之后，同一次提交里先贴底、再脱离贴底并滚动到目标消息。
  useIsomorphicLayoutEffect(() => {
    if (!focusSeq || !focusTargetId) return;
    const key = `${focusSeq}:${focusTargetId}`;
    const container = containerRef.current;
    const node = messageNodeRefs.current.get(focusTargetId);
    if (focusedKeyRef.current === key || !container || !node) return;
    focusedKeyRef.current = key;
    detachFromBottomAutoFollow();
    const align = () => {
      const top = container.scrollTop + node.getBoundingClientRect().top - container.getBoundingClientRect().top - 12;
      container.scrollTo({ top: Math.max(0, top), behavior: "auto" });
      lastScrollTopRef.current = container.scrollTop;
    };
    align();
    // Markdown / 代码块稳定高度后再对齐一次
    window.requestAnimationFrame(align);
    setHighlightId(focusTargetId);
    if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
    focusTimerRef.current = window.setTimeout(() => {
      focusTimerRef.current = null;
      setHighlightId(null);
    }, FOCUS_HIGHLIGHT_MS);
  }, [detachFromBottomAutoFollow, focusSeq, focusTargetId]);

  useEffect(() => () => {
    if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    const messagesElement = messagesRef.current;
    if (!container || !messagesElement || typeof ResizeObserver === "undefined") return;

    let frame = 0;
    const anchorToBottom = () => {
      if (userDetachedFromBottomRef.current) return;
      if (!nearBottomRef.current && !autoAnchorRef.current) return;
      container.scrollTop = container.scrollHeight;
      lastScrollTopRef.current = container.scrollTop;
    };
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(anchorToBottom);
    });
    observer.observe(messagesElement);
    // composer 增高（多行输入 / 技能面板 / 附件托盘 / 上下文告警 / 队列面板等）会让滚动视口
    // 从底部变矮，但 .messages 内容高度不变、上面这个 observer 不会触发，导致最新内容被挤到
    // 视口下沿之外（看起来"藏在输入框后面"）。一并观察滚动容器自身：视口高度变化时也走
    // anchorToBottom 重新贴底——其守卫（userDetached / nearBottom）保证不会把已上滑的用户拽回。
    observer.observe(container);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (autoAnchorTimerRef.current !== null) {
        window.clearTimeout(autoAnchorTimerRef.current);
      }
      if (programmaticTimerRef.current !== null) {
        window.clearTimeout(programmaticTimerRef.current);
      }
    };
  }, []);

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) {
      detachFromBottomAutoFollow();
    }
  };

  const handleScroll = () => {
    const container = containerRef.current;
    if (!container) return;

    // 轮次跳转动画进行中：不要把它当成用户上滑（否则会自取消）。到达目标后解除守卫。
    if (programmaticScrollRef.current) {
      lastScrollTopRef.current = container.scrollTop;
      if (Math.abs(container.scrollTop - programmaticTargetRef.current) <= 2) {
        programmaticScrollRef.current = false;
        if (programmaticTimerRef.current !== null) {
          window.clearTimeout(programmaticTimerRef.current);
          programmaticTimerRef.current = null;
        }
      }
      updateActiveTurnFromScroll();
      return;
    }

    const bottomDistance = distanceFromBottom(container);
    const scrollingUp = shouldDetachOnScroll(
      container.scrollTop,
      lastScrollTopRef.current,
      programmaticScrollRef.current,
    );

    if (scrollingUp) {
      detachFromBottomAutoFollow();
    } else if (autoAnchorRef.current && !userDetachedFromBottomRef.current) {
      nearBottomRef.current = true;
    } else {
      const next = resolveBottomFollowState(
        bottomDistance,
        userDetachedFromBottomRef.current,
      );
      nearBottomRef.current = next.nearBottom;
      userDetachedFromBottomRef.current = next.userDetachedFromBottom;
    }
    lastScrollTopRef.current = container.scrollTop;
    updateActiveTurnFromScroll();
    if (onReachTop && container.scrollTop <= REACH_TOP_THRESHOLD_PX) onReachTop();
  };

  return (
    <WaitingApprovalContext.Provider value={Boolean(pendingApproval)}>
    <TimelineTranslationContext.Provider value={translation}>
    <div
      ref={containerRef}
      className={s.scroll}
      data-density={compact ? "compact" : undefined}
      onWheel={handleWheel}
      onScroll={handleScroll}
      role="log"
      aria-live="polite"
    >
      {showTurnRail ? (
        <div className={s.turnRailWrap}>
          <nav className={s.turnRail} aria-label="对话轮次定位">
            {turnAnchors.map((turn) => {
              const active = turn.id === activeTurnId;
              return (
                <button
                  key={turn.id}
                  type="button"
                  className={s.turnDot}
                  data-active={active ? "true" : undefined}
                  aria-current={active ? "step" : undefined}
                  aria-label={`定位到第 ${turn.index + 1} 轮对话`}
                  title={turn.title}
                  onClick={() => scrollToTurn(turn.id)}
                />
              );
            })}
          </nav>
        </div>
      ) : null}
      <div ref={messagesRef} className={s.messages}>
        {topSlot}
        {loading ? <MessageSkeleton /> : null}
        {!loading && visibleMessages.length === 0 && !statusMessage && !pendingApproval ? (
          <div className={s.empty}>
            <div className={s.emptyTitle}>暂无对话记录</div>
            <div className={s.emptySub}>发送一条消息开始继续这个任务。</div>
          </div>
        ) : null}

        {visibleMessages.map((message, index) => {
          const previous = visibleMessages[index - 1];
          const showDate = !previous || formatDay(previous.createdAt) !== formatDay(message.createdAt);
          const isLast = index === visibleMessages.length - 1;
          const isUserTurn = message.role === "user";
          return (
            <div
              key={message.id}
              ref={(node) => {
                if (node) messageNodeRefs.current.set(message.id, node);
                else messageNodeRefs.current.delete(message.id);
                if (isUserTurn) setTurnAnchorNode(message.id, node);
              }}
              data-turn-anchor={isUserTurn ? "true" : undefined}
              data-focus={highlightId === message.id ? "true" : undefined}
            >
              {showDate ? <div className={s.dateSeparator}>{formatDay(message.createdAt)}</div> : null}
              <MessageBubble
                message={message}
                turnStartedAt={isLast ? turnStartedAt : undefined}
                sessionUsage={isLast ? sessionUsage : undefined}
                progressModel={isLast ? progressModel : undefined}
                assistantName={assistantName}
                compact={compact}
                onRetract={retractMessageId === message.id ? onRetract : undefined}
                retractDisabled={retractDisabled}
                onRetry={retryNoticeId === message.id ? onRetry : undefined}
                onResend={resendMessageId === message.id ? onResend : undefined}
                resendHint={resendHint}
                resendDisabled={resendDisabled}
                onFork={index >= runningTurnStartIndex ? undefined : onFork}
              />
              {onOpenSnapshot && message.role === "assistant" && index < runningTurnStartIndex ? (
                <TurnSnapshotBar
                  turn={snapshotForMessage(snapshotTurns, message.firstSeq)}
                  compact={compact}
                  onOpen={onOpenSnapshot}
                />
              ) : null}
            </div>
          );
        })}

        {statusMessage ? <div className={s.statusMessage}>{statusMessage}</div> : null}
        {pendingApproval}
      </div>
    </div>
    </TimelineTranslationContext.Provider>
    </WaitingApprovalContext.Provider>
  );
}
