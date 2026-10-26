// 「翻译」设置页（design.md 4.35）：翻译 endpoint、语言与开关。与 sidecar 通信只走 use-agent-session。
import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import type { SidecarSettings, SidecarSettingsPatch, TranslationEndpoint } from "@agentdeck/protocol";
import { humanizeSidecarError, useAgentSession } from "@/hooks/use-agent-session";
import { sidecarConnectionAtom } from "@/stores/agents";
import settingsStyles from "./settings.module.css";
import s from "./snapshot-settings.module.css";

const SETTINGS_KEY = ["agentdeck", "sidecar-settings"] as const;
const ENDPOINT_KEY = ["agentdeck", "translation-endpoint"] as const;
const TEST_TEXT = "Translation is working. Replies from the agent will be shown in your language.";

const PROTOCOL_OPTIONS: { value: TranslationEndpoint["protocol"]; label: string }[] = [
  { value: "chat-completions", label: "Chat Completions" },
  { value: "responses", label: "Responses" },
];

const EFFORT_OPTIONS: { value: TranslationEndpoint["reasoningEffort"]; label: string }[] = [
  { value: "default", label: "默认" },
  { value: "none", label: "关闭" },
  { value: "minimal", label: "最低" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
];

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

function Choice<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className={settingsStyles.radioGroup}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={settingsStyles.radioBtn}
          data-active={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** 文本输入：失焦或回车时提交；空串按 allowEmpty 决定是否还原 */
function TextField({
  value,
  label,
  type = "text",
  placeholder,
  allowEmpty = false,
  onCommit,
}: {
  value: string;
  label: string;
  type?: "text" | "password";
  placeholder?: string;
  allowEmpty?: boolean;
  onCommit: (value: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    const next = text.trim();
    if (!next && !allowEmpty) {
      setText(value);
      return;
    }
    if (next !== value) onCommit(next);
  };
  return (
    <input
      className={settingsStyles.input}
      data-mono="true"
      type={type}
      aria-label={label}
      placeholder={placeholder}
      value={text}
      autoComplete="off"
      spellCheck={false}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
    />
  );
}

export function TranslationSettingsSection() {
  const actions = useAgentSession();
  const queryClient = useQueryClient();
  const connected = useAtomValue(sidecarConnectionAtom) === "open";
  const [message, setMessage] = useState<{ tone: "error" | "info"; text: string } | null>(null);

  const settings = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => actions.getSidecarSettings(),
    enabled: connected,
    retry: false,
  });
  const endpoint = useQuery({
    queryKey: ENDPOINT_KEY,
    queryFn: () => actions.getTranslationEndpoint(),
    enabled: connected,
    retry: false,
  });

  const saveSettings = useMutation({
    mutationFn: (patch: SidecarSettingsPatch) => actions.setSidecarSettings(patch),
    onSuccess: (next: SidecarSettings) => {
      queryClient.setQueryData(SETTINGS_KEY, next);
      setMessage(null);
    },
    onError: (error) => setMessage({ tone: "error", text: `保存失败：${humanizeSidecarError(error)}` }),
  });
  const saveEndpoint = useMutation({
    mutationFn: (patch: Partial<TranslationEndpoint>) => actions.setTranslationEndpoint(patch),
    onSuccess: (next: TranslationEndpoint) => {
      queryClient.setQueryData(ENDPOINT_KEY, next);
      setMessage(null);
    },
    onError: (error) => setMessage({ tone: "error", text: `保存失败：${humanizeSidecarError(error)}` }),
  });
  const test = useMutation({
    mutationFn: () => actions.translateText("agent-to-user", TEST_TEXT),
    onSuccess: (text) => setMessage({ tone: "info", text: `测试成功：${text}` }),
    onError: (error) => setMessage({ tone: "error", text: `测试失败：${humanizeSidecarError(error)}` }),
  });

  const current = settings.data?.translation;
  const ep = endpoint.data;
  const loadError = settings.error ?? endpoint.error;
  const toggleOptions = [
    { value: "off", label: "关闭" },
    { value: "on", label: "开启" },
  ] as const;

  return (
    <>
      <p className={settingsStyles.desc}>
        开启翻译的会话里，你的消息会先翻译成 Agent 语言再发送，Agent 的回复在界面上显示为你的语言（可切换查看原文）。
        翻译调用你在这里配置的 OpenAI 兼容接口，会产生该接口的费用；这是 AgentDeck 唯一直接调用模型接口的功能，默认不启用。
        会话里用输入框旁的「翻译」按钮开关。
      </p>
      {!connected ? (
        <p className={settingsStyles.desc}>Agent 服务未连接，暂时无法读取或修改翻译设置。</p>
      ) : loadError ? (
        <p className={settingsStyles.desc} role="alert">
          读取设置失败：{humanizeSidecarError(loadError)}
        </p>
      ) : null}
      {ep ? (
        <>
          <h3 className={s.subheading}>翻译接口</h3>
          <Row
            label="接口地址"
            sub="OpenAI 兼容接口的 Base URL，如 https://api.deepseek.com/v1；请求发到其下的 /chat/completions 或 /responses"
            right={
              <TextField
                label="接口地址"
                value={ep.baseUrl}
                placeholder="https://…/v1"
                allowEmpty
                onCommit={(baseUrl) => saveEndpoint.mutate({ baseUrl })}
              />
            }
          />
          <Row
            label="API Key"
            sub="留空则不带 Authorization 头；只保存在本机"
            right={
              <TextField
                label="API Key"
                type="password"
                value={ep.apiKey}
                allowEmpty
                onCommit={(apiKey) => saveEndpoint.mutate({ apiKey })}
              />
            }
          />
          <Row
            label="模型"
            sub="建议用响应快的小模型；用户消息每次发送都要等一次翻译"
            right={
              <TextField
                label="模型"
                value={ep.model}
                allowEmpty
                onCommit={(model) => saveEndpoint.mutate({ model })}
              />
            }
          />
          <Row
            label="接口协议"
            sub="接口没有 /responses 时选 Chat Completions"
            right={
              <Choice
                options={PROTOCOL_OPTIONS}
                value={ep.protocol}
                onChange={(protocol) => saveEndpoint.mutate({ protocol })}
              />
            }
          />
          <Row
            label="思考强度"
            sub="随请求发送的 reasoning effort；「默认」不发送该参数"
            right={
              <Choice
                options={EFFORT_OPTIONS}
                value={ep.reasoningEffort}
                onChange={(reasoningEffort) => saveEndpoint.mutate({ reasoningEffort })}
              />
            }
          />
          <Row
            label="超时（秒）"
            sub="单次翻译请求的超时，1–600 秒"
            right={
              <TextField
                label="超时（秒）"
                value={String(Math.round(ep.timeoutMs / 1000))}
                onCommit={(text) => {
                  const seconds = Number(text);
                  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) {
                    setMessage({ tone: "error", text: "超时需为 1–600 之间的整数秒。" });
                    return;
                  }
                  saveEndpoint.mutate({ timeoutMs: seconds * 1000 });
                }}
              />
            }
          />
          <Row
            label="测试"
            sub="用当前已保存的配置翻译一句示例文本"
            right={
              <button
                type="button"
                className={settingsStyles.btn}
                disabled={test.isPending}
                onClick={() => {
                  setMessage(null);
                  test.mutate();
                }}
              >
                {test.isPending ? "测试中…" : "测试"}
              </button>
            }
          />
        </>
      ) : null}
      {current ? (
        <>
          <h3 className={s.subheading}>语言与显示</h3>
          <Row
            label="你的语言"
            sub="回复翻译成这种语言显示，如 简体中文"
            right={
              <TextField
                label="你的语言"
                value={current.userLanguage}
                onCommit={(userLanguage) => saveSettings.mutate({ translation: { userLanguage } })}
              />
            }
          />
          <Row
            label="Agent 语言"
            sub="你的消息翻译成这种语言再发给 Agent，如 English"
            right={
              <TextField
                label="Agent 语言"
                value={current.agentLanguage}
                onCommit={(agentLanguage) => saveSettings.mutate({ translation: { agentLanguage } })}
              />
            }
          />
          <Row
            label="翻译我的输入"
            sub="消息与审批回答先翻成 Agent 语言再发送；关闭后原样发送，只翻译回复"
            right={
              <Choice
                options={[...toggleOptions]}
                value={current.translateInput ? "on" : "off"}
                onChange={(value) => saveSettings.mutate({ translation: { translateInput: value === "on" } })}
              />
            }
          />
          <Row
            label="翻译思考过程"
            sub="展开思考块时也显示译文；思考往往很长，会明显增加翻译费用"
            right={
              <Choice
                options={[...toggleOptions]}
                value={current.translateReasoning ? "on" : "off"}
                onChange={(value) => saveSettings.mutate({ translation: { translateReasoning: value === "on" } })}
              />
            }
          />
          <Row
            label="新会话默认开启"
            sub="之后新建的会话自动开启翻译；已有会话不受影响"
            right={
              <Choice
                options={[...toggleOptions]}
                value={current.enabledByDefault ? "on" : "off"}
                onChange={(value) => saveSettings.mutate({ translation: { enabledByDefault: value === "on" } })}
              />
            }
          />
        </>
      ) : null}
      {message ? (
        <p className={s.message} data-tone={message.tone === "error" ? "error" : undefined} role="alert">
          {message.text}
        </p>
      ) : null}
    </>
  );
}
