// 手机端通用列表行：设置项、表单项、动作项共用，单行或双行，贴边铺满。
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import s from "./mobile.module.css";

export function ListRow({
  icon,
  title,
  supporting,
  trailing,
  chevron = false,
  danger = false,
  disabled = false,
  role,
  "aria-checked": ariaChecked,
  onClick,
}: {
  icon?: ReactNode;
  title: ReactNode;
  supporting?: ReactNode;
  trailing?: ReactNode;
  chevron?: boolean;
  danger?: boolean;
  disabled?: boolean;
  role?: string;
  "aria-checked"?: boolean;
  onClick?: () => void;
}) {
  const content = (
    <>
      {icon ? <span className={s.listIcon}>{icon}</span> : null}
      <span className={s.listText}>
        <span className={s.listTitle}>{title}</span>
        {supporting ? <span className={s.listSupporting}>{supporting}</span> : null}
      </span>
      {trailing}
      {chevron ? <ChevronRight className={s.listChevron} aria-hidden="true" /> : null}
    </>
  );
  if (!onClick) {
    return (
      <div className={s.listRow} data-danger={danger ? "true" : undefined}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={s.listRow}
      role={role}
      aria-checked={ariaChecked}
      data-danger={danger ? "true" : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {content}
    </button>
  );
}

export function SwitchRow({
  icon,
  title,
  supporting,
  checked,
  disabled = false,
  onChange,
}: {
  icon?: ReactNode;
  title: string;
  supporting?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={s.listRow}>
      {icon ? <span className={s.listIcon}>{icon}</span> : null}
      <span className={s.listText}>
        <span className={s.listTitle}>{title}</span>
        {supporting ? <span className={s.listSupporting}>{supporting}</span> : null}
      </span>
      <input
        type="checkbox"
        role="switch"
        className={s.switch}
        aria-label={title}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

/** 列表分组：小标题 + 一组贴边的行 */
export function ListSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className={s.listSection} aria-label={title}>
      {title ? <h2 className={s.sectionTitle}>{title}</h2> : null}
      {children}
    </section>
  );
}
