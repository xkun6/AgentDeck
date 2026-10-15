// 手机端的 hash 路由（Android 返回键走 history）：#/sessions  #/s/<agentId>  #/s/<agentId>/sub/<subagentId>  #/new  #/settings  #/hosts  #/pair
export type MobileRoute =
  | { name: "hosts" }
  | { name: "pair" }
  | { name: "sessions" }
  | { name: "session"; agentId: string; subagentId?: string }
  | { name: "new" }
  | { name: "settings" };

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
  switch (hash) {
    case "#/hosts":
      return { name: "hosts" };
    case "#/pair":
      return { name: "pair" };
    case "#/new":
      return { name: "new" };
    case "#/settings":
      return { name: "settings" };
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
    case "sessions":
      return "#/sessions";
    default:
      return `#/${route.name}`;
  }
}

/** 底部导航高亮哪一项（详情页 / 电脑列表 / 配对页不显示导航） */
export function navTabOf(route: MobileRoute): "sessions" | "new" | "settings" | null {
  return route.name === "sessions" || route.name === "new" || route.name === "settings" ? route.name : null;
}
