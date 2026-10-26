// 「Computer Use」设置页（design.md 4.37，Agent 分组）：驱动 / 安全与审批 / 运行时配置 / 能力概览。
// 与 sidecar 通信只走 use-agent-session。
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { Copy, ExternalLink, ShieldOff, X } from "lucide-react";
import { Button, CopyButton, Dialog, IconButton } from "@agentdeck/shared-ui";
import {
  COMPUTER_USE_CALL_TIMEOUT_PRESETS,
  type ComputerUseApproval,
  type ComputerUseInstallCommand,
  type ComputerUseInstallResult,
  type SidecarSettings,
  type SidecarSettingsPatch,
} from "@agentdeck/protocol";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import { openExternalUrl } from "@/lib/external-links";
import { sidecarConnectionAtom } from "@/stores/agents";
import settingsStyles from "./settings.module.css";
import s from "./computer-use-settings.module.css";

const SETTINGS_KEY = ["agentdeck", "sidecar-settings"] as const;
const STATUS_KEY = ["agentdeck", "computer-use-status"] as const;
/** 安装日志最多保留的行数 */
const MAX_LOG_LINES = 200;

function Row({ label, sub, right }: { label: ReactNode; sub?: ReactNode; right: ReactNode }) {
  return (
    <div className={settingsStyles.row}>
      <div className={settingsStyles.rowLeft}>
        <div className={settingsStyles.rowLabel}>{label}</div>
        {sub ? <div className={settingsStyles.rowSub}>{sub}</div> : null}
      </div>
      <div className={settingsStyles.rowRight}>{right}</div>
    </div>
  );
}

