// 新建会话：全屏流程，每项一行显示当前取值，点开底部面板选择（provider → 模型 → 模式，provider.list / provider.listModels）；
// 工作目录从现有会话的 cwd 去重后选择，也可手动输入路径。
// 危险模式（AgentMode.dangerous，跳过权限确认）标红，且绝不默认选中：初始模式恒为「默认」，只有用户明确点选才会带 modeId。
import { useMemo, useState, type ReactNode } from "react";
import { useAtomValue } from "jotai";
import { Bot, Check, Cpu, FolderOpen, Languages, ShieldCheck, X } from "lucide-react";
import { agentListAtom } from "@/stores/agents";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import { useAgentCatalog, useAgentProviders } from "@/hooks/use-agent-catalog";
import { useDraftTranslation } from "@/components/chat/translation-toggle";
import { isDangerousMode, resolveProvider } from "@/lib/agent-selection";
import { cwdBaseName, cwdKey, recentCwdOptions } from "./cwd-options";
import { ListRow, SwitchRow } from "./list-row";
import { Modal } from "./modal";
import s from "./mobile.module.css";

type Picker = "provider" | "model" | "mode" | "cwd";

interface PickerOption {
  key: string;
  title: string;
  supporting?: string;
  selected: boolean;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
}

function PickerSheet({
  open,
  label,
  options,
  status,
  onClose,
}: {
  open: boolean;
  label: string;
  options: PickerOption[];
  /** 列表上方的加载 / 错误提示 */
  status?: ReactNode;
  onClose: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} label={label} title={label}>
      {status}
      <div role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <ListRow
            key={option.key}
            role="radio"
            aria-checked={option.selected}
            title={option.title}
            supporting={option.supporting}
            danger={option.danger}
            disabled={option.disabled}
            trailing={option.selected ? <Check className={s.optionCheck} aria-hidden="true" /> : undefined}
            onClick={() => {
              option.onSelect();
              onClose();
            }}
          />
        ))}
      </div>
    </Modal>
  );
}

