import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { useActiveTopTab } from "./use-active-top-tab";
import { WorkbenchSidebar } from "./workbench-sidebar";
import { SettingsSidebar } from "./settings-sidebar";

export function AppSidebar() {
  const tab = useActiveTopTab();
  const { pathname, search } = useLocation();
  // 记住最近一个工作台页面，设置侧栏的「返回」回到这里
  const lastWorkbenchPath = useRef("/");
  useEffect(() => {
    if (tab !== "settings") lastWorkbenchPath.current = `${pathname}${search}`;
  }, [tab, pathname, search]);

  if (tab === "settings") return <SettingsSidebar backTo={lastWorkbenchPath.current} />;
  return <WorkbenchSidebar />;
}
