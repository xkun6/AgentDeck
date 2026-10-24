// 「编程 Agent」检测页。
//
// 检测 Claude Code / Codex / DeepSeek Harness CLI 的安装、版本与登录态（Rust coding_agents.rs，
// 不读任何 token 密文）。
// 边界：本页只做检测 + 指引，不代写 ~/.claude / ~/.codex 配置文件——
// 三方中转在「Agent 与中转」（/agent-providers）中配置，不改 CLI 自身配置。
// 唯一可写的是 AgentDeck 自己的 `<数据目录>/coding-agent-paths.json`（手动指定 claude / codex 可执行文件），
// 检测与 sidecar 启动共用该配置（design.md 5.1）。
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  Copy,
  FolderOpen,
  FolderSearch,
  KeyRound,
  RefreshCw,
  RotateCcw,
  Save,
  SquareTerminal,
  XCircle,
} from "lucide-react";
import type { CodingAgentStatus } from "@agentdeck/protocol";
import { Button, LoadingState } from "@agentdeck/shared-ui";
import { CopyButton } from "@/components/ui/copy-button";
import { DiagnosticCopyButton } from "@/components/ui/diagnostic-copy-button";
import {
  useCodingAgentsCheck,
  useSaveCodingAgentPath,
  type CodingAgentPathKey,
} from "@/hooks/use-coding-agents";
import s from "./settings.module.css";

type CardStatus = "ok" | "warning" | "error" | "unknown";

const LOGIN_LABELS: Record<CodingAgentStatus["loginState"], string> = {
  logged_in: "已登录",
  expired: "凭据过期",
  not_logged_in: "未登录",
  unknown: "未知",
};

const AGENT_DESCRIPTIONS: Record<string, string> = {
  "claude-code": "Anthropic 自主编程Agent CLI",
  codex: "OpenAI 自主编程Agent CLI",
  dsh: "DeepSeek 自主编程Agent（经 ACP 驱动 dsh --profile acp）",
};

function agentCardStatus(agent: CodingAgentStatus): CardStatus {
  if (!agent.installed) return "warning";
  if (agent.runError) return "error";
  if (agent.loginState === "expired" || agent.loginState === "not_logged_in") return "warning";
  if (agent.loginState === "unknown") return "unknown";
  return "ok";
}

