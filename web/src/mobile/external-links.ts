// 手机端外链处理：Android WebView 对 <a target=_blank> / window.open 会直接在本 WebView 内导航，
// 把 App 页面整个替换掉（远程连接随之断开）。所以外部 http / https 链接一律拦下来交给原生 openUrl（系统浏览器）。
// 只在手机入口 main.tsx 安装一次；桌面走 lib/external-links.ts 自己的 installExternalLinkHandling。
import { setMobileExternalOpener } from "@/lib/external-links";
import { openUrl } from "./native/native-plugin";
import s from "./mobile.module.css";

/** 解析成绝对地址并判断是否「外部 http(s) 链接」；App 自身源（tauri.localhost / dev server）与 hash 路由不算 */
export function externalHttpUrl(raw: string | URL | null | undefined, base: string = window.location.href): string | null {
  const value = String(raw ?? "").trim();
  if (!value || value.startsWith("#")) return null;
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  if (url.origin === new URL(base).origin) return null;
  if (url.hostname === "tauri.localhost") return null;
  return url.href;
}

const TOAST_MS = 3_000;

function showToast(message: string): void {
  const toast = document.createElement("div");
  toast.className = s.linkToast;
  toast.setAttribute("role", "status");
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), TOAST_MS);
}

export interface MobileExternalLinkOptions {
  /** 打开外链的原生实现，默认 native-plugin 的 openUrl */
  open?: (url: string) => Promise<boolean>;
  /** 打开失败时的提示，默认在页面底部弹一条短暂的提示 */
  notify?: (message: string) => void;
}

/** 安装全局拦截；返回卸载函数（测试用） */
export function installMobileExternalLinks(options: MobileExternalLinkOptions = {}): () => void {
  const open = options.open ?? openUrl;
  const notify = options.notify ?? showToast;
  setMobileExternalOpener(open);

  const openOrNotify = async (url: string) => {
    let opened = false;
    try {
      opened = await open(url);
    } catch {
      opened = false;
    }
    if (!opened) notify("无法打开链接，请手动复制地址到浏览器");
  };

  const onClick = (event: MouseEvent) => {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    const anchor = event.target.closest("a[href]");
    if (!(anchor instanceof HTMLAnchorElement)) return;
    const url = externalHttpUrl(anchor.getAttribute("href"));
    if (!url) return;
    event.preventDefault();
    void openOrNotify(url);
  };
  document.addEventListener("click", onClick, true);

  const originalOpen = window.open;
  // WebView 里没有「新窗口」：外部 http(s) 交给系统浏览器，其余（站内地址 / 其它协议 / 空地址）一律忽略，都不在本 WebView 内导航
  window.open = ((url?: string | URL) => {
    const external = externalHttpUrl(url);
    if (external) void openOrNotify(external);
    return null;
  }) as typeof window.open;

  return () => {
    document.removeEventListener("click", onClick, true);
    window.open = originalOpen;
    setMobileExternalOpener(null);
  };
}
