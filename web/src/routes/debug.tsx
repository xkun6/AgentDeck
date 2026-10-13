// 「调试」页（design.md 4.18）：运行状态 / 路径 / Agent 可用性 / 前端事件 / sidecar 日志 / 操作。
// 与 sidecar 通信只走 use-agent-session 的现有 hook；Rust 能力走 window.agentdeckDesktop。
import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { FolderOpen, PackageOpen, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@agentdeck/shared-ui";
import { CopyButton } from "@/components/ui/copy-button";
import { DiagnosticCopyButton } from "@/components/ui/diagnostic-copy-button";
import { useAgentProviders } from "@/hooks/use-agent-catalog";
import { useCodingAgentsCheck } from "@/hooks/use-coding-agents";
import { BUILD_COMMIT, BUILD_DATE, DESKTOP_VERSION } from "@/lib/build-info";
import { debugBus, type DebugEntry, type DebugEntryType } from "@/lib/debug-bus";
import {
  buildDiagnostics,
  eventsToJsonl,
  filterLogText,
  sidecarPort,
  type LogLevelFilter,
} from "@/lib/debug-diagnostics";
import { agentSnapshotsAtom, sidecarConnectionAtom } from "@/stores/agents";
import s from "./debug.module.css";

const LOG_TAIL_BYTES = 256 * 1024;
const LOG_REFRESH_MS = 2000;
const EVENT_TYPE_LABELS: Record<"all" | DebugEntryType, string> = {
  all: "全部类型",
  sidecar: "sidecar",
  rest: "rest",
  console: "console",
  exception: "异常",
  backend: "backend",
};

function useDebugEvents(): DebugEntry[] {
  return useSyncExternalStore(
    (onChange) => debugBus.subscribe(onChange),
    () => debugBus.snapshot(),
  );
}

function Block({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className={s.block}>
      <div className={s.blockHead}>
        <h3 className={s.blockTitle}>{title}</h3>
        {actions ? <div className={s.blockActions}>{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className={s.field}>
      <span className={s.fieldLabel}>{label}</span>
      <span className={s.fieldValue}>{value}</span>
    </div>
  );
}

function formatTime(ts: number): string {
  return new Date(ts).toISOString().slice(11, 23);
}

export function DebugSection({ showHeading = true }: { showHeading?: boolean }) {
  const bridge = typeof window === "undefined" ? undefined : window.agentdeckDesktop;
  const queryClient = useQueryClient();
  const connection = useAtomValue(sidecarConnectionAtom);
  const sessions = useAtomValue(agentSnapshotsAtom);
  const providers = useAgentProviders();
  const codingAgents = useCodingAgentsCheck();
  const events = useDebugEvents();

  const [eventType, setEventType] = useState<"all" | DebugEntryType>("all");
  const [logLevel, setLogLevel] = useState<LogLevelFilter>("all");
  const [logKeyword, setLogKeyword] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const status = useQuery({
    queryKey: ["debug-sidecar-status"],
    queryFn: () => bridge!.sidecarStatus!(),
    enabled: Boolean(bridge?.sidecarStatus),
    refetchInterval: 5000,
  });
  const paths = useQuery({
    queryKey: ["debug-paths"],
    queryFn: () => bridge!.debugPaths!(),
    enabled: Boolean(bridge?.debugPaths),
    staleTime: 60_000,
  });
  const logs = useQuery({
    queryKey: ["debug-log-tail"],
    queryFn: () => bridge!.logTail!({ maxBytes: LOG_TAIL_BYTES }),
    enabled: Boolean(bridge?.logTail),
    refetchInterval: autoRefresh ? LOG_REFRESH_MS : false,
  });

  const shownEvents = useMemo(
    () => (eventType === "all" ? events : events.filter((entry) => entry.type === eventType)),
    [events, eventType],
  );
  const shownLog = useMemo(
    () => filterLogText(logs.data?.text ?? "", logLevel, logKeyword),
    [logs.data?.text, logLevel, logKeyword],
  );

  const diagnosticsText = () =>
    JSON.stringify(
      buildDiagnostics({
        generatedAt: new Date().toISOString(),
        app: { version: DESKTOP_VERSION, commit: BUILD_COMMIT, buildDate: BUILD_DATE },
        sidecar: status.data ?? null,
        connection,
        paths: paths.data ?? null,
        providers: providers.data ?? null,
        codingAgents: codingAgents.data ?? null,
        sessions,
        platform: typeof navigator === "undefined" ? "" : navigator.platform,
        userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
      }),
      null,
      2,
    );

  const openPath = async (path: string | undefined) => {
    if (!path || !bridge?.openWorkspacePath) return;
    await bridge.openWorkspacePath({ path }).catch(() => undefined);
  };

  const restart = async () => {
    if (!bridge?.restartSidecar || restarting) return;
    setRestarting(true);
    setMessage(null);
    try {
      const next = await bridge.restartSidecar();
      queryClient.setQueryData(["debug-sidecar-status"], next);
      setMessage(
        next.status === "ready"
          ? { tone: "ok", text: "sidecar 已重启" }
          : { tone: "error", text: `sidecar 重启后状态：${next.status}${next.error ? `（${next.error}）` : ""}` },
      );
      void logs.refetch();
    } catch (error) {
      setMessage({ tone: "error", text: `重启失败：${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setRestarting(false);
    }
  };

  const exportBundle = async () => {
    if (!bridge?.exportDebugBundle) return;
    setMessage(null);
    try {
      const result = await bridge.exportDebugBundle({
        diagnostics: diagnosticsText(),
        frontendEvents: eventsToJsonl(debugBus.snapshot()),
      });
      if (result.canceled) return;
      setMessage(
        result.ok
          ? { tone: "ok", text: `诊断包已导出：${result.path ?? ""}` }
          : { tone: "error", text: `导出失败：${result.error ?? "未知错误"}` },
      );
    } catch (error) {
      setMessage({ tone: "error", text: `导出失败：${error instanceof Error ? error.message : String(error)}` });
    }
  };

  const pathRows: Array<[string, string | undefined]> = [
    ["数据目录", paths.data?.dataDir],
    ["日志目录", paths.data?.logDir],
    ["WebView 数据目录", paths.data?.webviewDataDir],
  ];

  return (
    <div className={s.page}>
      {showHeading && <h2 className={s.heading}>调试</h2>}

      <Block
        title="运行状态"
        actions={
          <Button
            variant="outline"
            size="md"
            type="button"
            onClick={() => void restart()}
            disabled={!bridge?.restartSidecar}
            loading={restarting}
            leadingIcon={<RotateCcw size={12} />}
          >
            重启 sidecar
          </Button>
        }
      >
        <div className={s.fields}>
          <Field label="应用版本" value={DESKTOP_VERSION} />
          <Field label="提交" value={BUILD_COMMIT} />
          <Field label="构建日期" value={BUILD_DATE} />
          <Field label="sidecar 状态" value={status.data?.status ?? "—"} />
          <Field label="sidecar 版本" value={status.data?.version ?? "—"} />
          <Field label="端口" value={sidecarPort(status.data?.wsUrl) ?? "—"} />
          <Field label="前端连接" value={connection} />
          <Field label="pid" value="—" />
        </div>
        {status.data?.error ? <div className={s.message} data-tone="error">{status.data.error}</div> : null}
        {message ? <div className={s.message} data-tone={message.tone}>{message.text}</div> : null}
      </Block>

      <Block title="路径">
        {pathRows.map(([label, value]) =>
          value || label !== "WebView 数据目录" ? (
            <div className={s.pathRow} key={label}>
              <span className={s.fieldLabel}>{label}</span>
              <span className={s.pathValue} title={value}>{value ?? "—"}</span>
              <Button
                variant="outline"
                size="md"
                type="button"
                onClick={() => void openPath(value)}
                disabled={!value || !bridge?.openWorkspacePath}
                leadingIcon={<FolderOpen size={12} />}
              >
                打开
              </Button>
            </div>
          ) : null,
        )}
      </Block>

      <Block
        title="Agent 可用性"
        actions={
          <Button
            variant="outline"
            size="md"
            type="button"
            onClick={() => {
              void providers.refetch();
              void codingAgents.refetch();
            }}
            leadingIcon={<RefreshCw size={12} />}
          >
            刷新
          </Button>
        }
      >
        <div className={s.list} aria-label="provider 可用状态">
          {(providers.data ?? []).map((provider) => (
            <div className={s.listRow} key={provider.id}>
              <span>{provider.label}</span>
              <span className={s.badge} data-ok={provider.available ? "true" : "false"}>
                {provider.available ? "可用" : "不可用"}
              </span>
              <span className={s.muted}>{provider.unavailableReason ?? ""}</span>
            </div>
          ))}
          {!providers.data?.length ? <div className={s.muted}>{providers.isLoading ? "读取中…" : "无 provider（sidecar 未连接？）"}</div> : null}
        </div>
        <div className={s.list} aria-label="编程 Agent 检测">
          {(codingAgents.data?.agents ?? []).map((agent) => (
            <div className={s.listRow} key={agent.id}>
              <span>{agent.label}</span>
              <span className={s.badge} data-ok={agent.installed ? "true" : "false"}>
                {agent.installed ? "已安装" : "未安装"}
              </span>
              <span className={s.muted}>{[agent.version, agent.path].filter(Boolean).join(" · ")}</span>
            </div>
          ))}
        </div>
      </Block>

      <Block
        title="前端事件"
        actions={
          <>
            <select
              className={s.select}
              value={eventType}
              aria-label="事件类型"
              onChange={(event) => setEventType(event.target.value as "all" | DebugEntryType)}
            >
              {Object.entries(EVENT_TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
            <CopyButton
              text={() => eventsToJsonl(shownEvents)}
              variant="outline"
              size="md"
            >
              复制
            </CopyButton>
            <Button
              variant="outline"
              size="md"
              type="button"
              onClick={() => debugBus.clear()}
              leadingIcon={<Trash2 size={12} />}
            >
              清空
            </Button>
          </>
        }
      >
        <div className={s.logBox} role="log" aria-label="前端事件">
          {shownEvents.length === 0 ? <div className={s.muted}>暂无事件</div> : null}
          {[...shownEvents].reverse().map((entry) => (
            <div className={s.eventLine} data-level={entry.level} key={entry.id}>
              {formatTime(entry.ts)} [{entry.type}] {entry.summary}
            </div>
          ))}
        </div>
      </Block>

      <Block
        title="sidecar 日志"
        actions={
          <>
            <select
              className={s.select}
              value={logLevel}
              aria-label="日志级别"
              onChange={(event) => setLogLevel(event.target.value as LogLevelFilter)}
            >
              <option value="all">全部</option>
              <option value="warn">警告及以上</option>
              <option value="error">错误</option>
            </select>
            <input
              className={s.search}
              value={logKeyword}
              placeholder="关键字"
              aria-label="日志关键字"
              onChange={(event) => setLogKeyword(event.target.value)}
            />
            <label className={s.check}>
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(event) => setAutoRefresh(event.target.checked)}
              />
              自动刷新
            </label>
            <Button
              variant="outline"
              size="md"
              type="button"
              onClick={() => void logs.refetch()}
              loading={logs.isFetching}
              leadingIcon={<RefreshCw size={12} />}
            >
              刷新
            </Button>
            <Button
              variant="outline"
              size="md"
              type="button"
              onClick={() => void openPath(paths.data?.logDir)}
              disabled={!paths.data?.logDir || !bridge?.openWorkspacePath}
              leadingIcon={<FolderOpen size={12} />}
            >
              打开日志目录
            </Button>
          </>
        }
      >
        <pre className={s.logBox} aria-label="sidecar 日志">
          {shownLog || (logs.data ? "（无匹配日志）" : logs.isError ? "读取日志失败" : "读取中…")}
        </pre>
        {logs.data?.truncated ? (
          <div className={s.muted}>仅显示末尾约 {Math.round(LOG_TAIL_BYTES / 1024)} KB（文件共 {logs.data.size} 字节）</div>
        ) : null}
      </Block>

      <Block title="操作">
        <div className={s.actions}>
          <DiagnosticCopyButton text={diagnosticsText} label="复制诊断信息" />
          <Button
            variant="outline"
            size="md"
            type="button"
            onClick={() => void exportBundle()}
            disabled={!bridge?.exportDebugBundle}
            leadingIcon={<PackageOpen size={12} />}
          >
            导出诊断包
          </Button>
        </div>
        <div className={s.muted}>
          诊断包含诊断信息、前端事件、sidecar 日志与脱敏后的 providers.json；不含令牌、会话内容与 ui.sqlite。
        </div>
      </Block>
    </div>
  );
}
