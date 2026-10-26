import { ArrowUp } from "lucide-react";
import s from "./goose-composer.module.css";

export function SendIcon() {
  return <ArrowUp className={s.sendIcon} strokeWidth={2.2} aria-hidden="true" />;
}

export function StopIcon() {
  return (
    <svg
      className={s.sendIcon}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <rect x="7" y="7" width="10" height="10" fill="currentColor" rx="2" />
    </svg>
  );
}
