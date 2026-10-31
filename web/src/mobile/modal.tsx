// 手机端覆盖层：底部面板（选择器、动作）与居中对话框（二次确认）。
// Android 返回键先关覆盖层再离开页面：打开时压一条同地址的 history，关闭时退掉它。
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import s from "./mobile.module.css";

const DRAG_DISMISS_PX = 96;
const DRAG_DISMISS_VELOCITY = 0.6;
const EXIT_MS = 160;

// 关闭后推迟一拍再退 history：下一个覆盖层紧接着打开时（含 StrictMode 的重复 effect）直接复用这条记录，
// 否则异步的 back 会落在新记录之后，把刚打开的覆盖层当成被返回键关掉
let pendingBack: ReturnType<typeof setTimeout> | null = null;
// 自己发起、还没落地的 back：它们的 popstate 不是用户按了返回键，不能关掉此时打开的覆盖层
let ownBacks = 0;
let ownBackInFlight = false;
let trackingOwnBacks = false;

function trackOwnBacks() {
  if (trackingOwnBacks) return;
  trackingOwnBacks = true;
  // 先于各覆盖层的监听注册，所以先执行
  window.addEventListener("popstate", () => {
    ownBackInFlight = ownBacks > 0;
    if (ownBackInFlight) ownBacks -= 1;
  });
}

function useBackDismiss(open: boolean, onDismiss: () => void) {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    if (!open) return;
    trackOwnBacks();
    if (pendingBack !== null) {
      clearTimeout(pendingBack);
      pendingBack = null;
    } else {
      window.history.pushState(window.history.state, "", window.location.href);
    }
    const hash = window.location.hash;
    let popped = false;
    const onPop = () => {
      if (ownBackInFlight) return;
      popped = true;
      dismissRef.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (popped) return;
      pendingBack = setTimeout(() => {
        pendingBack = null;
        // 关闭的同时已经导航走了：退 history 会撤销那次导航
        if (window.location.hash === hash) {
          ownBacks += 1;
          window.history.back();
        }
      }, 0);
    };
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
  useBackDismiss(open, onClose);

  useLayoutEffect(() => {
    if (open) {
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
    scrimRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: EXIT_MS, fill: "forwards" });
    exit.onfinish = () => setMounted(false);
    return () => exit.cancel();
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
            onTouchEnd={() => {
              const state = drag.current;
              drag.current = null;
              if (state) {
                settle(state.lastY - state.startY > DRAG_DISMISS_PX || state.velocity > DRAG_DISMISS_VELOCITY);
              }
            }}
          >
            <span />
          </div>
        ) : null}
        {title ? <h2 className={s.modalTitle}>{title}</h2> : null}
        <div className={s.modalBody}>{children}</div>
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