function agentStatusLine(agent: CodingAgentStatus): string {
  if (!agent.installed && agent.configuredPath) {
    const reason = agent.version ?? `配置的路径不存在：${agent.configuredPath}`;
    return `${agent.label} 不可用：${reason}；请修改路径或恢复自动查找`;
  }
  if (!agent.installed) {
    return `${agent.label} 未安装；安装后才能在 AgentDeck 中新建 ${agent.label} 会话`;
  }
  if (agent.runError) {
    return `${agent.label} 已找到但无法运行，新建 ${agent.label} 会话会失败；请检查或重新安装`;
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

const PATH_KEYS: Record<string, CodingAgentPathKey> = {
  "claude-code": "claude",
  codex: "codex",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 「可执行文件路径」一栏：留空 = 自动查找；保存后检测与 sidecar 立即按新配置解析。 */
export function AgentPathField({ agent, onSave }: {
  agent: CodingAgentStatus;
  onSave: (value: string | null) => Promise<unknown>;
}) {
  const configured = agent.configuredPath ?? "";
  const [draft, setDraft] = useState(configured);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  useEffect(() => setDraft(configured), [configured]);

  const canSave = typeof window !== "undefined" && Boolean(window.agentdeckDesktop?.codingAgentPathsSet);
  const canBrowse = typeof window !== "undefined" && Boolean(window.agentdeckDesktop?.pickExecutableFile);
  const trimmed = draft.trim();

  const save = async (value: string | null) => {
    setSaving(true);
    setMessage(null);
    try {
      await onSave(value);
      setMessage({ tone: "ok", text: value ? "已保存，之后的检测与新建会话使用该路径" : "已恢复自动查找" });
    } catch (error) {
      setMessage({ tone: "error", text: `保存失败：${errorText(error)}` });
    } finally {
      setSaving(false);
    }
  };

  const browse = async () => {
    const result = await window.agentdeckDesktop?.pickExecutableFile?.({ title: `选择 ${agent.label} 可执行文件` })
      .catch(() => null);
    const picked = result && !result.canceled ? result.paths[0] : undefined;
    if (picked) setDraft(picked);
  };

  const effective = agent.installed && agent.path ? agent.path : "未找到可用的可执行文件";

  return (
    <div className={s.codingAgentPathField} data-coding-agent-path={agent.id}>
      <div className={s.codingAgentPathHeader}>
        <span>可执行文件路径</span>
        <span className={s.codingAgentPathMode} data-manual={configured ? "true" : undefined}>
          {configured ? "手动配置" : "自动查找"}
        </span>
      </div>
      <div className={s.codingAgentPathRow}>
        <input
          className={[s.input, s.codingAgentPathInput].join(" ")}
          data-mono="true"
          type="text"
          value={draft}
          placeholder="留空则自动查找"
          spellCheck={false}
          aria-label={`${agent.label} 可执行文件路径`}
          disabled={!canSave || saving}
          onChange={(event) => setDraft(event.target.value)}
        />
        {canBrowse ? (
          <button className={s.btn} type="button" disabled={saving} onClick={() => void browse()}>
            <FolderSearch size={12} />
            浏览…
          </button>
        ) : null}
        <button
          className={s.btn}
          type="button"
          disabled={!canSave || saving || trimmed === configured}
          onClick={() => void save(trimmed || null)}
        >
          <Save size={12} />
          保存
        </button>
        <button
          className={s.btn}
          type="button"
          disabled={!canSave || saving || !configured}
          onClick={() => {
            setDraft("");
            void save(null);
          }}
        >
          <RotateCcw size={12} />
          恢复自动查找
        </button>
      </div>
      <p className={s.codingAgentPathHint}>
        当前生效：<code>{effective}</code>
        {configured ? "（手动配置，不再自动查找）" : "（自动查找）"}
      </p>
      {message ? (
        <div className={s.runtimeMessage} data-tone={message.tone} role="status">
          {message.text}
        </div>
      ) : null}
    </div>
  );
}

function AgentCard({ agent, onOpenPath, onSavePath }: {
  agent: CodingAgentStatus;
  onOpenPath: (path: string | undefined) => Promise<void>;
  onSavePath?: (value: string | null) => Promise<unknown>;
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
            <p>{AGENT_DESCRIPTIONS[agent.id] ?? "自主编程Agent CLI"}</p>
          </div>
        </div>
        <div className={s.codingAgentStatusGroup} aria-label={`${agent.label} 当前状态`}>
          <span className={s.envStatusTag} data-status={status}>
            <StatusIcon status={status} />
            {agent.installed ? (agent.runError ? "无法运行" : "已安装") : "未安装"}
          </span>
          {agent.installed && !agent.runError ? (
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
          {agent.installed && agent.version && !agent.runError ? <RuntimeField label="版本" value={agent.version} mono /> : null}
          {agent.runError ? <RuntimeField label="运行错误" value={agent.runError} mono wide /> : null}
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
          {agent.installed && !agent.runError && agent.loginState !== "logged_in" ? (
            <RuntimeField label="登录" value={agent.loginHint} wide />
          ) : null}
        </div>

        {agent.installed && agent.path && window.agentdeckDesktop?.openWorkspacePath ? (
          <button
            className={[s.btn, s.envOpenPathButton].join(" ")}
            type="button"
            onClick={() => void onOpenPath(agent.path)}
          >
            <FolderOpen size={12} />
            打开路径
          </button>
        ) : null}

        {onSavePath ? <AgentPathField agent={agent} onSave={onSavePath} /> : null}
      </div>
    </section>
  );
}

export function CodingAgentsSection({ showHeading = true }: { showHeading?: boolean }) {
  const query = useCodingAgentsCheck();
  const savePath = useSaveCodingAgentPath();
  const data = query.data;
  const hasBridge = typeof window !== "undefined" && Boolean(window.agentdeckDesktop?.codingAgentsCheck);

  const readyCount = (data?.agents ?? []).filter(
    (agent) =>
      agent.installed && !agent.runError && agent.loginState !== "expired" && agent.loginState !== "not_logged_in",
  ).length;
  const total = data?.agents.length ?? 3;
  const allReady = data ? readyCount === total : false;

  const openPath = async (path: string | undefined) => {
    if (!path || !window.agentdeckDesktop?.openWorkspacePath) return;
    await window.agentdeckDesktop.openWorkspacePath({ path }).catch(() => undefined);
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
            AgentDeck 直接驱动本机的 Claude Code、Codex 与 DeepSeek Harness 执行编码任务，会话中实时展示它们的输出、工具调用与权限请求。
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
              onSavePath={
                PATH_KEYS[agent.id]
                  ? (value) => savePath(PATH_KEYS[agent.id]!, value)
                  : undefined
              }
            />
          ))}
        </div>
      )}

      {!data && query.isLoading && <LoadingState variant="block" label="正在检测本机编程 Agent…" />}
    </div>
  );
}
