import type { ReactNode } from "react";
import { useAtomValue } from "jotai";
import { appSidebarVisibleAtom } from "@/stores/ui";
import { AppTopBar } from "./app-top-bar";
import { AppSidebar } from "./app-sidebar";
import s from "./app-shell.module.css";

interface AppShellProps {
  children: ReactNode;
}

/** 外壳：左侧通高侧栏 + 右侧主区（顶部标题行 + 页面内容）。 */
export function AppShell({ children }: AppShellProps) {
  const sidebarVisible = useAtomValue(appSidebarVisibleAtom);

  return (
    <div className={s.shell} data-sidebar-visible={sidebarVisible ? "true" : "false"}>
      <div
        id="app-sidebar"
        className={s.sidebarSlot}
        aria-hidden={sidebarVisible ? undefined : true}
        inert={sidebarVisible ? undefined : true}
      >
        <AppSidebar />
      </div>
      <div className={s.mainSlot}>
        <AppTopBar />
        <div className={s.content}>{children}</div>
      </div>
    </div>
  );
}
