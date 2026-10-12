import { useRef, useState, type CSSProperties } from "react";
import { useAtom } from "jotai";
import { Bug, FileText, Image as ImageIcon, Info, Scale, Upload, X } from "lucide-react";
import { Button, useTheme, type ThemeConfig } from "@agentdeck/shared-ui";
import {
  CONVERSATION_FONT_SIZE_OPTIONS,
  DEFAULT_ASSISTANT_DISPLAY_NAME,
  assistantAvatarDataUrlAtom,
  assistantDisplayNameAtom,
  composerSubmitShortcutAtom,
  conversationFontSizeAtom,
  notifyOnApprovalAtom,
  notifyOnCompleteAtom,
  notifyOnlyBackgroundAtom,
  notifySoundAtom,
  notifySystemAtom,
  showReasoningAtom,
  normalizeAssistantDisplayName,
  type ConversationFontSizeMode,
} from "@/stores/ui";
import { playChime, shouldPlayFallbackSound } from "@/lib/notifications";
import { detectHostOS } from "@/lib/runtime";
import { BUILD_COMMIT, BUILD_DATE, DESKTOP_VERSION, versionLabel } from "@/lib/build-info";
import type { ComposerSubmitShortcut } from "@/lib/composer-submit-shortcut";
import noticeText from "../../../NOTICE.md?raw";
import s from "./settings.module.css";

/* ── General ─────────────────────────────────────────────────────────── */

interface SettingsSectionProps {
  showHeading?: boolean;
}

export function GeneralSection({ showHeading = true }: SettingsSectionProps) {
  const [showReasoning, setShowReasoning] = useAtom(showReasoningAtom);
  const [composerSubmitShortcut, setComposerSubmitShortcut] = useAtom(composerSubmitShortcutAtom);
  const [assistantDisplayName, setAssistantDisplayName] = useAtom(assistantDisplayNameAtom);
  const [assistantAvatarDataUrl, setAssistantAvatarDataUrl] = useAtom(assistantAvatarDataUrlAtom);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const [assistantProfileError, setAssistantProfileError] = useState("");

  const handleAssistantNameChange = (value: string) => {
    setAssistantProfileError("");
    setAssistantDisplayName(value);
  };

  const handleAvatarFile = async (file: File | undefined) => {
    if (!file) return;
    setAssistantProfileError("");
    if (!file.type.startsWith("image/")) {
      setAssistantProfileError("请选择 PNG、JPG、WebP、GIF 或 SVG 图片。");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setAssistantProfileError("头像图片不能超过 2 MB。");
      return;
    }
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(reader.error ?? new Error("读取头像失败"));
        reader.readAsDataURL(file);
      });
      if (!dataUrl.startsWith("data:image/")) {
        setAssistantProfileError("头像文件格式不受支持。");
        return;
      }
      setAssistantAvatarDataUrl(dataUrl);
    } catch (error) {
      setAssistantProfileError(error instanceof Error ? error.message : "读取头像失败");
    } finally {
      if (avatarInputRef.current) avatarInputRef.current.value = "";
    }
  };

  return (
    <div>
      {showHeading && <h2 className={s.heading}>常规</h2>}
      <Row label="显示推理过程" sub="在会话中展示模型的思考和推理内容" right={
        <RadioGroup value={showReasoning ? "on" : "off"} options={[{ value: "off", label: "隐藏" }, { value: "on", label: "显示" }]} onChange={(v) => setShowReasoning(v === "on")} />
      } />
      <Row label="发送快捷键" sub="控制对话输入框的提交方式；未触发发送的 Enter 会保留为换行。" right={
        <RadioGroup value={composerSubmitShortcut} options={[{ value: "enter", label: "Enter 发送" }, { value: "ctrl-enter", label: "Ctrl+Enter 发送" }]} onChange={(v) => setComposerSubmitShortcut(v as ComposerSubmitShortcut)} />
      } />
      <Row label="助手名称" sub="显示在助手消息上方的名称；留空时按会话所用的 Agent 显示（如 Claude Code）。" right={
        <div className={s.assistantProfileControl}>
          <input
            className={s.assistantNameInput}
            value={assistantDisplayName}
            placeholder="按会话所用 Agent 显示"
            maxLength={40}
            onChange={(event) => handleAssistantNameChange(event.target.value)}
            onBlur={(event) => setAssistantDisplayName(normalizeAssistantDisplayName(event.target.value))}
          />
          {assistantDisplayName !== DEFAULT_ASSISTANT_DISPLAY_NAME ? (
            <button
              type="button"
              className={s.iconPlainButton}
              onClick={() => handleAssistantNameChange("")}
              title="恢复默认名称"
            >
              <X size={12} />
            </button>
          ) : null}
        </div>
      } />
      <Row label="助手头像" sub="上传后会显示在助手的对话消息旁；不设置时显示 Agent 名称首字。" right={
        <div className={s.assistantAvatarControl}>
          <input
            ref={avatarInputRef}
            className={s.hiddenFileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
            onChange={(event) => void handleAvatarFile(event.target.files?.[0])}
          />
          {assistantAvatarDataUrl ? (
            <img className={s.assistantAvatarPreview} src={assistantAvatarDataUrl} alt="助手头像预览" />
          ) : (
            <span className={s.assistantAvatarPlaceholder}><ImageIcon size={16} /></span>
          )}
          <button type="button" className={s.btn} onClick={() => avatarInputRef.current?.click()}>
            <Upload size={12} /> 上传
          </button>
          {assistantAvatarDataUrl ? (
            <button type="button" className={s.btn} onClick={() => { setAssistantProfileError(""); setAssistantAvatarDataUrl(""); }}>
              移除
            </button>
          ) : null}
        </div>
      } />
      {assistantProfileError ? <p className={s.assistantProfileError}>{assistantProfileError}</p> : null}
      <p className={s.assistantProfileStorageHint}>名称和头像只改变桌面端显示，不影响模型本身。清空名称、移除头像后即可恢复默认样式。</p>
    </div>
  );
}

