// 输入框工具栏的「chip 式」下拉选择：图标 + 当前值 + 下拉箭头，菜单用 shared-ui Popover。
// 标签（Agent / 模型 / 模式）不常驻显示，放进 aria-label、tooltip 与菜单标题。
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Popover } from "@agentdeck/shared-ui";
import s from "./chip-select.module.css";

export interface ChipSelectOption {
  /** 空字符串表示「默认」项 */
  value: string;
  label: string;
  /** 次要文字：描述，或不可用原因 */
  description?: string;
  /** 名称后的小标记，如「默认」「危险」 */
  badge?: string;
  disabled?: boolean;
  danger?: boolean;
}

export interface ChipSelectProps {
  /** 字段名：Agent / 模型 / 模式 */
  label: string;
  /** tooltip 里的补充说明 */
  hint?: string;
  icon: ReactNode;
  value: string;
  /** chip 上显示的当前值 */
  displayValue: string;
  options: ChipSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  danger?: boolean;
}

function nextEnabled(options: ChipSelectOption[], from: number, step: 1 | -1): number {
  for (let index = from + step; index >= 0 && index < options.length; index += step) {
    if (!options[index]?.disabled) return index;
  }
  return from;
}

function initialActive(options: ChipSelectOption[], value: string): number {
  const selected = options.findIndex((option) => option.value === value && !option.disabled);
  if (selected >= 0) return selected;
  return options.findIndex((option) => !option.disabled);
}

export function ChipSelect({
  label,
  hint,
  icon,
  value,
  displayValue,
  options,
  onChange,
  disabled,
  danger,
}: ChipSelectProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open || active < 0) return;
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
    // optionId 只依赖稳定的 baseId
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  const onOpenChange = (next: boolean) => {
    if (next) setActive(initialActive(options, value));
    setOpen(next);
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    onOpenChange(true);
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive((current) => (current < 0 ? initialActive(options, value) : nextEnabled(options, current, 1)));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActive((current) => (current < 0 ? initialActive(options, value) : nextEnabled(options, current, -1)));
        break;
      case "Home":
        event.preventDefault();
        setActive(nextEnabled(options, -1, 1));
        break;
      case "End":
        event.preventDefault();
        setActive(nextEnabled(options, options.length, -1));
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        choose(active);
        break;
      default:
        break;
    }
  };

  const tooltip = `${label}：${displayValue}${hint ? `\n${hint}` : ""}`;

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={s.chip}
          aria-label={`${label}：${displayValue}`}
          aria-haspopup="listbox"
          title={tooltip}
          disabled={disabled}
          data-danger={danger ? "true" : undefined}
          onKeyDown={onTriggerKeyDown}
        >
          <span className={s.icon} aria-hidden="true">
            {icon}
          </span>
          <span className={s.value}>{displayValue}</span>
          <ChevronDown className={s.caret} aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={s.menu}
          side="bottom"
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            listRef.current?.focus();
          }}
        >
          <div className={s.menuTitle} id={titleId}>
            {label}
          </div>
          <div
            ref={listRef}
            className={s.list}
            role="listbox"
            aria-labelledby={titleId}
            aria-activedescendant={active >= 0 ? optionId(active) : undefined}
            tabIndex={0}
            onKeyDown={onListKeyDown}
          >
            {options.map((option, index) => {
              const selected = option.value === value;
              return (
                <div
                  key={option.value || "__default__"}
                  id={optionId(index)}
                  className={s.option}
                  role="option"
                  aria-selected={selected}
                  aria-disabled={option.disabled ? true : undefined}
                  data-active={index === active ? "true" : undefined}
                  data-danger={option.danger ? "true" : undefined}
                  onMouseEnter={() => {
                    if (!option.disabled) setActive(index);
                  }}
                  onClick={() => choose(index)}
                >
                  <span className={s.check} aria-hidden="true">
                    {selected ? <Check /> : null}
                  </span>
                  <span className={s.optionText}>
                    <span className={s.optionLabel}>
                      <span className={s.optionName}>{option.label}</span>
                      {option.badge ? <span className={s.badge}>{option.badge}</span> : null}
                    </span>
                    {option.description ? (
                      <span className={s.optionDescription}>{option.description}</span>
                    ) : null}
                  </span>
                </div>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
