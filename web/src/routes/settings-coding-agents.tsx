// 「编程 Agent」检测页。
//
// 检测 Claude Code / Codex CLI 的安装、版本与登录态（Rust coding_agents.rs，
// 不读任何 token 密文）。
// 边界：本页只做检测 + 指引，不代写 ~/.claude / ~/.codex 配置文件——
// 三方中转在「Agent 与中转」（/agent-providers）中配置，不改 CLI 自身配置。
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  Copy,
  FolderOpen,
  KeyRound,
  RefreshCw,
  SquareTerminal,
  XCircle,
} from "lucide-react";
import type { CodingAgentStatus } from "@agentdeck/protocol";
import { Button, LoadingState } from "@agentdeck/shared-ui";
import { CopyButton } from "@/components/ui/copy-button";
import { DiagnosticCopyButton } from "@/components/ui/diagnostic-copy-button";
import { useCodingAgentsCheck } from "@/hooks/use-coding-agents";
import s from "./settings.module.css";

type CardStatus = "ok" | "warning" | "error" | "unknown";

const LOGIN_LABELS: Record<CodingAgentStatus["loginState"], string> = {
  logged_in: "已登录",
  expired: "凭据过期",
  not_logged_in: "未登录",
  unknown: "未知",
};

function agentCardStatus(agent: CodingAgentStatus): CardStatus {
  if (!agent.installed) return "warning";
  if (agent.loginState === "expired" || agent.loginState === "not_logged_in") return "warning";
  if (agent.loginState === "unknown") return "unknown";
  return "ok";
}

function agentStatusLine(agent: CodingAgentStatus): string {
  if (!agent.installed) {
    return `${agent.label} 未安装；安装后才能在 AgentDeck 中新建 ${agent.label} 会话`;
  }
  if (agent.loginState === "logged_in") {
    return `${agent.label} 可用，可在 AgentDeck 中新建 ${agent.label} 会话`;
  }
  if (agent.loginState === "expired") {
    return `${agent.label} 已安装，但登录凭据已过期`;
  }
  if (agent.loginState === "not_logged_in") {
    return `${agent.label} 已安装，但尚未登录`;
  }
  return `${agent.label} 已安装（登录状态无法确认，不影响使用）`;
}

function StatusIcon({ status }: { status: CardStatus }) {
  if (status === "ok") return <CheckCircle2 size={12} />;
  if (status === "error") return <XCircle size={12} />;
  if (status === "warning") return <AlertTriangle size={12} />;
  return <CircleHelp size={12} />;
}

function RuntimeField({ label, value, mono, wide }: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  wide?: boolean;
}) {
  return (
    <div className={s.runtimeField} data-wide={wide ? "true" : undefined}>
      <span>{label}</span>
      <b data-mono={mono ? "true" : undefined}>{value ?? "—"}</b>
    </div>
  );
}

export function CodingAgentToolbar({ isFetching, hasBridge, onRefresh, diagnostics }: {
  isFetching: boolean;
  hasBridge: boolean;
  onRefresh: () => void;
  diagnostics: () => string;
}) {
  return (
    <div className={s.codingAgentToolbar} role="toolbar" aria-label="编程Agent 操作">
      <Button
        className={s.codingAgentToolbarButton}
        variant="outline"
        size="md"
        type="button"
        data-coding-agent-action="true"
        onClick={onRefresh}
        disabled={!hasBridge}
        loading={isFetching}
        leadingIcon={<RefreshCw size={12} />}
      >
        刷新检测
      </Button>
      <DiagnosticCopyButton
        className={s.codingAgentToolbarButton}
        data-coding-agent-action="true"
        text={diagnostics}
      />
    </div>
  );
}

