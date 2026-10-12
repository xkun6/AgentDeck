import { useActiveTopTab } from "./use-active-top-tab";
import { WorkbenchSidebar } from "./workbench-sidebar";
import { SettingsSidebar } from "./settings-sidebar";

export function AppSidebar() {
  const tab = useActiveTopTab();
  if (tab === "settings") return <SettingsSidebar />;
  return <WorkbenchSidebar />;
}
