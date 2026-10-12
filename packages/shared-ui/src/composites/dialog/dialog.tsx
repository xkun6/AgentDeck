import { forwardRef } from "react";
import * as RadixDialog from "@radix-ui/react-dialog";
import { cn } from "../../utils/cn";
import s from "./dialog.module.css";

export const Root = RadixDialog.Root;
export const Trigger = RadixDialog.Trigger;
export const Portal = RadixDialog.Portal;
export const Close = RadixDialog.Close;
export const Title = RadixDialog.Title;
export const Description = RadixDialog.Description;

type OverlayProps = React.ComponentPropsWithoutRef<typeof RadixDialog.Overlay>;
export const Overlay = forwardRef<HTMLDivElement, OverlayProps>(
  ({ className, ...rest }, ref) => (
    <RadixDialog.Overlay ref={ref} className={cn(s.overlay, className)} {...rest} />
  ),
);
Overlay.displayName = "HermesDialog.Overlay";

type ContentProps = React.ComponentPropsWithoutRef<typeof RadixDialog.Content>;
export const Content = forwardRef<HTMLDivElement, ContentProps>(
  ({ className, ...rest }, ref) => (
    <RadixDialog.Content ref={ref} className={cn(s.content, className)} {...rest} />
  ),
);
Content.displayName = "HermesDialog.Content";
