import { useLocation } from "react-router-dom";

export type TopTab = "workbench" | "settings";

export interface TopTabDef {
  id: TopTab;
  num: string;
  label: string;
  href: string;
  matches: (path: string) => boolean;
}

const isRoute = (path: string, route: string) => path === route || path.startsWith(`${route}/`);

export const SETTINGS_ROUTES = [
  "/common",
  "/notifications",
  "/theme",
  "/coding-agents",
  "/env",
  "/about",
  "/advanced",
  "/settings",
] as const;

export const TOP_TABS: readonly TopTabDef[] = [
  {
    id: "workbench",
    num: "01",
    label: "工作台",
    href: "/",
    matches: (path) =>
      path === "/" ||
      path.startsWith("/new") ||
      path.startsWith("/tasks/") ||
      path.startsWith("/history") ||
      path.startsWith("/projects") ||
      path.startsWith("/console"),
  },
  {
    id: "settings",
    num: "02",
    label: "设置",
    href: "/common",
    matches: (path) => SETTINGS_ROUTES.some((route) => isRoute(path, route)),
  },
];

export function useActiveTopTab(): TopTab | null {
  const { pathname } = useLocation();
  const match = TOP_TABS.find((tab) => tab.matches(pathname));
  return match?.id ?? null;
}
