import { Navigate, useLocation } from "react-router-dom";
import { SectionShell } from "./section-shell";
import { AboutSection, GeneralSection, NotificationSection, ThemeSection } from "./settings";
import { EnvironmentSection } from "./environment";
import { DebugSection } from "./debug";
import { SnapshotSettingsSection } from "./snapshot-settings";
import { InteropSettingsSection } from "./interop-settings";
import { RemoteSettingsSection } from "./remote-settings";
import { TranslationSettingsSection } from "./translation-settings";
import { ComputerUseSettingsSection } from "./computer-use-settings";

type AdvancedSection =
  | "general"
  | "notifications"
  | "env"
  | "computerUse"
  | "snapshots"
  | "interop"
  | "remote"
  | "translation"
  | "debug"
  | "about";

const SECTION_PATHS: Record<AdvancedSection, string> = {
  general: "/common",
  notifications: "/notifications",
  env: "/env",
  computerUse: "/computer-use",
  snapshots: "/snapshots",
  interop: "/interop",
  remote: "/remote",
  translation: "/translation",
  debug: "/debug",
  about: "/about",
};

const LEGACY_SECTION_PATHS: Record<string, AdvancedSection> = {
  "/advanced": "general",
  "/advanced/notifications": "notifications",
  "/advanced/env": "env",
  "/advanced/snapshots": "snapshots",
  "/advanced/interop": "interop",
  "/advanced/remote": "remote",
  "/advanced/debug": "debug",
  "/advanced/about": "about",
};

const SECTION_META: Record<AdvancedSection, { title: string; sub: string }> = {
  general: { title: "常规", sub: "调整会话显示与输入偏好。" },
  notifications: { title: "通知", sub: "控制任务完成与权限确认的系统通知、提示音。" },
  env: { title: "环境", sub: "检查本机 CLI 与可选工具能力。" },
  computerUse: { title: "Computer Use", sub: "让 Agent 截图、读取窗口并操作本机桌面（cua-driver，仅 Windows）。" },
  snapshots: { title: "文件快照", sub: "按回合自动记录工作目录的文件状态，用于查看回合改动与回滚。" },
  interop: { title: "会话互通", sub: "让会话之间互相委派任务、读取与转发消息（本机 MCP 服务）。" },
  remote: { title: "手机连接", sub: "让安卓手机经局域网或 Tailscale 扫码配对，远程查看会话并审批（端到端加密）。" },
  translation: { title: "翻译", sub: "用你的语言和 Agent 对话：消息翻译后发送，回复翻译后显示。" },
  debug: { title: "调试", sub: "运行状态、路径、日志，一键导出脱敏诊断包。" },
  about: { title: "关于", sub: "版本、许可与第三方声明。" },
};

export function ThemeRoute() {
  return (
    <SectionShell title="主题" sub="选择皮肤、信息密度和对话字号。">
      <ThemeSection showHeading={false} />
    </SectionShell>
  );
}

function sectionFromPath(pathname: string): AdvancedSection | null {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const canonicalSection = Object.entries(SECTION_PATHS).find(([, path]) => path === normalized)?.[0];
  return (canonicalSection as AdvancedSection | undefined) ?? LEGACY_SECTION_PATHS[normalized] ?? null;
}

export function AdvancedRoute() {
  const { hash, pathname } = useLocation();
  const section = sectionFromPath(pathname);

  if (!section) return <Navigate to="/common" replace />;

  const canonicalPath = SECTION_PATHS[section];
  const normalizedPathname = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (normalizedPathname !== canonicalPath) return <Navigate to={`${canonicalPath}${hash}`} replace />;

  const meta = SECTION_META[section];
  return (
    <SectionShell title={meta.title} sub={meta.sub}>
      {section === "general" && <GeneralSection showHeading={false} />}
      {section === "notifications" && <NotificationSection showHeading={false} />}
      {section === "env" && <EnvironmentSection showHeading={false} />}
      {section === "computerUse" && <ComputerUseSettingsSection />}
      {section === "snapshots" && <SnapshotSettingsSection showHeading={false} />}
      {section === "interop" && <InteropSettingsSection showHeading={false} />}
      {section === "remote" && <RemoteSettingsSection showHeading={false} />}
      {section === "translation" && <TranslationSettingsSection />}
      {section === "debug" && <DebugSection showHeading={false} />}
      {section === "about" && <AboutSection showHeading={false} />}
    </SectionShell>
  );
}