/* ── Notifications ───────────────────────────────────────────────────── */

type NotifyTestState =
  | { phase: "idle" }
  | { phase: "sending" }
  | { phase: "ok"; message: string }
  | { phase: "error"; message: string };

export function NotificationSection({ showHeading = true }: SettingsSectionProps) {
  const [notifySystem, setNotifySystem] = useAtom(notifySystemAtom);
  const [notifySound, setNotifySound] = useAtom(notifySoundAtom);
  const [notifyOnComplete, setNotifyOnComplete] = useAtom(notifyOnCompleteAtom);
  const [notifyOnApproval, setNotifyOnApproval] = useAtom(notifyOnApprovalAtom);
  const [notifyOnlyBackground, setNotifyOnlyBackground] = useAtom(notifyOnlyBackgroundAtom);
  const [testState, setTestState] = useState<NotifyTestState>({ phase: "idle" });

  const allChannelsOff = !notifySystem && !notifySound;
  const toggleOptions = [{ value: "off", label: "关闭" }, { value: "on", label: "开启" }];

  const handleTestNotification = async () => {
    const bridge = window.hermesDesktop;
    if (typeof bridge?.desktopNotify !== "function") {
      setTestState({ phase: "error", message: "当前为 Web 模式，系统通知仅桌面端支持" });
      return;
    }
    setTestState({ phase: "sending" });
    try {
      const result = await bridge.desktopNotify({
        kind: "test",
        title: "AgentDeck 通知测试",
        body: "看到这条系统通知说明配置正常（macOS 首次会请求授权）。",
        showSystemNotification: notifySystem,
        withSound: notifySound,
        respectFocus: false,
        requestAttention: false,
      });
      // 复用真实链路的兜底判定，让用户能预听系统通知关闭时的提示音。
      const previewSettings = {
        system: notifySystem,
        sound: notifySound,
        onComplete: true,
        onApproval: true,
        onlyBackground: false,
      };
      if (shouldPlayFallbackSound(previewSettings, result)) playChime();
      if (result.error) {
        setTestState({
          phase: "error",
          message: `系统通知发送失败：${result.error}（请检查系统设置中的通知权限）`,
        });
      } else if (notifySystem && result.delivered) {
        setTestState({ phase: "ok", message: "已发送，请查看系统通知" });
      } else if (notifySound) {
        setTestState({ phase: "ok", message: "已播放提示音（系统通知未开启）" });
      } else {
        setTestState({ phase: "ok", message: "系统通知与提示音均未开启，本次测试没有任何提醒" });
      }
    } catch (err) {
      setTestState({
        phase: "error",
        message: `测试失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const testSub =
    testState.phase === "ok" || testState.phase === "error"
      ? testState.message
      : "验证系统通知权限是否已授予（窗口在前台也会发送）";

  return (
    <div>
      {showHeading && <h2 className={s.heading}>通知</h2>}
      <Row label="系统通知" sub="任务需要关注时通过 macOS 通知中心 / Windows 通知横幅提醒" right={
        <RadioGroup value={notifySystem ? "on" : "off"} options={toggleOptions} onChange={(v) => setNotifySystem(v === "on")} />
      } />
      <Row label="提示音" sub="提醒时播放声音；系统通知开启时使用系统原生提示音" right={
        <RadioGroup value={notifySound ? "on" : "off"} options={toggleOptions} onChange={(v) => setNotifySound(v === "on")} />
      } />
      <Row label="任务完成时通知" sub="回合结束（含任务出错）时提醒" right={
        <RadioGroup value={notifyOnComplete ? "on" : "off"} options={toggleOptions} onChange={(v) => setNotifyOnComplete(v === "on")} />
      } />
      <Row label="需要权限确认时通知" sub="任务等待你批准命令时提醒，并请求任务栏 / Dock 注意" right={
        <RadioGroup value={notifyOnApproval ? "on" : "off"} options={toggleOptions} onChange={(v) => setNotifyOnApproval(v === "on")} />
      } />
      <Row label="仅窗口在后台时通知" sub="窗口在前台时不打扰；关闭后前台也会提醒" right={
        <RadioGroup value={notifyOnlyBackground ? "on" : "off"} options={toggleOptions} onChange={(v) => setNotifyOnlyBackground(v === "on")} />
      } />
      {allChannelsOff && (
        <p className={s.desc}>系统通知与提示音均已关闭，上方事件开关暂不生效。</p>
      )}
      <Row label="发送测试通知" sub={testSub} right={
        <Button
          type="button"
          variant="outline"
          loading={testState.phase === "sending"}
          onClick={() => void handleTestNotification()}
        >
          测试
        </Button>
      } />
    </div>
  );
}

const UI_SCALE_OPTIONS: Array<{ value: ThemeConfig["scale"]; label: string }> = [
  { value: "sm", label: "90%" },
  { value: "md", label: "100%" },
  { value: "lg", label: "110%" },
  { value: "xl", label: "125%" },
  { value: "2xl", label: "150%" },
];

export function ThemeSection({ showHeading = true }: SettingsSectionProps) {
  const { config, update } = useTheme();
  const [conversationFontSize, setConversationFontSize] = useAtom(conversationFontSizeAtom);
  const densityLabel = config.density === "compact" ? "紧凑" : "舒适";

  return (
    <div>
      {showHeading && <h2 className={s.heading}>主题</h2>}
      <div className={s.appearancePanel}>
        <div className={s.appearanceHeader}>
          <div className={s.appearanceHeaderText}>
            <h3>界面外观</h3>
            <p>默认主题采用中性黑白灰，同时保留兼容主题。</p>
          </div>
          <span className={s.appearanceMeta}>实时生效 · {densityLabel}</span>
        </div>

        <AppearanceRow
          label="主题"
          sub="现代浅色与现代深色遵循同一套扁平设计令牌，其他主题作为兼容选项保留。"
          right={
            <ThemeSkinPicker
              value={config.theme}
              onChange={(theme) => update({ theme })}
            />
          }
        />
        <AppearanceRow
          label="界面缩放"
          sub="整体放大或缩小界面（文字、间距、图标一起缩放），适配高分屏 / 4K 显示器。标准为 100%。"
          right={
            <RadioGroup value={config.scale} options={UI_SCALE_OPTIONS} onChange={(v) => update({ scale: v as ThemeConfig["scale"] })} />
          }
        />
        <AppearanceRow
          label="密度"
          sub="调整行与卡片的垂直留白。舒适匹配当前默认布局。"
          right={
            <RadioGroup value={config.density} options={[{ value: "compact", label: "紧凑" }, { value: "comfortable", label: "舒适" }]} onChange={(v) => update({ density: v as ThemeConfig["density"] })} />
          }
        />
        <AppearanceRow
          label="对话字号"
          sub="只影响会话详情里的对话正文；代码块、工具日志和输入框保持原字号。"
          right={
            <RadioGroup
              value={conversationFontSize}
              options={CONVERSATION_FONT_SIZE_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
              onChange={(v) => setConversationFontSize(v as ConversationFontSizeMode)}
            />
          }
        />
      </div>
    </div>
  );
}

const THEME_SKINS: Array<{
  value: ThemeConfig["theme"];
  label: string;
  sub: string;
  bg: string;
  pane: string;
  soft: string;
  text: string;
  accent: string;
}> = [
  {
    value: "light",
    label: "浅色",
    sub: "明亮柔和",
    bg: "#fbfaf7",
    pane: "#ffffff",
    soft: "#f5f2ec",
    text: "#232120",
    accent: "#ff7a3d",
  },
  {
    value: "light-modern",
    label: "现代浅色",
    sub: "纸白与石墨",
    bg: "#f4f4f3",
    pane: "#ffffff",
    soft: "#ececeb",
    text: "#171716",
    accent: "#171716",
  },
  {
    value: "dark",
    label: "经典深色",
    sub: "暖墨颗粒",
    bg: "#0a0908",
    pane: "#11100e",
    soft: "#232120",
    text: "#faf7f0",
    accent: "#ff7a3d",
  },
  {
    value: "dark-modern",
    label: "现代深色",
    sub: "炭黑与暖白",
    bg: "#111111",
    pane: "#181818",
    soft: "#2a2a2a",
    text: "#f1f1ef",
    accent: "#f1f1ef",
  },
  {
    value: "dracula",
    label: "Dracula",
    sub: "紫粉高对比",
    bg: "#282a36",
    pane: "#44475a",
    soft: "#21222c",
    text: "#f8f8f2",
    accent: "#bd93f9",
  },
  {
    value: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    sub: "柔和蓝灰",
    bg: "#1e1e2e",
    pane: "#181825",
    soft: "#313244",
    text: "#cdd6f4",
    accent: "#cba6f7",
  },
];

function AppearanceRow({
  label,
  sub,
  right,
  meta,
}: {
  label: string;
  sub: string;
  right: React.ReactNode;
  meta?: string;
}) {
  return (
    <div className={s.appearanceRow}>
      <div className={s.appearanceRowText}>
        <div className={s.appearanceRowLabel}>{label}</div>
        <div className={s.appearanceRowSub}>{sub}</div>
      </div>
      <div className={s.appearanceRowControl}>{right}</div>
      {meta ? <div className={s.appearanceRowMeta}>{meta}</div> : null}
    </div>
  );
}

function ThemeSkinPicker({
  value,
  onChange,
}: {
  value: ThemeConfig["theme"];
  onChange: (theme: ThemeConfig["theme"]) => void;
}) {
  return (
    <div className={s.skinPicker} role="radiogroup" aria-label="主题皮肤">
      {THEME_SKINS.map((skin) => {
        const active = skin.value === value;
        const style = {
          "--skin-bg": skin.bg,
          "--skin-pane": skin.pane,
          "--skin-soft": skin.soft,
          "--skin-text": skin.text,
          "--skin-accent": skin.accent,
        } as CSSProperties;
        return (
          <button
            key={skin.value}
            type="button"
            className={s.skinCard}
            style={style}
            role="radio"
            aria-checked={active}
            data-active={active ? "true" : undefined}
            onClick={() => onChange(skin.value)}
          >
            <span className={s.skinPreview} aria-hidden="true">
              <span className={s.skinPreviewTop} />
              <span className={s.skinPreviewBody}>
                <span />
                <span />
                <span />
              </span>
              <span className={s.skinPreviewAccent} />
            </span>
            <span className={s.skinCopy}>
              <span className={s.skinTitle}>{skin.label}</span>
              <span className={s.skinSub}>{skin.sub}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ── About ───────────────────────────────────────────────────────────── */

export function AboutSection({ showHeading = true }: SettingsSectionProps) {
  // Developer mode ships enabled; the shortcut to open devtools follows the
  // platform's browser convention (registered in web/src/lib/tauri-bridge.ts).
  const devtoolsShortcut =
    detectHostOS() === "macos" ? "F12 或 ⌘ + ⌥ + I" : "F12 或 Ctrl + Shift + I";

  return (
    <div className={s.aboutSection}>
      {showHeading && <h2 className={s.heading}>关于</h2>}
      <div className={s.aboutDebugGrid}>
        <DebugCard icon={<Info size={16} />} title="AgentDeck" sub="多 Agent 编排桌面工具：驱动本机已安装的编程 Agent，不直接调用模型 API" wide>
          <div className={s.runtimeGrid}>
            <RuntimeField label="当前版本" value={versionLabel(DESKTOP_VERSION)} />
            <RuntimeField label="构建提交" value={BUILD_COMMIT === "unknown" ? "—" : BUILD_COMMIT} mono />
            <RuntimeField label="构建日期" value={BUILD_DATE === "unknown" ? "—" : BUILD_DATE} mono />
          </div>
        </DebugCard>

        <DebugCard icon={<Bug size={16} />} title="开发者工具" sub="默认开启开发者模式，可用快捷键打开 DevTools">
          <div className={s.runtimeGrid}>
            <RuntimeField label="开发者模式" value="已默认开启" />
            <RuntimeField label="打开快捷键" value={devtoolsShortcut} mono />
          </div>
          <p className={s.desc}>
            按上述快捷键即可打开 / 关闭浏览器开发者工具（DevTools），用于查看控制台日志、网络请求等，方便排查问题。
          </p>
        </DebugCard>

        <DebugCard icon={<Scale size={16} />} title="许可" sub="PolyForm Noncommercial License 1.0.0">
          <div className={s.thanksText}>
            <p>
              AgentDeck 依据 PolyForm Noncommercial License 1.0.0 发布，<strong>仅限非商业用途</strong>，商业使用需另行取得授权。
            </p>
            <p>许可全文见安装目录或源码仓库中的 LICENSE 文件；第三方组件及其许可见下方声明。</p>
          </div>
        </DebugCard>

        <DebugCard icon={<FileText size={16} />} title="第三方声明" sub="NOTICE：派生来源、保留声明与第三方许可" wide>
          <pre className={s.noticeText} tabIndex={0}>{noticeText.trim()}</pre>
        </DebugCard>
      </div>
    </div>
  );
}

function DebugCard({ icon, title, sub, children, wide }: {
  icon: React.ReactNode;
  title: string;
  sub?: string;
  children: React.ReactNode;
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

function RuntimeField({ label, value, mono, wide, title }: {
  label: string;
  value: string | number | boolean | undefined;
  mono?: boolean;
  wide?: boolean;
  title?: string;
}) {
  const display = value === undefined || value === "" ? "—" : String(value);
  return (
    <div className={s.runtimeField} data-wide={wide ? "true" : undefined} title={title}>
      <span>{label}</span>
      <b data-mono={mono ? "true" : undefined}>{display}</b>
    </div>
  );
}

/* ── Shared Components ───────────────────────────────────────────────── */

function Row({ label, sub, right }: { label: string; sub?: string; right: React.ReactNode }) {
  return (
    <div className={s.row}>
      <div className={s.rowLeft}>
        <div className={s.rowLabel}>{label}</div>
        {sub && <div className={s.rowSub}>{sub}</div>}
      </div>
      <div className={s.rowRight}>{right}</div>
    </div>
  );
}

function RadioGroup({ value, options, onChange }: { value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <div className={s.radioGroup}>
      {options.map((o) => (
        <button key={o.value} className={s.radioBtn} data-active={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}
