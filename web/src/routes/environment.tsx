import { useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  Download,
  FolderOpen,
  MonitorCog,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Wrench,
  XCircle,
} from "lucide-react";
import type { EnvironmentCheckCategory, EnvironmentCheckItem, EnvironmentCheckResult, EnvironmentCheckStatus } from "@agentdeck/protocol";
import { Button, LoadingState } from "@agentdeck/shared-ui";
import { DiagnosticCopyButton } from "@/components/ui/diagnostic-copy-button";
import { useEnvironmentCheck, useEnvironmentInstall } from "@/hooks/use-environment-check";
import { useConfirm } from "@/lib/use-confirm";
import s from "./settings.module.css";

const CATEGORY_LABELS: Record<EnvironmentCheckCategory, string> = {
  core: "核心环境",
  runtime: "Agent 服务",
  tools: "本机工具",
  browser: "浏览器能力",
  paths: "路径",
};

const STATUS_LABELS: Record<EnvironmentCheckStatus, string> = {
  ok: "正常",
  warning: "注意",
  error: "异常",
  unknown: "未知",
};

const CATEGORY_ORDER: EnvironmentCheckCategory[] = ["core", "runtime", "tools", "browser", "paths"];

/** 装完这些项后，已在运行的 sidecar 可能仍沿用旧 PATH，需要提示重启 sidecar。 */
const SIDECAR_RESTART_HINT_IDS = new Set(["node", "npm", "claude-code", "codex", "agent-browser"]);

type InstallOutcome =
  | { kind: "success"; restartHint: boolean }
  | { kind: "failed"; message: string; output: string };

export function summarizeEnvironmentItems(items: readonly EnvironmentCheckItem[]) {
  const errors = items.filter((item) => item.status === "error").length;
  const warnings = items.filter((item) => item.status === "warning").length;
  const requiredErrors = items.filter((item) => item.required && item.status === "error").length;
  const ok = items.filter((item) => item.status === "ok").length;
  return { errors, warnings, requiredErrors, ok, total: items.length };
}

function groupItems(items: readonly EnvironmentCheckItem[]) {
  const grouped = new Map<EnvironmentCheckCategory, EnvironmentCheckItem[]>();
  for (const item of items) {
    const list = grouped.get(item.category) ?? [];
    list.push(item);
    grouped.set(item.category, list);
  }
  return CATEGORY_ORDER.flatMap((category) => {
    const list = grouped.get(category);
    if (!list?.length) return [];
    return [{ category, items: list }];
  });
}

