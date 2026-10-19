// 翻译显示（design.md 4.35）：助手文本 / 思考的译文与「显示原文」切换，用户消息的已发送译文。
// 翻译请求只走 use-agent-session（translation.translate），sidecar 侧有磁盘缓存。
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { TranslationDirection } from "@agentdeck/protocol";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import { MessageText } from "./message-text";
import s from "./translated-text.module.css";

export interface TimelineTranslation {
  /** 会话开启了翻译 */
  enabled: boolean;
  /** 思考块也翻译（展开时才请求） */
  translateReasoning: boolean;
}

export const TimelineTranslationContext = createContext<TimelineTranslation>({
  enabled: false,
  translateReasoning: false,
});

export function useTimelineTranslation(): TimelineTranslation {
  return useContext(TimelineTranslationContext);
}

/** 本页内的结果缓存，避免滚动 / 重渲染时重复请求；sidecar 另有磁盘缓存 */
const RESULT_CACHE_MAX = 500;
const results = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

function remember(key: string, value: string): void {
  results.delete(key);
  results.set(key, value);
  while (results.size > RESULT_CACHE_MAX) {
    const oldest = results.keys().next().value;
    if (oldest === undefined) break;
    results.delete(oldest);
  }
}

type DisplayTranslation =
  | { status: "idle" | "pending" }
  | { status: "done"; text: string }
  | { status: "error"; error: string };

export function useDisplayTranslation(
  text: string,
  direction: TranslationDirection,
  enabled: boolean,
): DisplayTranslation & { retry: () => void } {
  const actions = useAgentSession();
  const key = `${direction}\n${text}`;
  const [failure, setFailure] = useState<{ key: string; error: string } | null>(null);
  const [, setVersion] = useState(0);
  const [nonce, setNonce] = useState(0);
  const retry = () => {
    setFailure(null);
    setNonce((value) => value + 1);
  };

  const failed = failure?.key === key;

  useEffect(() => {
    // 失败后停在错误状态，只由「重试」重新请求
    if (!enabled || failed || results.has(key)) return;
    let cancelled = false;
    let request = inflight.get(key);
    if (!request) {
      request = actions
        .translateText(direction, text)
        .then((translated) => {
          remember(key, translated);
          return translated;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, request);
    }
    request.then(
      () => {
        if (!cancelled) setVersion((value) => value + 1);
      },
      (error: unknown) => {
        if (!cancelled) setFailure({ key, error: humanizeSidecarError(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [actions, direction, text, key, enabled, failed, nonce]);

  if (!enabled) return { status: "idle", retry };
  const cached = results.get(key);
  if (cached !== undefined) return { status: "done", text: cached, retry };
  if (failed) return { status: "error", error: failure.error, retry };
  return { status: "pending", retry };
}

/** 译文与原文实质相同（原文已是目标语言）时不显示切换 */
function distinctTranslation(original: string, translation: DisplayTranslation): string | undefined {
  return translation.status === "done" && translation.text.trim() !== original.trim()
    ? translation.text
    : undefined;
}

function TranslationBar({
  translation,
  translated,
  showOriginal,
  onToggle,
}: {
  translation: DisplayTranslation & { retry: () => void };
  translated: string | undefined;
  showOriginal: boolean;
  onToggle: () => void;
}) {
  if (translation.status === "pending") {
    return <div className={s.bar}>翻译中…</div>;
  }
  if (translation.status === "error") {
    return (
      <div className={s.bar} data-tone="error">
        <span className={s.error}>翻译失败：{translation.error}</span>
        <button type="button" className={s.action} onClick={translation.retry}>
          重试
        </button>
      </div>
    );
  }
  if (!translated) return null;
  return (
    <div className={s.bar}>
      <button type="button" className={s.action} onClick={onToggle}>
        {showOriginal ? "显示译文" : "显示原文"}
      </button>
    </div>
  );
}

/**
 * 元素进入可见区域（上下预留 200px）后返回 true 并保持；环境没有 IntersectionObserver 时直接视为可见。
 * 用于只翻译看得到的内容，打开长会话不会一次翻译全部历史。
 */
function useSeenOnce(): [(node: Element | null) => void, boolean] {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  const observerRef = useRef<IntersectionObserver | null>(null);
  const ref = useCallback(
    (node: Element | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!node || seen) return;
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            observer.disconnect();
            setSeen(true);
          }
        },
        { rootMargin: "200px 0px" },
      );
      observer.observe(node);
      observerRef.current = observer;
    },
    [seen],
  );
  useEffect(() => () => observerRef.current?.disconnect(), []);
  return [ref, seen];
}

/** 已完成的助手文本块：进入可见区域后请求翻译，译文就绪后替换显示（Markdown） */
export function TranslatedMessageText({ text }: { text: string }) {
  const [ref, seen] = useSeenOnce();
  const translation = useDisplayTranslation(text, "agent-to-user", seen);
  const [showOriginal, setShowOriginal] = useState(false);
  const translated = distinctTranslation(text, translation);
  return (
    <div ref={ref}>
      <MessageText text={translated && !showOriginal ? translated : text} />
      <TranslationBar
        translation={translation}
        translated={translated}
        showOriginal={showOriginal}
        onToggle={() => setShowOriginal((value) => !value)}
      />
    </div>
  );
}

/** 短文本（提问卡题目 / 选项等）：会话开启翻译时显示译文，悬停显示原文；未就绪或失败显示原文 */
export function TranslatedInline({ text }: { text: string }) {
  const { enabled } = useTimelineTranslation();
  return enabled && text.trim().length > 0 ? <InlineTranslation text={text} /> : <>{text}</>;
}

function InlineTranslation({ text }: { text: string }) {
  const translated = distinctTranslation(text, useDisplayTranslation(text, "agent-to-user", true));
  return translated ? <span title={text}>{translated}</span> : <>{text}</>;
}

/** 展开后的思考块正文：纯文本，样式由调用方的 className 决定 */
export function TranslatedReasoningText({ text, className }: { text: string; className: string }) {
  const translation = useDisplayTranslation(text, "agent-to-user", true);
  const [showOriginal, setShowOriginal] = useState(false);
  const translated = distinctTranslation(text, translation);
  return (
    <>
      <pre className={className}>{translated && !showOriginal ? translated : text}</pre>
      <TranslationBar
        translation={translation}
        translated={translated}
        showOriginal={showOriginal}
        onToggle={() => setShowOriginal((value) => !value)}
      />
    </>
  );
}

/** 用户消息 / 插话实际发给 Agent 的译文：默认折叠 */
export function SentTranslation({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={s.sent}>
      <button type="button" className={s.action} onClick={() => setOpen((value) => !value)}>
        {open ? "收起译文" : "查看发送的译文"}
      </button>
      {open ? <div className={s.sentText}>{text}</div> : null}
    </div>
  );
}
