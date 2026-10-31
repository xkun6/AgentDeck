// 手机端覆盖层：底部面板（选择器、动作）与居中对话框（二次确认）。
// Android 返回键先关覆盖层再离开页面（见 overlay-history.ts）。
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { openOverlay } from "./overlay-history";
import s from "./mobile.module.css";

const DRAG_DISMISS_PX = 96;
const DRAG_DISMISS_VELOCITY = 0.6;
/** 最后一次移动距松手超过这么久，说明手指已经停住，不算快速下滑 */
const DRAG_FLICK_WINDOW_MS = 100;
const EXIT_MS = 160;

function useBackDismiss(open: boolean, onDismiss: () => void) {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    if (!open) return;
    return openOverlay(() => dismissRef.current());
  }, [open]);
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** 无障碍名称；有 title 时一般相同 */
  label: string;
  title?: string;
  variant?: "sheet" | "dialog";
  children: ReactNode;
}

export function Modal({ open, onClose, label, title, variant = "sheet", children }: ModalProps) {
  const [mounted, setMounted] = useState(open);
  const panelRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startY: number; lastY: number; lastAt: number; velocity: number } | null>(null);
  // 退场动画期间内容保持关闭前的样子：调用方关闭时往往同时清掉了内容依赖的数据
  const shownChildren = useRef(children);
  if (open) shownChildren.current = children;
  useBackDismiss(open, onClose);

  useLayoutEffect(() => {
    if (open) {
      // 拖动关闭留下的位移，退场中被重新打开时要清掉
      panelRef.current?.style.removeProperty("transform");
      setMounted(true);
      return;
    }
    const panel = panelRef.current;
    // 不支持 WAAPI（测试环境）或减弱动效时直接卸载
    if (!mounted || !panel || typeof panel.animate !== "function" || prefersReducedMotion()) {
      setMounted(false);
      return;
    }
    const from = getComputedStyle(panel).transform;
    const to = variant === "sheet" ? "translateY(100%)" : "scale(0.97)";
    const exit = panel.animate(
      [
        { transform: from === "none" ? "none" : from, opacity: 1 },
        { transform: to, opacity: variant === "sheet" ? 1 : 0 },
      ],
      { duration: EXIT_MS, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" },
    );
    const fade = scrimRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: EXIT_MS, fill: "forwards" });
    exit.onfinish = () => setMounted(false);
    return () => {
      exit.cancel();
      fade?.cancel();
    };
  }, [open, mounted, variant]);

  useEffect(() => {
    if (open) panelRef.current?.focus({ preventScroll: true });
  }, [open]);

  if (!open && !mounted) return null;

  const settle = (dismiss: boolean) => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.style.transition = "";
    if (dismiss) {
      onClose();
    } else {
      panel.style.transform = "";
    }
  };

  return createPortal(
    <div
      className={s.modalRoot}
      data-variant={variant}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div ref={scrimRef} className={s.scrim} onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className={s.modalPanel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onClickCapture={(event) => {
          // 退场动画期间面板还在屏幕上，双击的第二下不能再触发选项
          if (open) return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {variant === "sheet" ? (
          <div
            className={s.sheetHandle}
            aria-hidden="true"
            onTouchStart={(event) => {
              const y = event.touches[0]!.clientY;
              drag.current = { startY: y, lastY: y, lastAt: event.timeStamp, velocity: 0 };
              if (panelRef.current) panelRef.current.style.transition = "none";
            }}
            onTouchMove={(event) => {
              const state = drag.current;
              const panel = panelRef.current;
              if (!state || !panel) return;
              const y = event.touches[0]!.clientY;
              state.velocity = (y - state.lastY) / Math.max(event.timeStamp - state.lastAt, 1);
              state.lastY = y;
              state.lastAt = event.timeStamp;
              panel.style.transform = `translateY(${Math.max(0, y - state.startY)}px)`;
            }}
            onTouchEnd={(event) => {
              const state = drag.current;
              drag.current = null;
              if (!state) return;
              const moved = state.lastY - state.startY;
              // 快速下滑要求面板确实往下走过，且松手时手指还在动
              const flicked =
                moved > 0 && event.timeStamp - state.lastAt < DRAG_FLICK_WINDOW_MS && state.velocity > DRAG_DISMISS_VELOCITY;
              settle(moved > DRAG_DISMISS_PX || flicked);
            }}
            onTouchCancel={() => {
              drag.current = null;
              settle(false);
            }}
          >
            <span />
          </div>
        ) : null}
        {title ? <h2 className={s.modalTitle}>{title}</h2> : null}
        <div className={s.modalBody}>{shownChildren.current}</div>
      </div>
    </div>,
    document.body,
  );
}

/** 二次确认对话框：破坏性操作用，操作在右下角 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  danger = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} label={title} title={title} variant="dialog">
      <p className={s.dialogText}>{body}</p>
      <div className={s.dialogActions}>
        <button type="button" className={s.textButton} onClick={onClose}>
          取消
        </button>
        <button type="button" className={s.textButton} data-danger={danger ? "true" : undefined} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
