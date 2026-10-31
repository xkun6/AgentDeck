// 手机端的 hash 路由（Android 返回键走 history）：#/sessions  #/dispatch  #/dispatch/<主会话 id>  #/s/<agentId>  #/s/<agentId>/sub/<subagentId>  #/new  #/settings  #/settings/<子页>  #/hosts  #/pair
export type SettingsPage = "background" | "diagnostics";

export type MobileRoute =
  | { name: "hosts" }
  | { name: "pair" }
  | { name: "sessions" }
  | { name: "dispatch"; agentId?: string }
  | { name: "session"; agentId: string; subagentId?: string }
  | { name: "new" }
  | { name: "settings"; page?: SettingsPage };

export function parseRoute(hash: string): MobileRoute {
  // 子代理页是会话页上的一层 history：返回键逐级回退（孙代理继续 push）
  const sub = /^#\/s\/([^/]+)\/sub\/(.+)$/.exec(hash);
  if (sub) {
    try {
      return { name: "session", agentId: decodeURIComponent(sub[1]!), subagentId: decodeURIComponent(sub[2]!) };
    } catch {
      return { name: "sessions" };
    }
  }
  const match = /^#\/s\/(.+)$/.exec(hash);
  if (match) {
    try {
      return { name: "session", agentId: decodeURIComponent(match[1]!) };
    } catch {
      return { name: "sessions" };
    }
  }
  const dispatch = /^#\/dispatch\/(.+)$/.exec(hash);
  if (dispatch) {
    try {
      return { name: "dispatch", agentId: decodeURIComponent(dispatch[1]!) };
    } catch {
      return { name: "dispatch" };
    }
  }
  switch (hash) {
    case "#/dispatch":
      return { name: "dispatch" };
    case "#/hosts":
      return { name: "hosts" };
    case "#/pair":
      return { name: "pair" };
    case "#/new":
      return { name: "new" };
    case "#/settings":
      return { name: "settings" };
    case "#/settings/background":
      return { name: "settings", page: "background" };
    case "#/settings/diagnostics":
      return { name: "settings", page: "diagnostics" };
    default:
      return { name: "sessions" };
  }
}

export function routeHash(route: MobileRoute): string {
  switch (route.name) {
    case "session":
      return route.subagentId === undefined
        ? `#/s/${encodeURIComponent(route.agentId)}`
        : `#/s/${encodeURIComponent(route.agentId)}/sub/${encodeURIComponent(route.subagentId)}`;
    case "dispatch":
      return route.agentId === undefined ? "#/dispatch" : `#/dispatch/${encodeURIComponent(route.agentId)}`;
    case "sessions":
      return "#/sessions";
    case "settings":
      return route.page === undefined ? "#/settings" : `#/settings/${route.page}`;
    default:
      return `#/${route.name}`;
  }
}

/** 底部导航高亮哪一项（详情页 / 电脑列表 / 配对页不显示导航） */
export function navTabOf(route: MobileRoute): "sessions" | "dispatch" | "new" | "settings" | null {
  if (route.name === "dispatch") return route.agentId === undefined ? "dispatch" : null;
  if (route.name === "settings") return route.page === undefined ? "settings" : null;
  return route.name === "sessions" || route.name === "new" ? route.name : null;
}
