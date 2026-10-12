import { SectionShell } from "./section-shell";
import { CodingAgentsSection } from "./settings-coding-agents";

export function CodingAgentsRoute() {
  return (
    <SectionShell
      title="编程 Agent"
      sub="检测 Claude Code / Codex CLI 的安装与登录状态。"
    >
      <CodingAgentsSection showHeading={false} />
    </SectionShell>
  );
}
