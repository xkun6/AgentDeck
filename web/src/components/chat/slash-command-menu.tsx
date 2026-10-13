// 输入框斜杠命令补全：查询解析、过滤排序与浮在输入框上方的候选菜单（由 GooseComposer 驱动）。
import { useEffect, type MouseEvent } from "react";
import type { ComposerSlashCommand } from "./composer-types";
import s from "./slash-command-menu.module.css";

/** 菜单最多渲染的条数。 */
export const SLASH_MENU_LIMIT = 50;

/**
 * 输入内容以 `/` 开头且光标位于首个空白字符之前（正在输入首个 token）时，返回 `/` 之后的查询串；
 * 否则返回 null（不打开菜单）。
 */
export function slashQueryFromInput(value: string, caret: number): string | null {
  if (!value.startsWith("/")) return null;
  const firstSpace = value.search(/\s/);
  const end = firstSpace === -1 ? value.length : firstSpace;
  if (caret > end) return null;
  return value.slice(1, end);
}

/**
 * 不区分大小写过滤：name 前缀匹配排前，其次 aliases 前缀、name 包含；同组保持原顺序；空查询返回全部。
 */
export function filterSlashCommands<T extends Pick<ComposerSlashCommand, "name" | "aliases">>(
  commands: readonly T[],
  query: string,
): T[] {
  const needle = query.toLowerCase();
  if (!needle) return commands.slice();
  const byName: T[] = [];
  const byAlias: T[] = [];
  const byContains: T[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (name.startsWith(needle)) byName.push(command);
    else if (command.aliases?.some((alias) => alias.toLowerCase().startsWith(needle))) byAlias.push(command);
    else if (name.includes(needle)) byContains.push(command);
  }
  return [...byName, ...byAlias, ...byContains];
}

export function slashOptionId(menuId: string, index: number): string {
  return `${menuId}-option-${index}`;
}

interface SlashCommandMenuProps {
  id: string;
  commands: ComposerSlashCommand[];
  activeIndex: number;
  onSelect: (command: ComposerSlashCommand) => void;
  onActiveIndexChange: (index: number) => void;
}

export function SlashCommandMenu({ id, commands, activeIndex, onSelect, onActiveIndexChange }: SlashCommandMenuProps) {
  // 键盘移动高亮时把高亮项滚入视野（jsdom 没有 scrollIntoView）
  useEffect(() => {
    document.getElementById(slashOptionId(id, activeIndex))?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, id]);

  // 按下鼠标不让输入框失焦（失焦会先关闭菜单，点击就落空了）
  const keepFocus = (event: MouseEvent) => event.preventDefault();

  return (
    <div className={s.menu} id={id} role="listbox" aria-label="斜杠命令" onMouseDown={keepFocus}>
      {commands.map((command, index) => (
        <div
          key={`${index}:${command.name}`}
          id={slashOptionId(id, index)}
          className={s.item}
          role="option"
          aria-selected={index === activeIndex}
          title={command.description}
          onMouseEnter={() => onActiveIndexChange(index)}
          onClick={() => onSelect(command)}
        >
          <span className={s.name}>/{command.name}</span>
          {command.argumentHint ? <span className={s.argumentHint}>{command.argumentHint}</span> : null}
          {command.badge ? <span className={s.badge}>{command.badge}</span> : null}
          {command.description ? <span className={s.description}>{command.description}</span> : null}
        </div>
      ))}
    </div>
  );
}
