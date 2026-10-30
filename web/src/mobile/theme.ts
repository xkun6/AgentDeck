// 手机端主题：标记 data-surface 启用手机设计语言（tokens/mobile.css），明暗跟随系统。
import { DEFAULT_THEME_CONFIG, applyThemeToDOM } from "@agentdeck/shared-ui";

export function installMobileTheme(root: HTMLElement = document.documentElement): () => void {
  root.setAttribute("data-surface", "mobile");
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () =>
    applyThemeToDOM({ ...DEFAULT_THEME_CONFIG, theme: media.matches ? "dark-modern" : "light-modern" });
  apply();
  media.addEventListener("change", apply);
  return () => media.removeEventListener("change", apply);
}
