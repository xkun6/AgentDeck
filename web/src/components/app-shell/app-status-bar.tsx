import { useMemo } from "react";
import { useAtomValue } from "jotai";
import { useLocation } from "react-router-dom";
import { StatusDot, type StatusDotTone } from "@agentdeck/shared-ui";
import { chatRuntimeBySessionAtom } from "@/stores/chat";
import { agentListAtom, agentSnapshotsAtom, sidecarConnectionAtom } from "@/stores/agents";
import { useAgentProviders } from "@/hooks/use-agent-catalog";
import { agentProviderLabel, isAgentRunning } from "@/lib/agent-session-display";
import { BUILD_COMMIT, DESKTOP_VERSION, UNKNOWN_VALUE, versionLabel } from "@/lib/build-info";
import type { SidecarConnectionState } from "@/lib/sidecar-client";
import s from "./app-status-bar.module.css";

const CONNECTION_LABELS: Record<SidecarConnectionState, string> = {
  idle: "未连接",
  connecting: "连接中",
  open: "已连接",
  closed: "已断开",
  error: "连接失败",
};

const CONNECTION_TONES: Record<SidecarConnectionState, StatusDotTone> = {
  idle: "warning",
  connecting: "warning",
  open: "success",
  closed: "danger",
  error: "danger",
};

function shortCommit(commit: string | undefined): string {
  const normalized = commit?.trim() ?? "";
  if (!normalized || normalized === "unknown") return UNKNOWN_VALUE;
  return normalized.slice(0, 4);
}

function activeTaskId(pathname: string): string | null {
  if (!pathname.startsWith("/tasks/")) return null;
  try {
    return decodeURIComponent(pathname.slice("/tasks/".length));
  } catch {
    return null;
  }
}

export function AppStatusBar() {
  const { pathname } = useLocation();
  const connection = useAtomValue(sidecarConnectionAtom);
  const agents = useAtomValue(agentListAtom);
  const snapshots = useAtomValue(agentSnapshotsAtom);
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);
  const { data: providers } = useAgentProviders();

  const taskId = activeTaskId(pathname);
  const activeAgent = taskId ? snapshots[taskId] : undefined;
  const agentLabel = activeAgent ? agentProviderLabel(activeAgent.provider, providers) : "—";
  const modelLabel = activeAgent?.model ?? "—";

  const runningCount = useMemo(
    () => agents.filter((agent) => isAgentRunning(agent, runtimeBySession[agent.id])).length,
    [agents, runtimeBySession],
  );
  const errorCount = useMemo(() => agents.filter((agent) => agent.status === "error").length, [agents]);

  const uiVersion = versionLabel(DESKTOP_VERSION);
  const uiCommit = shortCommit(BUILD_COMMIT);

  return (
    <footer className={s.statusbar} aria-label="运行状态">
      <span className={`${s.stat} ${s.serviceStat}`} title="本机 Agent 服务（Node sidecar）连接状态">
        <StatusDot tone={CONNECTION_TONES[connection]} />
        <span className={s.lbl}>Agent 服务</span>
        <span className={s.val}>{CONNECTION_LABELS[connection]}</span>
      </span>
      <span className={s.sep} />
      <span className={s.stat}>
        <span className={s.lbl}>Agent</span>
        <span className={s.val}>{agentLabel}</span>
      </span>
      <span className={s.sep} />
      <span className={s.stat}>
        <span className={s.lbl}>模型</span>
        <span className={s.val}>{modelLabel}</span>
      </span>
      <span className={s.sep} />
      <span className={s.stat} title={`界面 ${uiVersion} · ${uiCommit}`}>
        <span className={s.lbl}>版本</span>
        <span className={s.val}>{uiVersion}</span>
        <span className={s.val}>{uiCommit}</span>
      </span>

      <div className={s.right}>
        <span className={s.stat}>
          <span className={s.lbl}>进行中</span>
          <span className={s.val}>{runningCount}</span>
        </span>
        <span className={s.sep} />
        <span className={s.stat} data-tone={errorCount > 0 ? "warn" : undefined}>
          <span className={s.lbl}>出错</span>
          <span className={s.val}>{errorCount}</span>
        </span>
        <span className={s.sep} />
        <span className={s.stat}>
          <span className={s.lbl}>会话</span>
          <span className={s.val}>{agents.length}</span>
        </span>
      </div>
    </footer>
  );
}
