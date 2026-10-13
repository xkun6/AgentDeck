// 设置 →「Agent 与中转」（design.md 4.7）：内置 Agent 的可用状态 + 自定义中转的增删改、启停。
// 列表数据来自 provider.list 与 provider.config.get；保存走 provider.config.set（整表替换）。
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bot, Pencil, Plus, SquareTerminal, Trash2, Waypoints } from "lucide-react";
import type { ProviderInfo, ProviderProfile } from "@agentdeck/protocol";
import { Alert, Badge, Button, EmptyState, IconButton, LoadingState } from "@agentdeck/shared-ui";
import { useAtomValue } from "jotai";
import { useAgentProviders } from "@/hooks/use-agent-catalog";
import { humanizeSidecarError } from "@/hooks/use-agent-session";
import { useProviderConfig, useSaveProviderConfig } from "@/hooks/use-provider-config";
import { useConfirm } from "@/lib/use-confirm";
import { SidecarRpcError } from "@/lib/sidecar-client";
import {
  customProviderId,
  isCustomProviderId,
  PROFILE_EXTENDS_LABELS,
  profileHasClaudeSettings,
  profileHost,
} from "@/lib/provider-profiles";
import { sidecarConnectionAtom } from "@/stores/agents";
import { ProviderFormDialog, type ProviderFormTarget } from "@/components/agent-providers/provider-form-dialog";
import { SectionShell } from "./section-shell";
import s from "./agent-providers.module.css";

type RowStatus = { tone: "success" | "warning" | "neutral"; label: string; reason?: string };

function builtinStatus(provider: ProviderInfo): RowStatus {
  return provider.available
    ? { tone: "success", label: "可用" }
    : { tone: "warning", label: "不可用", reason: provider.unavailableReason };
}

function relayStatus(profile: ProviderProfile, info: ProviderInfo | undefined, loaded: boolean): RowStatus {
  if (profile.enabled === false) return { tone: "neutral", label: "已停用" };
  if (!info) return loaded ? { tone: "warning", label: "未加载" } : { tone: "neutral", label: "检测中" };
  return info.available
    ? { tone: "success", label: "可用" }
    : { tone: "warning", label: "不可用", reason: info.unavailableReason };
}

function modelSummary(profile: ProviderProfile): string {
  const count = profile.models?.length ?? 0;
  return count > 0 ? `${count} 个模型` : "自动发现模型";
}

function Switch({ checked, label, disabled, onChange }: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={checked ? "已启用，点击停用" : "已停用，点击启用"}
      className={s.switch}
      data-on={checked ? "true" : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className={s.switchThumb} />
    </button>
  );
}

