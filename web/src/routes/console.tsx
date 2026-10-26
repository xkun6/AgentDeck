import { useMemo, useRef, useState } from "react";
import { ExternalLink, Play, Power, RotateCcw, TerminalSquare } from "lucide-react";
import { StatusDot } from "@agentdeck/shared-ui";
import type { TerminalStartResult } from "@/lib/runtime";
import { readWorkspacePath } from "@/lib/workspaces";
import {
  EmbeddedTerminal,
  type EmbeddedTerminalHandle,
  type TerminalStatus,
} from "@/components/console/embedded-terminal";
import { SectionShell } from "./section-shell";
import s from "./console.module.css";

interface CommandAction {
  label: string;
  command: string;
  desc: string;
}

const QUICK_COMMANDS: CommandAction[] = [
  {
    label: "Claude Code 版本",
    command: "claude --version",
    desc: "确认 Claude Code CLI 已安装并可在终端中调用。",
  },
  {
    label: "Codex 版本",
    command: "codex --version",
    desc: "确认 Codex CLI 已安装并可在终端中调用。",
  },
  {
    label: "Git 状态",
    command: "git status",
    desc: "查看当前目录的分支与未提交改动。",
  },
];

function normalizePath(path?: string | null) {
  if (!path) return "—";
  if (path.length <= 58) return path;
  return `…${path.slice(-55)}`;
}

export function ConsoleRoute() {
  const terminalRef = useRef<EmbeddedTerminalHandle | null>(null);
  const [cwd] = useState(() => readWorkspacePath());
  const [status, setStatus] = useState<TerminalStatus>("starting");
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<TerminalStartResult | null>(null);
  const [lastCommand, setLastCommand] = useState<string | null>(null);
  const [externalOpening, setExternalOpening] = useState(false);
  const [externalOpened, setExternalOpened] = useState<string | null>(null);

  const isExternalTerminalAvailable = Boolean(window.agentdeckDesktop?.terminalOpenExternal);

  const statusText = useMemo(() => {
    if (status === "ready") return "已连接";
    if (status === "starting") return "正在打开终端…";
    if (status === "closed") return "终端已关闭";
    if (status === "unsupported") return "请在桌面端使用";
    return "终端不可用";
  }, [status]);

  const runCommand = (command: string) => {
    if (status !== "ready") return;
    setLastCommand(command);
    terminalRef.current?.runCommand(command);
  };

  const restartTerminal = () => {
    window.location.reload();
  };

  const closeTerminal = () => {
    terminalRef.current?.close();
  };

  const openExternalTerminal = () => {
    if (!window.agentdeckDesktop?.terminalOpenExternal || externalOpening) return;
    setExternalOpening(true);
    setExternalOpened(null);
    setError(null);
    window.agentdeckDesktop
      .terminalOpenExternal({ cwd: session?.cwd || cwd || undefined })
      .then((result) => {
        setExternalOpened(`已在 ${result.terminal} 打开：${result.command}`);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setExternalOpening(false));
  };

  return (
    <SectionShell
      title="终端"
      sub={statusText}
      right={
        <div className={s.topActions}>
          <button
            type="button"
            className={s.secondaryButton}
            onClick={openExternalTerminal}
            disabled={!isExternalTerminalAvailable || externalOpening}
          >
            <ExternalLink size={12} />
            {externalOpening ? "正在打开…" : "在外部终端打开"}
          </button>
          <button type="button" className={s.secondaryButton} onClick={restartTerminal}>
            <RotateCcw size={12} />
            重新打开
          </button>
          <button type="button" className={s.dangerButton} onClick={closeTerminal} disabled={status !== "ready"}>
            <Power size={12} />
            关闭终端
          </button>
        </div>
      }
    >
      <div className={s.layout}>
        <section className={s.mainColumn}>
          <div className={s.summaryStats}>
            <div>
              <span>Shell</span>
              <strong title={session?.shell}>{session?.shell || "—"}</strong>
            </div>
            <div>
              <span>工作目录</span>
              <strong title={session?.cwd}>{normalizePath(session?.cwd)}</strong>
            </div>
          </div>

          <div className={s.terminalCard} data-status={status}>
            <div className={s.terminalHeader}>
              <div className={s.terminalTitle}>
                <TerminalSquare size={16} />
                <span>终端</span>
              </div>
              <div className={s.terminalMeta}>
                <StatusDot
                  tone={status === "ready" ? "success" : status === "starting" ? "warning" : "danger"}
                />
                {statusText}
              </div>
            </div>
            <EmbeddedTerminal
              ref={terminalRef}
              cwd={cwd}
              className={s.terminalSurface}
              onStatusChange={setStatus}
              onSession={setSession}
              onError={setError}
            />
          </div>

          {error && <div className={s.errorBox}>{error}</div>}
          {externalOpened && <div className={s.infoBox}>{externalOpened}</div>}
        </section>

        <aside className={s.sideColumn}>
          <div className={s.panel}>
            <div className={s.panelTitle}>常用操作</div>
            <div className={s.commandList}>
              {QUICK_COMMANDS.map((item) => (
                <button
                  key={item.command}
                  type="button"
                  className={s.commandCard}
                  onClick={() => runCommand(item.command)}
                  disabled={status !== "ready"}
                  data-active={lastCommand === item.command ? "true" : undefined}
                >
                  <span className={s.commandCardHead}>
                    <Play size={12} />
                    {item.label}
                  </span>
                  <code>{item.command}</code>
                  <span>{item.desc}</span>
                </button>
              ))}
            </div>
          </div>

          <div className={s.panel}>
            <div className={s.panelTitle}>提示</div>
            <p className={s.helpText}>
              终端默认在输入框最近选择的工作区中打开；未选择工作区时由系统决定起始目录。
            </p>
          </div>
        </aside>
      </div>
    </SectionShell>
  );
}
