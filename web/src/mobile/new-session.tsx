// 新建会话：provider → 模型 → 模式（provider.list / provider.listModels）；工作目录从现有会话的 cwd 去重后选择，也可手动输入路径。
// 危险模式（AgentMode.dangerous，跳过权限确认）标红，且绝不默认选中：初始模式恒为「默认」，只有用户明确点选才会带 modeId。
import { useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { Check, X } from "lucide-react";
import { agentListAtom } from "@/stores/agents";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import { useAgentCatalog, useAgentProviders } from "@/hooks/use-agent-catalog";
import { useDraftTranslation } from "@/components/chat/translation-toggle";
import { isDangerousMode, resolveProvider } from "@/lib/agent-selection";
import { cwdBaseName, cwdKey, recentCwdOptions } from "./cwd-options";
import s from "./mobile.module.css";

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
    <div className={s.page}>
      <header className={s.header}>
        {onClose ? (
          <button type="button" className={s.iconButton} onClick={onClose} aria-label="关闭">
            <X aria-hidden="true" />
          </button>
        ) : null}
        <h1 className={onClose ? s.titleSmall : s.title}>新建会话</h1>
      </header>
      <div className={s.body}>
        <section className={s.section} aria-label="Agent">
          <h2 className={s.sectionTitle}>Agent</h2>
          {providersQuery.isLoading ? <div className={s.hint}>正在读取 Agent 列表…</div> : null}
          {providersQuery.error ? <div className={s.error}>{humanizeSidecarError(providersQuery.error)}</div> : null}
          <div className={s.optionGroup} role="radiogroup" aria-label="Agent">
            {(providers ?? []).map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={provider === item.id}
                className={s.option}
                data-selected={provider === item.id ? "true" : undefined}
                disabled={!item.available}
                title={item.available ? undefined : item.unavailableReason}
                onClick={() => {
                  setPickedProvider(item.id);
                  setPickedModel(null);
                  setPickedMode(null);
                }}
              >
                {item.label}
                {item.available ? null : <span className={s.optionNote}>不可用</span>}
              </button>
            ))}
          </div>
        </section>

        <section className={s.section} aria-label="模型">
          <h2 className={s.sectionTitle}>模型</h2>
          <div className={s.optionGroup} role="radiogroup" aria-label="模型">
            <button
              type="button"
              role="radio"
              aria-checked={model === null}
              className={s.option}
              data-selected={model === null ? "true" : undefined}
              onClick={() => setPickedModel(null)}
            >
              默认模型
            </button>
            {models.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={model === item.id}
                className={s.option}
                data-selected={model === item.id ? "true" : undefined}
                onClick={() => setPickedModel(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </section>

        <section className={s.section} aria-label="模式">
          <h2 className={s.sectionTitle}>模式</h2>
          <div className={s.optionGroup} role="radiogroup" aria-label="模式">
            <button
              type="button"
              role="radio"
              aria-checked={mode === null}
              className={s.option}
              data-selected={mode === null ? "true" : undefined}
              onClick={() => setPickedMode(null)}
            >
              默认模式
            </button>
            {modes.map((item) => {
              const dangerous = isDangerousMode(item);
              return (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={mode === item.id}
                  className={s.option}
                  data-selected={mode === item.id ? "true" : undefined}
                  data-danger={dangerous ? "true" : undefined}
                  onClick={() => setPickedMode(item.id)}
                >
                  {item.label}
                  {dangerous ? <span className={s.optionNote}>跳过权限确认</span> : null}
                </button>
              );
            })}
          </div>
        </section>

        <section className={s.section} aria-label="工作目录">
          <h2 className={s.sectionTitle}>工作目录</h2>
          {cwdOptions.length > 0 ? (
            <div className={s.optionGroup} role="radiogroup" aria-label="工作目录">
              {cwdOptions.map((item) => {
                const selected = !manualMode && cwd !== null && cwdKey(cwd) === cwdKey(item.cwd);
                return (
                  <button
                    key={cwdKey(item.cwd)}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={s.optionWide}
                    data-selected={selected ? "true" : undefined}
                    onClick={() => {
                      setManualSelected(false);
                      setPickedCwd(item.cwd);
                    }}
                  >
                    <span className={s.optionText}>
                      <span className={s.rowTitle}>{cwdBaseName(item.cwd)}</span>
                      <span className={s.rowMeta}>{item.cwd}</span>
                    </span>
                    {selected ? <Check className={s.optionCheck} aria-hidden="true" /> : null}
                  </button>
                );
              })}
              <button
                type="button"
                role="radio"
                aria-checked={manualMode}
                className={s.optionWide}
                data-selected={manualMode ? "true" : undefined}
                onClick={() => setManualSelected(true)}
              >
                <span className={s.optionText}>
                  <span className={s.rowTitle}>手动输入路径</span>
                  <span className={s.rowMeta}>电脑上的其它目录</span>
                </span>
                {manualMode ? <Check className={s.optionCheck} aria-hidden="true" /> : null}
              </button>
            </div>
          ) : null}
          {manualMode ? (
            <label className={s.field}>
              <span>{cwdOptions.length > 0 ? "输入电脑上的目录路径" : "还没有会话可参考，请输入电脑上的目录路径"}</span>
              <input
                className={s.control}
                value={manualCwd}
                placeholder="例如 J:/Program/MyProject"
                onChange={(e) => setManualCwd(e.target.value)}
              />
            </label>
          ) : null}
        </section>

        <section className={s.section} aria-label="翻译">
          <h2 className={s.sectionTitle}>翻译</h2>
          <div className={s.optionGroup} role="radiogroup" aria-label="翻译">
            {([false, true] as const).map((value) => (
              <button
                key={String(value)}
                type="button"
                role="radio"
                aria-checked={translation.on === value}
                className={s.option}
                data-selected={translation.on === value ? "true" : undefined}
                onClick={() => translation.set(value)}
              >
                {value ? "开启" : "关闭"}
                {value ? <span className={s.optionNote}>消息译成 Agent 语言发送，回复显示译文</span> : null}
              </button>
            ))}
          </div>
        </section>

      </div>
      <div className={s.footerBar}>
        {error ? (
          <div className={s.error} role="alert">
            {error}
          </div>
        ) : null}
        <button type="button" className={s.primaryButton} disabled={busy || !provider || !cwd} onClick={() => void create()}>
          {busy ? "创建中…" : "创建会话"}
        </button>
      </div>
    </div>
  );
}