function formatGeneratedAt(value: number | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function diagnosticsPayload(data: EnvironmentCheckResult | undefined) {
  return JSON.stringify({ generatedAt: new Date().toISOString(), environment: data ?? null }, null, 2);
}

export function EnvironmentSection({ showHeading = true }: { showHeading?: boolean }) {
  const query = useEnvironmentCheck();
  const data = query.data;
  const summary = summarizeEnvironmentItems(data?.items ?? []);
  const grouped = useMemo(() => groupItems(data?.items ?? []), [data?.items]);
  const hasBridge = typeof window !== "undefined" && Boolean(window.agentdeckDesktop?.environmentCheck);
  const healthy = summary.requiredErrors === 0 && summary.errors === 0;
  const { confirm } = useConfirm();
  const installTool = useEnvironmentInstall();
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installOutcomes, setInstallOutcomes] = useState<Record<string, InstallOutcome>>({});

  const openPath = async (path: string | undefined) => {
    if (!path || !window.agentdeckDesktop?.openWorkspacePath) return;
    await window.agentdeckDesktop.openWorkspacePath({ path }).catch(() => undefined);
  };

  const setOutcome = (id: string, outcome: InstallOutcome | null) => {
    setInstallOutcomes((prev) => {
      const next = { ...prev };
      if (outcome) next[id] = outcome;
      else delete next[id];
      return next;
    });
  };

  const runInstall = async (item: EnvironmentCheckItem) => {
    const install = item.install;
    if (!install?.available || installingId) return;
    const confirmed = await confirm({
      title: `安装 ${item.label}`,
      body: (
        <>
          将执行以下命令：
          <pre className={s.envInstallCommand}>{install.command}</pre>
          winget 安装时可能弹出管理员授权（UAC）窗口，请留意并确认；安装可能需要几分钟。
        </>
      ),
      confirmLabel: "开始安装",
    });
    if (!confirmed) return;
    setInstallingId(item.id);
    setOutcome(item.id, null);
    try {
      const result = await installTool(item.id);
      setOutcome(
        item.id,
        result.ok
          ? { kind: "success", restartHint: SIDECAR_RESTART_HINT_IDS.has(item.id) }
          : {
              kind: "failed",
              message: result.exitCode === null ? "安装失败" : `安装失败（退出码 ${result.exitCode}）`,
              output: result.output,
            },
      );
    } catch (error) {
      setOutcome(item.id, {
        kind: "failed",
        message: `安装失败：${error instanceof Error ? error.message : String(error)}`,
        output: "",
      });
    } finally {
      setInstallingId(null);
    }
  };

  return (
    <div>
      {showHeading && <h2 className={s.heading}>环境</h2>}
      <div className={s.aboutHero} data-ok={healthy && data ? "true" : undefined}>
        <div className={s.aboutHeroMark}>{healthy ? <ShieldCheck size={24} /> : <MonitorCog size={24} />}</div>
        <div className={s.aboutHeroBody}>
          <div className={s.aboutEyebrow}>本机环境与依赖检查</div>
          <h3>{data ? (healthy ? "核心环境正常" : "发现需要关注的环境项") : "正在读取环境状态"}</h3>
          <p>
            此页展示 AgentDeck 的数据目录、Agent 服务（Node sidecar）状态，以及 Git、npm、ripgrep、Claude Code / Codex CLI 等本机工具。
            可选项缺失不会影响启动，但会影响对应工具的能力。
          </p>
        </div>
        <span className={s.statusBadge} data-on={healthy && data ? "true" : summary.errors ? "false" : undefined}>
          {data ? `${summary.ok}/${summary.total} 正常` : query.isLoading ? "读取中" : "未连接"}
        </span>
      </div>

      <div className={s.debugActionBar}>
        <Button
          variant="outline"
          size="md"
          type="button"
          onClick={() => void query.refetch()}
          disabled={!hasBridge}
          loading={query.isFetching}
          leadingIcon={<RefreshCw size={12} />}
        >
          刷新检查
        </Button>
        <DiagnosticCopyButton text={() => diagnosticsPayload(data)} />
        <Button
          variant="outline"
          size="md"
          type="button"
          onClick={() => void openPath(data?.dataDir)}
          disabled={!data?.dataDir || !window.agentdeckDesktop?.openWorkspacePath}
          leadingIcon={<FolderOpen size={12} />}
        >
          打开数据目录
        </Button>
        <Button
          variant="outline"
          size="md"
          type="button"
          onClick={() => void openPath(data?.logDir)}
          disabled={!data?.logDir || !window.agentdeckDesktop?.openWorkspacePath}
          leadingIcon={<FolderOpen size={12} />}
        >
          打开日志目录
        </Button>
      </div>

      {!hasBridge && <div className={s.runtimeMessage} data-tone="error">当前环境不支持环境检查。</div>}
      {query.isError && <div className={s.runtimeMessage} data-tone="error">环境检查失败：{query.error instanceof Error ? query.error.message : "unknown error"}</div>}

      {data && (
        <div className={s.aboutDebugGrid}>
          <DebugCard icon={<MonitorCog size={16} />} title="环境摘要" sub="核心错误会影响启动；可选 warning 只影响对应能力" wide>
            <div className={s.runtimeGrid}>
              <RuntimeField label="平台" value={`${data.platform}-${data.arch}`} />
              <RuntimeField label="生成时间" value={formatGeneratedAt(data.generatedAtMs)} />
              <RuntimeField label="核心错误" value={summary.requiredErrors} />
              <RuntimeField label="全部异常" value={summary.errors} />
              <RuntimeField label="注意项" value={summary.warnings} />
              <RuntimeField label="数据目录" value={data.dataDir} mono wide />
              <RuntimeField label="日志目录" value={data.logDir} mono wide />
            </div>
          </DebugCard>

          {grouped.map((group) => (
            <DebugCard key={group.category} icon={categoryIcon(group.category)} title={CATEGORY_LABELS[group.category]} wide>
              <div className={s.platformList}>
                {group.items.map((item) => (
                  <EnvironmentItemRow
                    key={item.id}
                    item={item}
                    onOpenPath={openPath}
                    installing={installingId === item.id}
                    installBusy={installingId !== null}
                    installOutcome={installOutcomes[item.id]}
                    onInstall={() => void runInstall(item)}
                  />
                ))}
              </div>
            </DebugCard>
          ))}
        </div>
      )}

      {!data && query.isLoading && <LoadingState variant="block" label="正在检查本机环境…" />}
    </div>
  );
}