function AgentCard({ agent, onOpenPath }: {
  agent: CodingAgentStatus;
  onOpenPath: (path: string | undefined) => Promise<void>;
}) {
  const status = agentCardStatus(agent);
  return (
    <section className={s.codingAgentCard} data-coding-agent-card="true">
      <header className={s.codingAgentCardHeader}>
        <div className={s.codingAgentIdentity}>
          <div className={s.debugCardIcon}>
            <SquareTerminal size={16} />
          </div>
          <div className={s.codingAgentIdentityText}>
            <h3>{agent.label}</h3>
            <p>{agent.id === "claude-code" ? "Anthropic 自主编程Agent CLI" : "OpenAI 自主编程Agent CLI"}</p>
          </div>
        </div>
        <div className={s.codingAgentStatusGroup} aria-label={`${agent.label} 当前状态`}>
          <span className={s.envStatusTag} data-status={status}>
            <StatusIcon status={status} />
            {agent.installed ? "已安装" : "未安装"}
          </span>
          {agent.installed ? (
            <span className={s.envStatusTag} data-status={agent.loginState === "logged_in" ? "ok" : status}>
              <KeyRound size={12} aria-hidden />
              {LOGIN_LABELS[agent.loginState]}
            </span>
          ) : null}
        </div>
      </header>

      <div className={[s.envCheckItem, s.codingAgentDetails].join(" ")} data-status={status}>
        <p className={s.envCheckSummary} data-status={status}>{agentStatusLine(agent)}</p>

        <div className={[s.runtimeGrid, s.envCheckDetails, s.codingAgentRuntimeGrid].join(" ")}>
          {agent.installed && agent.version ? <RuntimeField label="版本" value={agent.version} mono /> : null}
          {agent.loginDetail ? <RuntimeField label="登录状态" value={agent.loginDetail} /> : null}
          {agent.installed && agent.path ? <RuntimeField label="路径" value={agent.path} mono wide /> : null}
          <RuntimeField label="配置目录" value={agent.configDir} mono wide />
          {!agent.installed ? (
            <RuntimeField
              label="安装"
              value={
                <span>
                  <code>{agent.installHint}</code>{" "}
                  <CopyButton className={s.btn} text={agent.installHint}>
                    <Copy size={12} /> 复制命令
                  </CopyButton>
                </span>
              }
              wide
            />
          ) : null}
          {agent.installed && agent.loginState !== "logged_in" ? (
            <RuntimeField label="登录" value={agent.loginHint} wide />
          ) : null}
        </div>

        {agent.installed && agent.path && window.hermesDesktop?.openWorkspacePath ? (
          <button
            className={[s.btn, s.envOpenPathButton].join(" ")}
            type="button"
            onClick={() => void onOpenPath(agent.path)}
          >
            <FolderOpen size={12} />
            打开路径
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function CodingAgentsSection({ showHeading = true }: { showHeading?: boolean }) {
  const query = useCodingAgentsCheck();
  const data = query.data;
  const hasBridge = typeof window !== "undefined" && Boolean(window.hermesDesktop?.codingAgentsCheck);

  const readyCount = (data?.agents ?? []).filter(
    (agent) => agent.installed && agent.loginState !== "expired" && agent.loginState !== "not_logged_in",
  ).length;
  const total = data?.agents.length ?? 2;
  const allReady = data ? readyCount === total : false;

  const openPath = async (path: string | undefined) => {
    if (!path || !window.hermesDesktop?.openWorkspacePath) return;
    await window.hermesDesktop.openWorkspacePath({ path }).catch(() => undefined);
  };

  const diagnostics = () =>
    JSON.stringify({ generatedAt: new Date().toISOString(), codingAgents: data ?? null }, null, 2);

  return (
    <div className={s.codingAgentsPage}>
      {showHeading && <h2 className={s.heading}>编程 Agent</h2>}
      <div
        className={[s.aboutHero, s.codingAgentsHero].join(" ")}
        data-ok={allReady && data ? "true" : undefined}
      >
        <div className={s.aboutHeroMark}>
          <SquareTerminal size={24} />
        </div>
        <div className={s.aboutHeroBody}>
          <div className={s.aboutEyebrow}>多 Agent 编排 · 本机 CLI</div>
          <h3>
            {data
              ? allReady
                ? "编程 Agent 已就绪"
                : "部分编程 Agent 未就绪"
              : "正在检测编程 Agent"}
          </h3>
          <p>
            AgentDeck 直接驱动本机的 Claude Code 与 Codex CLI 执行编码任务，会话中实时展示它们的输出、工具调用与权限请求。
            本页只做检测与指引，不会改写 CLI 自身的配置文件；三方中转请在
            {" "}<Link className={s.inlineLink} to="/agent-providers">Agent 与中转</Link>{" "}
            中配置（只对 AgentDeck 启动的会话生效）。
          </p>
        </div>
        <span
          className={s.statusBadge}
          data-on={allReady && data ? "true" : data && readyCount === 0 ? "false" : undefined}
        >
          {data ? `${readyCount}/${total} 就绪` : query.isLoading ? "检测中" : "未连接"}
        </span>
      </div>

      <CodingAgentToolbar
        isFetching={query.isFetching}
        hasBridge={hasBridge}
        onRefresh={() => void query.refetch()}
        diagnostics={diagnostics}
      />

      {!hasBridge && (
        <div className={s.runtimeMessage} data-tone="error">
          当前运行环境不支持编程 Agent 检测（需要桌面端）。
        </div>
      )}
      {query.isError && (
        <div className={s.runtimeMessage} data-tone="error">
          检测失败：{query.error instanceof Error ? query.error.message : "unknown error"}
        </div>
      )}

      {data && (
        <div className={s.codingAgentList}>
          {data.agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              onOpenPath={openPath}
            />
          ))}
        </div>
      )}

      {!data && query.isLoading && <LoadingState variant="block" label="正在检测本机编程 Agent…" />}
    </div>
  );
}
