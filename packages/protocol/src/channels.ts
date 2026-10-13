// 桌面端 Rust 命令的返回结构（与 src/commands/ 下对应命令保持一致）。

export interface ExportLogSnapshotInput {
  fileName: string;
  content: string;
  format: "log" | "jsonl";
}

export interface ExportLogSnapshotResult {
  ok: boolean;
  canceled: boolean;
  path?: string;
  bytes: number;
  error?: string;
}

export type EnvironmentCheckStatus = "ok" | "warning" | "error" | "unknown";

export type EnvironmentCheckCategory = "core" | "runtime" | "tools" | "browser" | "paths";

export interface EnvironmentCheckItem {
  id: string;
  category: EnvironmentCheckCategory;
  label: string;
  status: EnvironmentCheckStatus;
  required: boolean;
  summary: string;
  version?: string;
  path?: string;
  details?: string;
  recommendation?: string;
  /** 一键安装方案：仅在该项「未找到」且当前平台有白名单方案时给出。 */
  install?: EnvironmentInstallHint;
}

/** Rust 白名单中的安装方案（winget / brew / npm），前端只展示命令、只回传检测项 id。 */
export interface EnvironmentInstallHint {
  /** 展示给用户的完整命令行 */
  command: string;
  /** false = 前置条件不满足（如未找到 winget / npm），按钮禁用 */
  available: boolean;
  unavailableReason?: string;
}

/** Rust 命令 environment_install { id } 的返回值。 */
export interface EnvironmentInstallResult {
  ok: boolean;
  exitCode: number | null;
  /** stdout + stderr 末尾（最多约 4000 字符） */
  output: string;
}

export interface EnvironmentCheckResult {
  generatedAtMs: number;
  platform: string;
  arch: string;
  dataDir: string;
  logDir: string;
  items: EnvironmentCheckItem[];
}

// 编程 Agent CLI（Claude Code / Codex）检测（Rust coding_agents.rs）。
export type CodingAgentLoginState = "logged_in" | "expired" | "not_logged_in" | "unknown";

export interface CodingAgentStatus {
  id: string;
  label: string;
  installed: boolean;
  /** 版本号；未安装或版本命令失败时为原因说明（如「配置的路径不存在：…」） */
  version?: string;
  path?: string;
  /** 「编程 Agent」页手动配置的可执行文件路径；null / 缺省 = 自动查找 */
  configuredPath?: string | null;
  loginState: CodingAgentLoginState;
  loginDetail?: string;
  configDir: string;
  skillName: string;
  installHint: string;
  loginHint: string;
}

export interface CodingAgentsCheckResult {
  generatedAtMs: number;
  platform: string;
  agents: CodingAgentStatus[];
}

/**
 * 「编程 Agent」页配置的可执行文件路径（`<数据目录>/coding-agent-paths.json`，Rust 命令
 * coding_agent_paths_get / coding_agent_paths_set）；缺省或空字符串 = 自动查找。
 */
export interface CodingAgentPaths {
  claude?: string | null;
  codex?: string | null;
}
