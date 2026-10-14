// 设置页「连接诊断」：显示最近的连接事件（时间 + 事件 + 触发路径 + code），可复制全部（含完整字段的 JSON）或清空。
// 数据来自 lib/connection-log.ts 的环形缓冲（最多 100 条，持久化到 localStorage），用来事后定位「总在重连」的原因。
import { useRef, useState, useSyncExternalStore } from "react";
import { formatConnectionLogLine, getMobileConnectionLog, type ConnectionEventLog } from "@/lib/connection-log";
import s from "./mobile.module.css";

/** 设置页最多展示的条数（最新在上） */
export const DIAGNOSTICS_VISIBLE = 20;

export function ConnectionDiagnosticsSection({ log = getMobileConnectionLog() }: { log?: ConnectionEventLog }) {
  const entries = useSyncExternalStore(log.subscribe, log.getSnapshot);
  const [fallbackText, setFallbackText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const visible = entries.slice(-DIAGNOSTICS_VISIBLE).reverse();

  const copyAll = async () => {
    const text = JSON.stringify(entries, null, 1);
    try {
      await navigator.clipboard.writeText(text);
      setFallbackText(null);
      setCopied(true);
    } catch {
      // 剪贴板不可用（非安全上下文 / 权限被拒）：展示文本框并全选，让用户手动复制
      setCopied(false);
      setFallbackText(text);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.select();
      });
    }
  };

  return (
    <section className={s.section} aria-label="连接诊断">
      <h2 className={s.sectionTitle}>连接诊断</h2>
      <div className={s.hint}>
        记录最近的连接、断线、探活与重连事件（共 {entries.length} 条，仅显示最近 {DIAGNOSTICS_VISIBLE} 条）。遇到「总在重连」时，复制全部发给开发者。
      </div>
      {visible.length > 0 ? (
        <ul className={s.diagList} aria-label="连接事件">
          {visible.map((entry, index) => (
            <li key={`${entry.at}-${index}`} className={s.diagLine}>
              {formatConnectionLogLine(entry)}
            </li>
          ))}
        </ul>
      ) : (
        <div className={s.hint}>暂无记录</div>
      )}
      <div className={s.diagActions}>
        <button type="button" className={s.secondaryButton} disabled={entries.length === 0} onClick={() => void copyAll()}>
          {copied ? "已复制" : "复制全部"}
        </button>
        <button
          type="button"
          className={s.secondaryButton}
          disabled={entries.length === 0}
          onClick={() => {
            log.clear();
            setFallbackText(null);
            setCopied(false);
          }}
        >
          清空
        </button>
      </div>
      {fallbackText !== null ? (
        <textarea
          ref={textareaRef}
          className={s.pasteArea}
          aria-label="连接诊断全文"
          readOnly
          value={fallbackText}
          onFocus={(event) => event.currentTarget.select()}
        />
      ) : null}
    </section>
  );
}
