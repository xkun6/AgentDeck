// PATH 中位于 node_modules 内的目录（例如 pnpm / npm 跑脚本时注入的 `<项目>/node_modules/.bin`）
// 属于某个项目的本地依赖，而不是用户全局安装的 CLI。provider 定位 claude / codex 时跳过这些目录，
// 保证只会解析到用户本机全局安装的程序，绝不会解析到 AgentDeck 仓库或打包产物里的依赖。
export function isInsideNodeModules(dir: string): boolean {
  return dir.split(/[\\/]+/).some((segment) => segment.toLowerCase() === "node_modules");
}