function EnvironmentItemRow({ item, onOpenPath, installing, installBusy, installOutcome, onInstall }: {
  item: EnvironmentCheckItem;
  onOpenPath: (path: string | undefined) => Promise<void>;
  installing: boolean;
  installBusy: boolean;
  installOutcome?: InstallOutcome;
  onInstall: () => void;
}) {
  return (
    <div className={s.envCheckItem} data-status={item.status}>
      <div className={s.envCheckHeader}>
        <div className={s.envCheckTitle}>
          <span className={s.envCheckIcon} data-status={item.status}>
            <StatusIcon status={item.status} />
          </span>
          <span className={s.envCheckLabel}>{item.label}</span>
          {item.required && <span className={s.envRequiredTag}>必需</span>}
        </div>
        <span className={s.envStatusTag} data-status={item.status}>{STATUS_LABELS[item.status]}</span>
      </div>
      <p className={s.envCheckSummary} data-status={item.status}>{item.summary}</p>
      {(item.version || item.path || item.details || item.recommendation) && (
        <div className={[s.runtimeGrid, s.envCheckDetails].join(" ")}>
          {item.version && <RuntimeField label="版本" value={item.version} mono wide />}
          {item.path && <RuntimeField label="路径" value={item.path} mono wide />}
          {item.details && <RuntimeField label="详情" value={item.details} mono wide />}
          {item.recommendation && <RuntimeField label="建议" value={item.recommendation} wide />}
        </div>
      )}
      {(item.install || installOutcome) && (
        <div className={s.envInstall}>
          {item.install && (
            <div className={s.envInstallActions}>
              <Button
                variant="solid"
                tone="accent"
                size="sm"
                type="button"
                onClick={onInstall}
                disabled={!item.install.available || installBusy}
                loading={installing}
                leadingIcon={<Download size={12} />}
              >
                {installing ? "安装中…" : "一键安装"}
              </Button>
              {!item.install.available && item.install.unavailableReason && (
                <span className={s.envInstallReason}>{item.install.unavailableReason}</span>
              )}
            </div>
          )}
          {installOutcome?.kind === "success" && (
            <p className={s.envInstallMessage} data-tone="ok">
              安装完成{installOutcome.restartHint ? "。如 Agent 仍显示不可用，请重启 sidecar" : ""}
            </p>
          )}
          {installOutcome?.kind === "failed" && (
            <>
              <p className={s.envInstallMessage} data-tone="error">{installOutcome.message}</p>
              {installOutcome.output && (
                <details className={s.envInstallOutput}>
                  <summary>查看输出</summary>
                  <pre>{installOutcome.output}</pre>
                </details>
              )}
            </>
          )}
        </div>
      )}
      {item.path && window.agentdeckDesktop?.openWorkspacePath && (
        <button className={[s.btn, s.envOpenPathButton].join(" ")} type="button" onClick={() => void onOpenPath(item.path)}>
          <FolderOpen size={12} />
          打开路径
        </button>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: EnvironmentCheckStatus }) {
  if (status === "ok") return <CheckCircle2 size={12} />;
  if (status === "error") return <XCircle size={12} />;
  if (status === "warning") return <AlertTriangle size={12} />;
  return <CircleHelp size={12} />;
}

function categoryIcon(category: EnvironmentCheckCategory): ReactNode {
  if (category === "core" || category === "runtime") return <ShieldCheck size={16} />;
  if (category === "tools") return <Terminal size={16} />;
  if (category === "browser") return <Wrench size={16} />;
  return <MonitorCog size={16} />;
}

function DebugCard({ icon, title, sub, children, wide }: {
  icon: ReactNode;
  title: string;
  sub?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <section className={s.debugCard} data-wide={wide ? "true" : undefined}>
      <div className={s.debugCardHeader}>
        <div className={s.debugCardIcon}>{icon}</div>
        <div>
          <h3>{title}</h3>
          {sub && <p>{sub}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function RuntimeField({ label, value, mono, wide }: {
  label: string;
  value: string | number | boolean | undefined;
  mono?: boolean;
  wide?: boolean;
}) {
  const display = value === undefined || value === "" ? "—" : String(value);
  return (
    <div className={s.runtimeField} data-wide={wide ? "true" : undefined}>
      <span>{label}</span>
      <b data-mono={mono ? "true" : undefined}>{display}</b>
    </div>
  );
}