export function AgentProvidersRoute() {
  const navigate = useNavigate();
  const { confirm } = useConfirm();
  const connected = useAtomValue(sidecarConnectionAtom) === "open";
  const providersQuery = useAgentProviders();
  const configQuery = useProviderConfig();
  const saveConfig = useSaveProviderConfig();
  const [formTarget, setFormTarget] = useState<ProviderFormTarget | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  const providers = providersQuery.data ?? null;
  const builtins = (providers ?? []).filter((provider) => !provider.custom && !isCustomProviderId(provider.id));
  const infoById = new Map((providers ?? []).map((provider) => [provider.id, provider]));
  const profiles = configQuery.data?.providers ?? [];
  const configPath = configQuery.data?.path ?? null;
  const configLoaded = Boolean(configQuery.data);

  const saveList = async (next: ProviderProfile[], profileId: string) => {
    setPendingId(profileId);
    setPageError(null);
    try {
      await saveConfig(next);
    } catch (error) {
      setPageError(
        error instanceof SidecarRpcError && error.businessCode === "NOT_SUPPORTED"
          ? "未设置数据目录（AGENTDECK_DATA_DIR），无法保存中转配置。"
          : `保存失败：${humanizeSidecarError(error)}`,
      );
    } finally {
      setPendingId(null);
    }
  };

  const onToggle = (index: number, enabled: boolean) => {
    const target = profiles[index];
    if (!target) return;
    const next = profiles.map((profile, itemIndex) => {
      if (itemIndex !== index) return profile;
      const { enabled: _previous, ...rest } = profile;
      return enabled ? rest : { ...rest, enabled: false };
    });
    void saveList(next, target.id);
  };

  const onDelete = async (index: number) => {
    const target = profiles[index];
    if (!target) return;
    const ok = await confirm({
      title: `删除中转「${target.label}」？`,
      body: (
        <>
          将从 providers.json 中移除 <code>{customProviderId(target.id)}</code>
          {"。正在运行的会话可继续到关闭；之后使用它的历史会话将无法恢复。"}
        </>
      ),
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    void saveList(profiles.filter((_, itemIndex) => itemIndex !== index), target.id);
  };

  const addButton = (
    <Button
      variant="solid"
      tone="accent"
      size="sm"
      leadingIcon={<Plus size={12} />}
      disabled={!configLoaded}
      onClick={() => setFormTarget({ kind: "create" })}
    >
      添加中转
    </Button>
  );

  return (
    <SectionShell title="Agent 与中转" sub="内置 Agent 的可用状态，以及基于 Claude Code / Codex / ACP 的三方中转。">
      <div className={s.page}>
        {!connected ? (
          <Alert tone="warning" size="sm">Agent 服务未连接，正在重试…</Alert>
        ) : null}
        {pageError ? (
          <Alert tone="danger" size="sm">{pageError}</Alert>
        ) : null}

        <section className={s.section} aria-labelledby="agent-providers-builtin">
          <header className={s.sectionHead}>
            <div className={s.sectionTitleGroup}>
              <h2 id="agent-providers-builtin" className={s.sectionTitle}>内置 Agent</h2>
              <p className={s.sectionSub}>AgentDeck 直接驱动的本机 CLI。</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              leadingIcon={<SquareTerminal size={12} />}
              onClick={() => navigate("/coding-agents")}
            >
              CLI 安装与登录检测
            </Button>
          </header>
          {providersQuery.isLoading && !providers ? (
            <LoadingState variant="block" label="正在读取 Agent 列表…" />
          ) : providersQuery.error ? (
            <Alert tone="danger" size="sm">读取失败：{humanizeSidecarError(providersQuery.error)}</Alert>
          ) : (
            <ul className={s.list}>
              {builtins.map((provider) => {
                const status = builtinStatus(provider);
                return (
                  <li key={provider.id} className={s.row} data-provider-row={provider.id}>
                    <span className={s.rowIcon} aria-hidden="true"><Bot size={16} /></span>
                    <div className={s.rowMain}>
                      <div className={s.rowTitle}>
                        <span className={s.rowName}>{provider.label}</span>
                        <code className={s.rowId}>{provider.id}</code>
                      </div>
                      {status.reason ? <div className={s.rowReason}>{status.reason}</div> : null}
                    </div>
                    <div className={s.rowStatus}>
                      <Badge tone={status.tone} size="sm">{status.label}</Badge>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className={s.section} aria-labelledby="agent-providers-relay">
          <header className={s.sectionHead}>
            <div className={s.sectionTitleGroup}>
              <h2 id="agent-providers-relay" className={s.sectionTitle}>
                中转{profiles.length ? <span className={s.count}>{profiles.length}</span> : null}
              </h2>
              <p className={s.sectionSub}>同一个本机 CLI，换接口地址、密钥与模型；每项在 Agent 菜单中显示为独立一项。</p>
            </div>
            {profiles.length > 0 ? addButton : null}
          </header>

          {configQuery.isLoading && !configQuery.data ? (
            <LoadingState variant="block" label="正在读取中转配置…" />
          ) : configQuery.error ? (
            <Alert tone="danger" size="sm">读取失败：{humanizeSidecarError(configQuery.error)}</Alert>
          ) : profiles.length === 0 ? (
            <EmptyState
              icon={<Waypoints size={20} />}
              title="还没有中转"
              description="添加一个基于 Claude Code / Codex 的三方接口，或用 ACP 自定义命令接入其它 Agent。"
              actions={addButton}
            />
          ) : (
            <ul className={s.list}>
              {profiles.map((profile, index) => {
                const providerId = customProviderId(profile.id);
                const status = relayStatus(profile, infoById.get(providerId), Boolean(providers));
                const host = profile.extends === "acp" ? "" : profileHost(profile.baseUrl);
                // 未填 Base URL 但配置了 Claude 设置：地址可能来自 settings.env，不能断言是官方接口
                const hostLabel = host || (profileHasClaudeSettings(profile) ? "接口见 Claude 设置" : "官方接口");
                const busy = pendingId === profile.id;
                const enabled = profile.enabled !== false;
                return (
                  <li
                    key={profile.id}
                    className={s.row}
                    data-provider-row={providerId}
                    data-disabled={enabled ? undefined : "true"}
                  >
                    <span className={s.rowIcon} aria-hidden="true"><Waypoints size={16} /></span>
                    <div className={s.rowMain}>
                      <div className={s.rowTitle}>
                        <span className={s.rowName} title={profile.label}>{profile.label}</span>
                        <Badge tone="neutral" variant="outline" size="sm">
                          基于 {PROFILE_EXTENDS_LABELS[profile.extends]}
                        </Badge>
                        {profileHasClaudeSettings(profile) ? (
                          <Badge
                            tone="info"
                            variant="outline"
                            size="sm"
                            title="JSON 设置"
                          >
                            含设置
                          </Badge>
                        ) : null}
                      </div>
                      <div className={s.rowMeta}>
                        <code className={s.rowId}>{providerId}</code>
                        {profile.extends === "acp" ? (
                          <span className={s.rowHost} title={profile.command?.join(" ")}>
                            {profile.command?.[0] ?? "—"}
                          </span>
                        ) : (
                          <span className={s.rowHost} title={hostLabel}>{hostLabel}</span>
                        )}
                        <span>{modelSummary(profile)}</span>
                      </div>
                      {profile.description ? <div className={s.rowDesc}>{profile.description}</div> : null}
                      {status.reason ? <div className={s.rowReason}>{status.reason}</div> : null}
                    </div>
                    <div className={s.rowStatus}>
                      <Badge tone={status.tone} size="sm">{status.label}</Badge>
                    </div>
                    <div className={s.rowActions}>
                      <Switch
                        checked={enabled}
                        label={`${enabled ? "停用" : "启用"}中转 ${profile.label}`}
                        disabled={busy || pendingId !== null}
                        onChange={(next) => onToggle(index, next)}
                      />
                      <IconButton
                        aria-label={`编辑中转 ${profile.label}`}
                        title="编辑"
                        disabled={pendingId !== null}
                        onClick={() => setFormTarget({ kind: "edit", index })}
                      >
                        <Pencil size={12} />
                      </IconButton>
                      <IconButton
                        aria-label={`删除中转 ${profile.label}`}
                        title="删除"
                        tone="danger"
                        disabled={pendingId !== null}
                        onClick={() => void onDelete(index)}
                      >
                        <Trash2 size={12} />
                      </IconButton>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {configLoaded ? (
            configPath ? (
              <p className={s.footnote}>
                配置文件：<code>{configPath}</code>（密钥明文保存在本机）
              </p>
            ) : (
              <Alert tone="warning" size="sm">
                未设置数据目录（AGENTDECK_DATA_DIR），中转配置无法保存。请使用桌面端启动 AgentDeck。
              </Alert>
            )
          ) : null}
        </section>
      </div>

      <ProviderFormDialog
        target={formTarget}
        profiles={profiles}
        providers={providers}
        configPath={configPath}
        onClose={() => setFormTarget(null)}
      />
    </SectionShell>
  );
}
