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
  version?: string;
  path?: string;
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