function Segmented<T extends string | number | boolean>({
  value,
  options,
  disabled,
  label,
  onChange,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  disabled?: boolean;
  label: string;
  onChange: (next: T) => void;
}) {
  return (
    <div className={settingsStyles.radioGroup} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.label}
          type="button"
          className={settingsStyles.radioBtn}
          data-active={option.value === value}
          disabled={disabled && option.value !== value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const ON_OFF = [
  { value: false, label: "关闭" },
  { value: true, label: "开启" },
] as const;

const APPROVAL_OPTIONS: ReadonlyArray<{ value: ComputerUseApproval; label: string }> = [
  { value: "allow", label: "允许" },
  { value: "ask", label: "询问" },
  { value: "deny", label: "拒绝" },
];

const APPROVAL_HINTS: Record<ComputerUseApproval, string> = {
  allow: "不经人工审批：AgentDeck 不再询问，Claude 发来的 Computer Use 审批也自动放行。不会操作 AgentDeck 自身的限制仍然生效。",
  ask: "每次调用都要审批：Claude 的逐项审批 / 自动接受编辑 / 计划模式由 Claude 询问你，自动模式交给 Claude 的分类器模型；其它情况（含「跳过所有审批」与 Codex 的所有模式）由 AgentDeck 逐次询问你。不提供「始终允许」。",
  deny: "所有 Computer Use 调用直接拒绝，驱动不执行任何操作。不必关闭 Computer Use 即可临时禁用。",
};

const TIMEOUT_OPTIONS = COMPUTER_USE_CALL_TIMEOUT_PRESETS.map((value) => ({ value, label: `${value}s` }));

const CAPABILITIES = ["窗口枚举与切换", "屏幕截图", "鼠标移动与点击", "键盘按键与输入", "原生系统菜单控制", "系统浏览器联动"];

const CUA_REPO_URL = "https://github.com/trycua/cua";

export function ComputerUseSettingsSection() {
  const actions = useAgentSession();
  const queryClient = useQueryClient();
  const connected = useAtomValue(sidecarConnectionAtom) === "open";
  const [message, setMessage] = useState<string | null>(null);
  const [installOpen, setInstallOpen] = useState(false);

  const status = useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => actions.getComputerUseStatus(),
    enabled: connected,
    retry: false,
  });
  const settings = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => actions.getSidecarSettings(),
    enabled: connected,
    retry: false,
  });
  const saveMutation = useMutation({
    mutationFn: (patch: SidecarSettingsPatch) => actions.setSidecarSettings(patch),
    onSuccess: (next: SidecarSettings) => {
      queryClient.setQueryData(SETTINGS_KEY, next);
      setMessage(null);
    },
    onError: (error) => setMessage(`保存失败：${humanizeSidecarError(error)}`),
  });

  if (!connected) {
    return <p className={settingsStyles.desc}>Agent 服务未连接，暂时无法读取或修改 Computer Use 设置。</p>;
  }
  const error = status.error ?? settings.error;
  if (error) {
    return (
      <p className={settingsStyles.desc} role="alert">
        读取设置失败：{humanizeSidecarError(error)}
      </p>
    );
  }
  const driver = status.data;
  const current = settings.data?.computerUse;
  if (!driver || !current) {
    return <p className={settingsStyles.desc}>正在检测驱动…</p>;
  }
  if (!driver.supported) {
    return <p className={settingsStyles.desc}>Computer Use 目前仅支持 Windows。</p>;
  }

  const driverSub = driver.installed ? (
    <>
      {driver.version ? `版本 ${driver.version} · ` : ""}
      <span className={s.mono}>{driver.path}</span>
      {driver.error ? <span className={s.warn}>（{driver.error}）</span> : null}
    </>
  ) : (
    "未安装。桌面操作能力由 trycua/cua 的 cua-driver 提供，安装后才能启用。"
  );

  const save = (patch: Partial<SidecarSettings["computerUse"]>) => saveMutation.mutate({ computerUse: patch });

  return (
    <div>
      <h3 className={s.groupTitle}>驱动</h3>
      <Row
        label="驱动（cua-driver）"
        sub={driverSub}
        right={
          <div className={s.actions}>
            <Button variant="outline" size="sm" loading={status.isFetching} onClick={() => void status.refetch()}>
              重新检测
            </Button>
            {driver.installed ? null : (
              <Button variant="solid" tone="accent" size="sm" onClick={() => setInstallOpen(true)}>
                安装驱动
              </Button>
            )}
          </div>
        }
      />
      <Row
        label="启用 Computer Use"
        sub="开启后，AgentDeck 会给 Claude Code / Codex 会话注入本机 MCP 服务（agentdeck_cua），Agent 可以截图、读取窗口、点击和输入。对之后启动或恢复的会话生效；关闭后立即停用。"
        right={
          <Segmented
            label="启用 Computer Use"
            value={current.enabled}
            options={ON_OFF}
            disabled={!driver.installed}
            onChange={(enabled) => save({ enabled })}
          />
        }
      />

      <h3 className={s.groupTitle}>安全与审批</h3>
      <Row
        label="工具审批策略"
        sub={APPROVAL_HINTS[current.approval]}
        right={
          <Segmented
            label="工具审批策略"
            value={current.approval}
            options={APPROVAL_OPTIONS}
            onChange={(approval) => save({ approval })}
          />
        }
      />
      <Row
        label={
          <span className={s.labelWithIcon}>
            <ShieldOff size={14} aria-hidden="true" />
            允许操作 AgentDeck 自身
          </span>
        }
        sub="默认关闭：Agent 看不到也点不到 AgentDeck 自己的窗口，避免它点掉审批弹窗、改设置或关闭应用。仅在需要自动化测试 AgentDeck 本身时开启。"
        right={
          <Segmented
            label="允许操作 AgentDeck 自身"
            value={current.allowSelfTargeting}
            options={ON_OFF}
            onChange={(allowSelfTargeting) => save({ allowSelfTargeting })}
          />
        }
      />

      <h3 className={s.groupTitle}>运行时配置</h3>
      <Row
        label="单次调用超时"
        sub="驱动执行单次操作的最长等待时间，不含等待审批的时间。"
        right={
          <Segmented
            label="单次调用超时"
            value={current.callTimeoutSec}
            options={TIMEOUT_OPTIONS}
            onChange={(callTimeoutSec) => save({ callTimeoutSec })}
          />
        }
      />

      <h3 className={s.groupTitle}>能力概览</h3>
      <ul className={s.capabilities}>
        {CAPABILITIES.map((capability) => (
          <li key={capability} className={s.capability}>
            <span className={s.capabilityDot} aria-hidden="true" />
            {capability}
          </li>
        ))}
      </ul>
      <div className={s.footnote}>
        <span>操作直接作用于本机且不可撤销，常规任务建议保持「询问」。</span>
        <button type="button" className={s.repoLink} onClick={() => void openExternalUrl(CUA_REPO_URL)}>
          trycua/cua
          <ExternalLink size={12} aria-hidden="true" />
        </button>
      </div>
      {message ? (
        <p className={s.message} data-tone="error" role="alert">
          {message}
        </p>
      ) : null}
      <InstallDialog
        open={installOpen}
        onOpenChange={setInstallOpen}
        onFinished={() => void queryClient.invalidateQueries({ queryKey: STATUS_KEY })}
      />
    </div>
  );
}

