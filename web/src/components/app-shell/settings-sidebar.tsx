import { useLocation, useNavigate } from "react-router-dom";
import {
  Bell,
  Bot,
  Bug,
  Camera,
  Info,
  Languages,
  MonitorCog,
  Network,
  Palette,
  SlidersHorizontal,
  Smartphone,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import s from "./debug-sidebar.module.css";

interface SettingsItem {
  label: string;
  path: string;
  icon: LucideIcon;
}

export const SETTINGS_ITEMS: readonly SettingsItem[] = [
  { label: "常规", path: "/common", icon: SlidersHorizontal },
  { label: "通知", path: "/notifications", icon: Bell },
  { label: "主题", path: "/theme", icon: Palette },
  { label: "Agent 与中转", path: "/agent-providers", icon: Waypoints },
  { label: "编程 Agent", path: "/coding-agents", icon: Bot },
  { label: "环境", path: "/env", icon: MonitorCog },
  { label: "文件快照", path: "/snapshots", icon: Camera },
  { label: "会话互通", path: "/interop", icon: Network },
  { label: "手机连接", path: "/remote", icon: Smartphone },
  { label: "翻译", path: "/translation", icon: Languages },
  { label: "调试", path: "/debug", icon: Bug },
  { label: "关于", path: "/about", icon: Info },
];

export function SettingsSidebar() {
  const navigate = useNavigate();
  const location = useLocation();

  const isActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(`${path}/`);

  return (
    <aside className={s.sidebar} aria-label="设置侧栏">
      <div className={s.scrollY}>
        <section className={s.section}>
          <div className={s.label}>
            <span>§01 · 设置</span>
            <span className={s.labelNum}>✕✕</span>
          </div>
          {SETTINGS_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.path}
                type="button"
                className={s.item}
                data-active={isActive(item.path) ? "true" : undefined}
                onClick={() => navigate(item.path)}
                title={item.path}
              >
                <span className={s.itemIcon}>
                  <Icon size={16} />
                </span>
                <span className={s.itemLabel}>{item.label}</span>
                <span className={s.itemPath}>{item.path}</span>
              </button>
            );
          })}
        </section>
      </div>
    </aside>
  );
}
