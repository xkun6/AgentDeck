import { forwardRef } from "react";
import * as RadixContextMenu from "@radix-ui/react-context-menu";
import { cn } from "../../utils/cn";
import s from "./context-menu.module.css";

export const Root = RadixContextMenu.Root;
export const Trigger = RadixContextMenu.Trigger;
export const Portal = RadixContextMenu.Portal;

type ContentProps = React.ComponentPropsWithoutRef<typeof RadixContextMenu.Content>;
export const Content = forwardRef<HTMLDivElement, ContentProps>(
  ({ className, collisionPadding = 8, ...rest }, ref) => (
    <RadixContextMenu.Content
      ref={ref}
      className={cn(s.content, className)}
      collisionPadding={collisionPadding}
      {...rest}
    />
  ),
);
Content.displayName = "HermesContextMenu.Content";

type ItemProps = React.ComponentPropsWithoutRef<typeof RadixContextMenu.Item> & {
  /** 危险项（红色）。 */
  danger?: boolean;
};
export const Item = forwardRef<HTMLDivElement, ItemProps>(
  ({ className, danger, ...rest }, ref) => (
    <RadixContextMenu.Item
      ref={ref}
      className={cn(s.item, className)}
      data-tone={danger ? "danger" : undefined}
      {...rest}
    />
  ),
);
Item.displayName = "HermesContextMenu.Item";

type SeparatorProps = React.ComponentPropsWithoutRef<typeof RadixContextMenu.Separator>;
export const Separator = forwardRef<HTMLDivElement, SeparatorProps>(
  ({ className, ...rest }, ref) => (
    <RadixContextMenu.Separator ref={ref} className={cn(s.separator, className)} {...rest} />
  ),
);
Separator.displayName = "HermesContextMenu.Separator";
