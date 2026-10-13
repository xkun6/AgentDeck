// 「会话互通」设置页（design.md 4.26，高级设置下）：开关 sidecar 的 agentdeck MCP 服务端与自动注入。
// 与 sidecar 通信只走 use-agent-session。
import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import type { SidecarSettings, SidecarSettingsPatch } from "@agentdeck/protocol";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import { sidecarConnectionAtom } from "@/stores/agents";
import settingsStyles from "./settings.module.css";
import s from "./snapshot-settings.module.css";

const SETTINGS_KEY = ["agentdeck", "sidecar-settings"] as const;

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

export function InteropSettingsSection({ showHeading = true }: { showHeading?: boolean }) {
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

  const current = settings.data?.interop;
  const toggleOptions = [
    { value: "off", label: "关闭" },
    { value: "on", label: "开启" },
  ];

  return (
    <div>
      {showHeading ? <h2 className={settingsStyles.heading}>会话互通</h2> : null}
      {!connected ? (
        <p className={settingsStyles.desc}>Agent 服务未连接，暂时无法读取或修改会话互通设置。</p>
      ) : settings.error ? (
        <p className={settingsStyles.desc} role="alert">
          读取设置失败：{humanizeSidecarError(settings.error)}
        </p>
      ) : null}
      {current ? (
        <Row
          label="允许会话互相调用"
          sub="开启后，AgentDeck 会给每个会话注入一个本机 MCP 服务（agentdeck），Agent 可以委派任务给其它 Agent、读取或向其它会话发消息。子会话的权限请求仍由你在界面审批；新注入对新启动、恢复的会话生效，关闭后 MCP 端点立即拒绝请求。"
          right={
            <div className={settingsStyles.radioGroup}>
              {toggleOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={settingsStyles.radioBtn}
                  data-active={(option.value === "on") === current.enabled}
                  onClick={() => save.mutate({ interop: { enabled: option.value === "on" } })}
                >
                  {option.label}
                </button>
              ))}
            </div>
          }
        />
      ) : null}
      {message ? (
        <p className={s.message} data-tone="error" role="alert">
          {message}
        </p>
      ) : null}
    </div>
  );
}