type InstallPhase = "confirm" | "running" | "done";

function InstallDialog({
  open,
  onOpenChange,
  onFinished,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFinished: () => void;
}) {
  const actions = useAgentSession();
  const [command, setCommand] = useState<ComputerUseInstallCommand | null>(null);
  const [phase, setPhase] = useState<InstallPhase>("confirm");
  const [log, setLog] = useState<string[]>([]);
  const [result, setResult] = useState<ComputerUseInstallResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!open || phase === "running") return;
    setPhase("confirm");
    setLog([]);
    setResult(null);
    setError(null);
    setCommand(null);
    actions
      .getComputerUseInstallCommand()
      .then(setCommand)
      .catch((cause: unknown) => setError(humanizeSidecarError(cause)));
    // 只在打开时取一次命令
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    const element = logRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [log]);

  const run = async () => {
    setPhase("running");
    setLog([]);
    setError(null);
    const unsubscribe = actions.onComputerUseInstallProgress(({ line }) =>
      setLog((previous) => [...previous, line].slice(-MAX_LOG_LINES)),
    );
    try {
      setResult(await actions.installComputerUse());
    } catch (cause) {
      setError(humanizeSidecarError(cause));
    } finally {
      unsubscribe();
      setPhase("done");
      onFinished();
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        // 安装进行中不允许关闭：关掉后看不到结果，脚本仍在后台运行
        if (phase !== "running") onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className={s.dialog}>
          <div className={s.dialogHead}>
            <div>
              <Dialog.Title asChild>
                <h2 className={s.dialogTitle}>安装驱动</h2>
              </Dialog.Title>
              <p className={s.dialogSub}>安装驱动 → 启用。完成当前步骤后继续下一步。</p>
            </div>
            <Dialog.Close asChild>
              <IconButton aria-label="关闭" disabled={phase === "running"}>
                <X size={16} aria-hidden="true" />
              </IconButton>
            </Dialog.Close>
          </div>
          <div className={s.dialogBody}>
            {command ? (
              <>
                <Dialog.Description asChild>
                  <p className={s.dialogText}>
                    将从 {command.sourceUrl} 下载并执行官方安装脚本，请确认命令内容（也可复制到终端手动运行）：
                  </p>
                </Dialog.Description>
                <div className={s.command}>
                  <code className={s.commandText}>{command.display}</code>
                  <CopyButton
                    text={command.display}
                    variant="ghost"
                    size="sm"
                    iconOnly
                    copiedLabel={null}
                    aria-label="复制命令"
                  >
                    <Copy size={14} aria-hidden="true" />
                  </CopyButton>
                </div>
                <p className={s.hint}>安装脚本默认注册开机自启任务，可能弹出管理员授权（UAC）。</p>
              </>
            ) : error ? null : (
              <p className={s.dialogText}>正在读取安装命令…</p>
            )}
            {phase !== "confirm" ? (
              <pre ref={logRef} className={s.log} aria-label="安装输出">
                {log.length > 0 ? log.join("\n") : "等待安装脚本输出…"}
              </pre>
            ) : null}
            {phase === "done" && result ? (
              <p className={s.message} data-tone={result.ok ? "ok" : "error"} role="status">
                {result.ok
                  ? "安装完成。回到设置页开启「启用 Computer Use」。"
                  : `安装失败（退出码 ${result.exitCode ?? "无"}）：${result.output.split("\n").slice(-3).join(" ")}`}
              </p>
            ) : null}
            {error ? (
              <p className={s.message} data-tone="error" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <div className={s.dialogFoot}>
            {phase === "done" ? (
              <Button variant="solid" tone="accent" onClick={() => onOpenChange(false)}>
                完成
              </Button>
            ) : (
              <Button
                variant="solid"
                tone="accent"
                loading={phase === "running"}
                disabled={!command || phase === "running"}
                onClick={() => void run()}
              >
                {phase === "running" ? "安装中…" : "确认运行"}
              </Button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
