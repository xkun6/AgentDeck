// 通用右键菜单：包住一个行元素，右键时弹出由 items() 描述的菜单。
// items 是函数，仅在菜单打开时求值，避免每行每次渲染都构造菜单项。
import type { ReactNode } from "react";
import { ContextMenu } from "@agentdeck/shared-ui";

export type ContextMenuEntry =
  | { type: "separator"; key: string }
  | {
      type?: "item";
      key: string;
      label: string;
      icon?: ReactNode;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    };

interface EntityContextMenuProps {
  items: () => ContextMenuEntry[];
  children: ReactNode;
}

function MenuItems({ items }: { items: () => ContextMenuEntry[] }) {
  return (
    <>
      {items().map((entry) =>
        entry.type === "separator" ? (
          <ContextMenu.Separator key={entry.key} />
        ) : (
          <ContextMenu.Item
            key={entry.key}
            danger={entry.danger}
            disabled={entry.disabled}
            // 延后到菜单关闭后再执行：否则菜单的焦点锁与随后弹出的确认框焦点锁会互相抢焦点。
            onSelect={() => {
              window.setTimeout(entry.onSelect, 0);
            }}
          >
            {entry.icon}
            {entry.label}
          </ContextMenu.Item>
        ),
      )}
    </>
  );
}

export function EntityContextMenu({ items, children }: EntityContextMenuProps) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content onClick={(event) => event.stopPropagation()}>
          <MenuItems items={items} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
