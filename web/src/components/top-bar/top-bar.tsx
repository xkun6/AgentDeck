import { forwardRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAtomValue } from "jotai";
import { Button, cn, type ButtonProps } from "@agentdeck/shared-ui";
import { pageHeaderSlotAtom } from "./page-header-slot";
import s from "./top-bar.module.css";

interface TopBarProps {
  title?: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
}

type TopBarActionButtonProps = Omit<ButtonProps, "size">;

/** 页面标题与操作：渲染进外壳主区的标题行（与窗口按钮同一行）；没有外壳时原地渲染。 */
export function TopBar({ title, sub, right }: TopBarProps) {
  const slot = useAtomValue(pageHeaderSlotAtom);
  const content = (
    <div className={s.topBar}>
      <div className={s.titleGroup}>
        {title && <h1 className={s.title}>{title}</h1>}
        {sub && <span className={s.sub}>{sub}</span>}
      </div>
      <span className={s.spacer} />
      {right && <div className={s.actions}>{right}</div>}
    </div>
  );
  return slot ? createPortal(content, slot) : content;
}

export const TopBarActionButton = forwardRef<HTMLButtonElement, TopBarActionButtonProps>(
  function TopBarActionButton(
    { className, type = "button", variant = "plain", ...props },
    ref,
  ) {
    return (
      <Button
        {...props}
        ref={ref}
        type={type}
        variant={variant}
        size="sm"
        className={cn(s.chip, className)}
      />
    );
  },
);

export function TopBarActions() {
  return null;
}
