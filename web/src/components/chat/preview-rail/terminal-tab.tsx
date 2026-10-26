import { EmbeddedTerminal } from "@/components/console/embedded-terminal";
import s from "./preview-rail.module.css";

// Reuses the shared xterm widget. Mounting/unmounting with the tab means a
// fresh terminal each time the tab is opened, which is fine for the rail.
// 终端在会话的工作目录里启动；没有工作目录时由桌面端回退到用户目录。
export function TerminalTab({ cwd }: { cwd: string }) {
  if (!window.agentdeckDesktop?.terminalStart) {
    return <div className={s.empty}>终端需要在桌面端中使用。</div>;
  }
  return <EmbeddedTerminal className={s.terminalSurface} cwd={cwd} />;
}
