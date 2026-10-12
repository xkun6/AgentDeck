import { forwardRef } from "react";
import * as RadixPopover from "@radix-ui/react-popover";
import { cn } from "../../utils/cn";
import s from "./popover.module.css";

export const Root = RadixPopover.Root;
export const Trigger = RadixPopover.Trigger;
export const Anchor = RadixPopover.Anchor;
export const Portal = RadixPopover.Portal;
export const Close = RadixPopover.Close;

type ContentProps = React.ComponentPropsWithoutRef<typeof RadixPopover.Content>;
export const Content = forwardRef<HTMLDivElement, ContentProps>(
  ({ className, sideOffset = 6, collisionPadding = 8, ...rest }, ref) => (
    <RadixPopover.Content
      ref={ref}
      className={cn(s.content, className)}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      {...rest}
    />
  ),
);
Content.displayName = "HermesPopover.Content";

type ArrowProps = React.ComponentPropsWithoutRef<typeof RadixPopover.Arrow>;
export const Arrow = forwardRef<SVGSVGElement, ArrowProps>(
  ({ className, ...rest }, ref) => (
    <RadixPopover.Arrow ref={ref} className={cn(s.arrow, className)} {...rest} />
  ),
);
Arrow.displayName = "HermesPopover.Arrow";
