import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useSetAtom } from "jotai";
import {
  ArrowLeft,
  Bell,
  Bot,
  Bug,
  Camera,
  Info,
  Languages,
  MonitorCog,
  Network,
  Palette,
  PanelLeftClose,
  Search,
  SlidersHorizontal,
  Smartphone,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import { appSidebarVisibleAtom } from "@/stores/ui";
import s from "./sidebar.module.css";

interface SettingsItem {
  label: string;
  path: string;
  icon: LucideIcon;
  group: string;
}

export const SETTINGS_ITEMS: readonly SettingsItem[] = [
  { label: "常规", path: "/common", icon: SlidersHorizontal, group: "通用" },
  { label: "通知", path: "/notifications", icon: Bell, group: "通用" },
  { label: "主题", path: "/theme", icon: Palette, group: "通用" },
  { label: "Agent 与中转", path: "/agent-providers", icon: Waypoints, group: "Agent" },
  { label: "编程 Agent", path: "/coding-agents", icon: Bot, group: "Agent" },
  { label: "环境", path: "/env", icon: MonitorCog, group: "Agent" },
  { label: "文件快照", path: "/snapshots", icon: Camera, group: "会话" },
  { label: "会话互通", path: "/interop", icon: Network, group: "会话" },
  { label: "翻译", path: "/translation", icon: Languages, group: "会话" },
  { label: "手机连接", path: "/remote", icon: Smartphone, group: "连接" },
  { label: "调试", path: "/debug", icon: Bug, group: "其他" },
  { label: "关于", path: "/about", icon: Info, group: "其他" },
];

/** Esc 返回只在没有弹层、焦点不在输入控件时生效 */
function shouldHandleEscape(event: KeyboardEvent): boolean {
  if (event.key !== "Escape" || event.defaultPrevented) return false;
  const target = event.target as HTMLElement | null;
  if (target?.closest("input, textarea, select, [contenteditable='true']")) return false;
  return document.querySelector("[role='dialog'], [role='menu'], [role='listbox']") === null;
}

interface SettingsSidebarProps {
  /** 「返回」的目标：最近一个工作台页面 */
  backTo?: string;
}

export function SettingsSidebar({ backTo = "/" }: SettingsSidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const setSidebarVisible = useSetAtom(appSidebarVisibleAtom);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!shouldHandleEscape(event)) return;
      event.preventDefault();
      navigate(backTo);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [backTo, navigate]);

  const isActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(`${path}/`);

  const keyword = query.trim().toLowerCase();
  const items = keyword
    ? SETTINGS_ITEMS.filter((item) => item.label.toLowerCase().includes(keyword))
    : SETTINGS_ITEMS;
  const groups = Array.from(new Set(items.map((item) => item.group)));

  return (
    <aside className={s.sidebar} aria-label="设置侧栏">
      <div className={s.dragRow} data-tauri-drag-region="deep">
        <button
          type="button"
          className={s.iconBtn}
          aria-label="隐藏侧边栏"
          aria-controls="app-sidebar"
          aria-expanded="true"
          title="隐藏侧边栏"
          onClick={() => setSidebarVisible(false)}
        >
          <PanelLeftClose size={16} />
        </button>
      </div>

      <nav className={s.nav} aria-label="返回">
        <button type="button" className={s.item} onClick={() => navigate(backTo)}>
          <span className={s.itemIcon}>
            <ArrowLeft size={16} />
          </span>
          <span className={s.itemLabel}>返回</span>
          <kbd className={s.kbd}>Esc</kbd>
        </button>
      </nav>

      <label className={s.search}>
        <Search size={14} aria-hidden="true" />
        <input
          className={s.searchInput}
          type="search"
          value={query}
          placeholder="搜索设置"
          aria-label="搜索设置"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      <div className={s.scrollY}>
        {groups.map((group) => (
          <section key={group} className={s.section}>
            <div className={s.sectionLabel}>
              <span className={s.sectionLabelText}>{group}</span>
            </div>
            {items
              .filter((item) => item.group === group)
              .map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.path}
                    type="button"
                    className={s.item}
                    data-active={isActive(item.path) ? "true" : undefined}
                    onClick={() => navigate(item.path)}
                  >
                    <span className={s.itemIcon}>
                      <Icon size={16} />
                    </span>
                    <span className={s.itemLabel}>{item.label}</span>
                  </button>
                );
              })}
          </section>
        ))}
        {items.length === 0 ? <div className={s.empty}>没有匹配的设置</div> : null}
      </div>
    </aside>
  );
}