export function NewSession({ onCreated, onClose }: { onCreated: (agentId: string) => void; onClose?: () => void }) {
  const actions = useAgentSession();
  const agents = useAtomValue(agentListAtom);
  const providersQuery = useAgentProviders();
  const providers = providersQuery.data ?? null;
  const cwdOptions = useMemo(() => recentCwdOptions(agents), [agents]);

  const [pickedProvider, setPickedProvider] = useState<string | null>(null);
  const [pickedModel, setPickedModel] = useState<string | null>(null);
  const [pickedMode, setPickedMode] = useState<string | null>(null);
  const [pickedCwd, setPickedCwd] = useState<string | null>(null);
  const [manualCwd, setManualCwd] = useState("");
  const [manualSelected, setManualSelected] = useState(false);
  const translation = useDraftTranslation();
  const [picker, setPicker] = useState<Picker | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const provider = resolveProvider(pickedProvider, providers);
  // 默认选最近使用的目录；也可以随时选「手动输入路径」；没有任何会话可参考时只能手动输入
  const manualMode = manualSelected || cwdOptions.length === 0;
  const cwd = manualMode ? manualCwd.trim() || null : (pickedCwd ?? cwdOptions[0]?.cwd ?? null);
  const catalogQuery = useAgentCatalog(provider, cwd ?? "");
  const models = catalogQuery.data?.models ?? [];
  const modes = catalogQuery.data?.modes ?? [];
  const model = pickedModel && models.some((m) => m.id === pickedModel) ? pickedModel : null;
  const mode = pickedMode && modes.some((m) => m.id === pickedMode) ? pickedMode : null;
  const providerLabel = providers?.find((item) => item.id === provider)?.label;
  const modelLabel = models.find((item) => item.id === model)?.label ?? "默认模型";
  const modeInfo = modes.find((item) => item.id === mode);
  const closePicker = () => setPicker(null);
  const providerStatus = providersQuery.isLoading ? (
    <div className={s.hint}>正在读取 Agent 列表…</div>
  ) : providersQuery.error ? (
    <div className={s.error}>{humanizeSidecarError(providersQuery.error)}</div>
  ) : null;
  const catalogStatus = catalogQuery.isLoading ? (
    <div className={s.hint}>正在读取…</div>
  ) : catalogQuery.error ? (
    <div className={s.error}>{humanizeSidecarError(catalogQuery.error)}</div>
  ) : null;

  const create = async () => {
    if (!provider || !cwd) return;
    setBusy(true);
    setError(null);
    try {
      const agent = await actions.createSession({
        provider,
        cwd,
        ...(model ? { model } : {}),
        ...(mode ? { modeId: mode } : {}),
        ...(translation.picked !== undefined ? { translation: translation.picked } : {}),
      });
      onCreated(agent.id);
    } catch (e) {
      setError(humanizeSidecarError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.page} data-motion="modal">
      <header className={s.header}>
        {onClose ? (
          <button type="button" className={s.iconButton} onClick={onClose} aria-label="关闭">
            <X aria-hidden="true" />
          </button>
        ) : null}
        <h1 className={onClose ? s.titleSmall : s.title}>新建会话</h1>
        <button type="button" className={s.barButton} disabled={busy || !provider || !cwd} onClick={() => void create()}>
          {busy ? "创建中…" : "创建"}
        </button>
      </header>
      <div className={s.body} data-flush="true">
        {error ? (
          <div className={s.error} role="alert">
            {error}
          </div>
        ) : null}
        {providersQuery.error ? <div className={s.error}>{humanizeSidecarError(providersQuery.error)}</div> : null}
        <div>
          <ListRow
            icon={<Bot aria-hidden="true" />}
            title="Agent"
            supporting={providersQuery.isLoading ? "正在读取 Agent 列表…" : (providerLabel ?? "未选择")}
            chevron
            onClick={() => setPicker("provider")}
          />
          <ListRow
            icon={<Cpu aria-hidden="true" />}
            title="模型"
            supporting={modelLabel}
            chevron
            onClick={() => setPicker("model")}
          />
          <ListRow
            icon={<ShieldCheck aria-hidden="true" />}
            title="模式"
            supporting={
              modeInfo ? (
                isDangerousMode(modeInfo) ? (
                  <span className={s.textDanger}>{modeInfo.label}（跳过权限确认）</span>
                ) : (
                  modeInfo.label
                )
              ) : (
                "默认模式"
              )
            }
            chevron
            onClick={() => setPicker("mode")}
          />
          <ListRow
            icon={<FolderOpen aria-hidden="true" />}
            title="工作目录"
            supporting={manualMode ? "手动输入路径" : cwd ? cwdBaseName(cwd) : "未选择"}
            chevron
            onClick={() => setPicker("cwd")}
          />
          {manualMode ? (
            <label className={s.field}>
              <span>{cwdOptions.length > 0 ? "输入电脑上的目录路径" : "还没有会话可参考，请输入电脑上的目录路径"}</span>
              <input
                className={s.control}
                value={manualCwd}
                placeholder="例如 J:/Program/MyProject"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => setManualCwd(e.target.value)}
              />
            </label>
          ) : cwd ? (
            <div className={s.hint} data-mono="true">
              {cwd}
            </div>
          ) : null}
          <SwitchRow
            icon={<Languages aria-hidden="true" />}
            title="翻译"
            supporting="消息译成 Agent 语言发送，回复显示译文"
            checked={translation.on}
            onChange={(value) => translation.set(value)}
          />
        </div>
      </div>

      <PickerSheet
        open={picker === "provider"}
        label="Agent"
        onClose={closePicker}
        status={providerStatus}
        options={(providers ?? []).map((item) => ({
          key: item.id,
          title: item.label,
          supporting: item.available ? undefined : (item.unavailableReason ?? "不可用"),
          selected: provider === item.id,
          disabled: !item.available,
          onSelect: () => {
            setPickedProvider(item.id);
            setPickedModel(null);
            setPickedMode(null);
          },
        }))}
      />
      <PickerSheet
        open={picker === "model"}
        label="模型"
        onClose={closePicker}
        status={catalogStatus}
        options={[
          { key: "", title: "默认模型", selected: model === null, onSelect: () => setPickedModel(null) },
          ...models.map((item) => ({
            key: item.id,
            title: item.label,
            selected: model === item.id,
            onSelect: () => setPickedModel(item.id),
          })),
        ]}
      />
      <PickerSheet
        open={picker === "mode"}
        label="模式"
        onClose={closePicker}
        status={catalogStatus}
        options={[
          { key: "", title: "默认模式", selected: mode === null, onSelect: () => setPickedMode(null) },
          ...modes.map((item) => {
            const dangerous = isDangerousMode(item);
            return {
              key: item.id,
              title: item.label,
              supporting: dangerous ? "跳过权限确认" : undefined,
              selected: mode === item.id,
              danger: dangerous,
              onSelect: () => setPickedMode(item.id),
            };
          }),
        ]}
      />
      <PickerSheet
        open={picker === "cwd"}
        label="工作目录"
        onClose={closePicker}
        options={[
          ...cwdOptions.map((item) => ({
            key: cwdKey(item.cwd),
            title: cwdBaseName(item.cwd),
            supporting: item.cwd,
            selected: !manualMode && cwd !== null && cwdKey(cwd) === cwdKey(item.cwd),
            onSelect: () => {
              setManualSelected(false);
              setPickedCwd(item.cwd);
            },
          })),
          {
            key: "manual",
            title: "手动输入路径",
            supporting: "电脑上的其它目录",
            selected: manualMode,
            onSelect: () => setManualSelected(true),
          },
        ]}
      />
    </div>
  );
}
