// 会话翻译开关与时间线翻译状态（design.md 4.35）。与 sidecar 通信只走 use-agent-session。
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { Languages } from "lucide-react";
import type { AgentSnapshot } from "@agentdeck/protocol";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import { sidecarConnectionAtom } from "@/stores/agents";
import type { TimelineTranslation } from "./translated-text";
import s from "./translation-toggle.module.css";

const SETTINGS_KEY = ["agentdeck", "sidecar-settings"] as const;

/** 时间线翻译状态：会话开关 + 全局「翻译思考」设置 */
export function useSessionTranslation(snapshot: AgentSnapshot | undefined): TimelineTranslation {
  const actions = useAgentSession();
  const connected = useAtomValue(sidecarConnectionAtom) === "open";
  const enabled = snapshot?.translation === true;
  const settings = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => actions.getSidecarSettings(),
    enabled: connected && enabled,
    retry: false,
  });
  const translateReasoning = settings.data?.translation.translateReasoning ?? false;
  return useMemo(() => ({ enabled, translateReasoning }), [enabled, translateReasoning]);
}

function ToggleButton({
  on,
  error,
  disabled,
  onClick,
}: {
  on: boolean;
  error?: string | null;
  disabled?: boolean;
  onClick: () => void;
}) {
  const title = error
    ? `切换翻译失败：${error}`
    : on
      ? "翻译已开启：回复显示译文，是否翻译你的消息见设置「翻译」。点击关闭"
      : "开启翻译：回复显示译文，是否翻译你的消息见设置「翻译」（需先在设置中配置）";
  return (
    <button
      type="button"
      className={s.toggle}
      data-on={on ? "true" : undefined}
      data-error={error ? "true" : undefined}
      aria-pressed={on}
      aria-label="翻译"
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      <Languages size={16} strokeWidth={1.75} aria-hidden />
    </button>
  );
}

/** 输入框工具栏「译」开关 */
export function TranslationToggle({ snapshot, disabled }: { snapshot: AgentSnapshot; disabled?: boolean }) {
  const actions = useAgentSession();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = snapshot.translation === true;
  return (
    <ToggleButton
      on={on}
      error={error}
      disabled={disabled || saving}
      onClick={() => {
        setSaving(true);
        setError(null);
        actions
          .updateSession(snapshot.id, { translation: !on })
          .catch((cause: unknown) => setError(humanizeSidecarError(cause)))
          .finally(() => setSaving(false));
      }}
    />
  );
}

/**
 * 新任务输入框的翻译开关：初始跟随「新会话默认开启」；用户点过后返回显式值，
 * 未点过返回 undefined（创建时省略，由 sidecar 取默认值）。
 */
export function useDraftTranslation() {
  const actions = useAgentSession();
  const connected = useAtomValue(sidecarConnectionAtom) === "open";
  const settings = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => actions.getSidecarSettings(),
    enabled: connected,
    retry: false,
  });
  const [picked, setPicked] = useState<boolean | undefined>(undefined);
  // 手机可能连着没有翻译设置的旧版电脑端：translation 缺失按关闭
  const on = picked ?? settings.data?.translation?.enabledByDefault ?? false;
  return { on, picked, set: setPicked };
}

export function DraftTranslationToggle({ on, onToggle, disabled }: { on: boolean; onToggle: () => void; disabled?: boolean }) {
  return <ToggleButton on={on} disabled={disabled} onClick={onToggle} />;
}
