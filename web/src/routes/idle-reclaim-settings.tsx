// 「空闲自动回收」设置（design.md 4.34，常规页下）：开关与空闲时长。
// 与 sidecar 通信只走 use-agent-session。
import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import type { SidecarSettings, SidecarSettingsPatch } from "@agentdeck/protocol";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import { sidecarConnectionAtom } from "@/stores/agents";
import settingsStyles from "./settings.module.css";
import s from "./snapshot-settings.module.css";

const SETTINGS_KEY = ["agentdeck", "sidecar-settings"] as const;
const MIN_IDLE_MINUTES = 1;
const MAX_IDLE_MINUTES = 1440;

function Row({ label, sub, right }: { label: string; sub?: string; right: ReactNode }) {
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

/** 分钟数输入：失焦或回车时提交；非法值（非 1–1440 的整数）还原并提示 */
function MinutesField({
  value,
  disabled,
  onCommit,
  onInvalid,
}: {
  value: number;
  disabled: boolean;
  onCommit: (value: number) => void;
  onInvalid: () => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const parsed = Number(text);
    if (!Number.isInteger(parsed) || parsed < MIN_IDLE_MINUTES || parsed > MAX_IDLE_MINUTES) {
      setText(String(value));
      onInvalid();
      return;
    }
    if (parsed !== value) onCommit(parsed);
  };
  return (
    <span className={s.numberField}>
      <input
        className={s.numberInput}
        type="text"
        inputMode="numeric"
        aria-label="空闲时长（分钟）"
        value={text}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
      <span className={s.unit}>分钟</span>
    </span>
  );
}

export function IdleReclaimSettingsSection() {
  const actions = useAgentSession();
  const queryClient = useQueryClient();
  const connected = useAtomValue(sidecarConnectionAtom) === "open";
  const [message, setMessage] = useState<string | null>(null);

  const settings = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => actions.getSidecarSettings(),
    enabled: connected,
    retry: false,
  });

  const save = useMutation({
    mutationFn: (patch: SidecarSettingsPatch) => actions.setSidecarSettings(patch),
    onSuccess: (next: SidecarSettings) => {
      queryClient.setQueryData(SETTINGS_KEY, next);
      setMessage(null);
    },
    onError: (error) => setMessage(`保存失败：${humanizeSidecarError(error)}`),
  });

  const current = settings.data?.idleReclaim;
  const toggleOptions = [
    { value: "off", label: "关闭" },
    { value: "on", label: "开启" },
  ];

  return (
    <>
      {!connected ? (
        <p className={settingsStyles.desc}>Agent 服务未连接，暂时无法读取或修改空闲自动回收设置。</p>
      ) : settings.error ? (
        <p className={settingsStyles.desc} role="alert">
          读取设置失败：{humanizeSidecarError(settings.error)}
        </p>
      ) : null}
      {current ? (
        <>
          <Row
            label="空闲自动回收"
            sub="会话空闲超过设定时长后自动结束其 Claude Code / Codex / ACP 进程以释放内存，会话转为「未加载」，下次发送消息时自动恢复。置顶会话不会被自动回收；也可在会话右键菜单手动「回收后台进程」。"
            right={
              <div className={settingsStyles.radioGroup}>
                {toggleOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={settingsStyles.radioBtn}
                    data-active={(option.value === "on") === current.enabled}
                    onClick={() => save.mutate({ idleReclaim: { enabled: option.value === "on" } })}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            }
          />
          <Row
            label="空闲时长（分钟）"
            sub="1–1440 分钟，默认 15"
            right={
              <MinutesField
                value={current.idleMinutes}
                disabled={!current.enabled}
                onCommit={(idleMinutes) => save.mutate({ idleReclaim: { idleMinutes } })}
                onInvalid={() =>
                  setMessage(`空闲时长需为 ${MIN_IDLE_MINUTES}–${MAX_IDLE_MINUTES} 之间的整数。`)
                }
              />
            }
          />
        </>
      ) : null}
      {message ? (
        <p className={s.message} data-tone="error" role="alert">
          {message}
        </p>
      ) : null}
    </>
  );
}
