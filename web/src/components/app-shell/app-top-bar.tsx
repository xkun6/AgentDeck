import { useAtom, useSetAtom } from "jotai";
import { Moon, PanelLeftOpen, Sun } from "lucide-react";
import { useTheme } from "@agentdeck/shared-ui";
import { useWindowControls } from "@/hooks/use-window-controls";
import { appSidebarVisibleAtom } from "@/stores/ui";
import { pageHeaderSlotAtom } from "@/components/top-bar/page-header-slot";
import { WindowControls } from "./window-controls";
import s from "./app-top-bar.module.css";

const DARK_THEMES = new Set(["dark", "dark-modern", "dracula", "catppuccin-mocha"]);

/** 主区标题行：侧栏收起时的展开按钮、页面标题与操作（TopBar portal）、主题切换、窗口按钮。整行可拖动窗口。 */
export function AppTopBar() {
  const [sidebarVisible, setSidebarVisible] = useAtom(appSidebarVisibleAtom);
  const setSlot = useSetAtom(pageHeaderSlotAtom);
  const { config: themeConfig, update: updateTheme } = useTheme();
  const windowControls = useWindowControls();
  const isDark = DARK_THEMES.has(themeConfig.theme);
  const ThemeIcon = isDark ? Sun : Moon;
  const themeLabel = `切换到${isDark ? "浅色" : "深色"}模式`;

  return (
    <header
      className={s.header}
      data-window-drag
      data-tauri-drag-region="deep"
      data-window-controls={windowControls ? "true" : undefined}
    >
      {sidebarVisible ? null : (
        <button
          type="button"
          className={s.iconBtn}
          aria-label="显示侧边栏"
          aria-controls="app-sidebar"
          aria-expanded="false"
          title="显示侧边栏"
          onClick={() => setSidebarVisible(true)}
        >
          <PanelLeftOpen size={16} />
        </button>
      )}
      <div ref={setSlot} className={s.pageSlot} />
      <div className={s.actions}>
        <button
          type="button"
          className={s.iconBtn}
          onClick={() => updateTheme({ theme: isDark ? "light-modern" : "dark-modern" })}
          title={themeLabel}
          aria-label={themeLabel}
          data-theme-mode={themeConfig.theme}
        >
          <ThemeIcon size={16} />
        </button>
      </div>
      {windowControls ? <WindowControls {...windowControls} /> : null}
    </header>
  );
}
