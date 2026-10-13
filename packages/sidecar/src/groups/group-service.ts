import { randomUUID } from "node:crypto";
import path from "node:path";

import type {
  AgentGroup,
  AgentGroupChairMode,
  AgentProviderId,
  AgentStreamEnvelope,
} from "@agentdeck/protocol";

import type { AgentManager } from "../agent/agent-manager.js";
import { AgentInvalidParamsError, AgentRpcError } from "../agent/errors.js";
import type { AgentClient } from "../agent/types.js";
import { addWorktree, diffStat, removeWorktree } from "../git/worktree.js";
import { createSilentLogger, type Logger } from "../logger.js";
import { lastAssistantText } from "../server/mcp-interop.js";
import { locateGit, runGit } from "../snapshots/git.js";
import type { ParsedGroupCreate } from "./schema.js";
import type { GroupStore } from "./store.js";

/** 汇总提示里每个成员回答 / 改动统计的字数上限 */
export const GROUP_REPLY_MAX_CHARS = 20_000;
const TITLE_MAX_CHARS = 30;

export type GroupManager = Pick<
  AgentManager,
  "subscribe" | "getAgent" | "createAgent" | "sendPrompt" | "deleteAgent" | "timeline" | "setGroupId" | "cancel"
>;

export interface GroupServiceOptions {
  manager: GroupManager;
  registry: { get(provider: AgentProviderId): AgentClient | undefined };
  store: GroupStore;
  /** AGENTDECK_DATA_DIR；per-member worktree 放在 `<dataDir>/worktrees/<groupId>/<n>` */
  dataDir?: string;
  logger?: Logger;
}

export interface GroupListener {
  onChanged?(group: AgentGroup): void;
  onRemoved?(groupId: string): void;
}

interface Outcome {
  status: "completed" | "failed" | "canceled";
  error?: string;
}

export interface ChairMemberInput {
  label: string;
  outcome?: Outcome;
  reply?: string;
  /** 仅 per-member：该成员 worktree 的 git diff --stat */
  diff?: string;
  worktree?: { path: string; branch: string };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clip(text: string): string {
  return text.length > GROUP_REPLY_MAX_CHARS
    ? `${text.slice(0, GROUP_REPLY_MAX_CHARS)}\n…（已截断，超过 ${GROUP_REPLY_MAX_CHARS} 字）`
    : text;
}

/** 汇总会话的提示（design.md 4.27）：synthesize / review 模板 + 各成员最后一条助手消息与 diffStat */
export function buildChairPrompt(
  mode: AgentGroupChairMode,
  task: string,
  members: ChairMemberInput[],
): string {
  const n = members.length;
  const head =
    mode === "synthesize"
      ? `以下是 ${n} 个 Agent 对同一任务的回答，请综合出一个最佳答案，并指出各自的优缺点。`
      : `请评审以下 ${n} 个方案，给出排序与理由。`;
  const sections = members.map((member) => {
    const lines = [`## ${member.label}`];
    if (member.outcome?.status === "failed") {
      lines.push(`（该成员回合失败：${member.outcome.error ?? "未知错误"}）`);
    } else if (member.outcome?.status === "canceled") {
      lines.push("（该成员回合被中断）");
    }
    lines.push(member.reply !== undefined ? clip(member.reply) : "（没有助手回答）");
    if (member.worktree) {
      lines.push(
        `### 改动统计（worktree：${member.worktree.path}，分支：${member.worktree.branch}）`,
        member.diff?.trim() ? clip(member.diff) : "（无改动）",
      );
    }
    return lines.join("\n\n");
  });
  return `${head}\n\n# 原任务\n${task}\n\n# 各成员结果\n\n${sections.join("\n\n")}`;
}

/** 最近一个回合的结局（取 entries 中最后一个回合结束事件） */
function lastOutcome(entries: AgentStreamEnvelope[]): Outcome | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const event = entries[index]!.event;
    if (event.type === "turn_completed") {
      return { status: "completed" };
    }
    if (event.type === "turn_failed") {
      return { status: "failed", error: event.error };
    }
    if (event.type === "turn_canceled") {
      return { status: "canceled" };
    }
  }
  return undefined;
}

async function isInsideGitRepo(cwd: string): Promise<boolean> {
  const gitPath = await locateGit();
  if (!gitPath) {
    return false;
  }
  const probe = await runGit(gitPath, ["rev-parse", "--is-inside-work-tree"], { cwd }).catch(() => null);
  return probe !== null && probe.code === 0 && probe.stdout.toString("utf8").trim() === "true";
}

/**
 * 并行协作组（design.md 4.27）：同一 prompt 扇出给多个 Agent（可选各自独立 worktree），
 * 全部成员首个回合结束后按配置新建汇总会话（综合 / 评审）。
 */
export class GroupService {
  private readonly manager: GroupManager;
  private readonly registry: GroupServiceOptions["registry"];
  private readonly store: GroupStore;
  private readonly dataDir: string | undefined;
  private readonly logger: Logger;
  private readonly listeners = new Set<GroupListener>();

  private readonly groups = new Map<string, AgentGroup>();
  /** 成员 / 汇总会话 agentId -> groupId */
  private readonly agentIndex = new Map<string, string>();
  /** 成员首个回合结局（汇总会话不记） */
  private readonly outcomes = new Map<string, Outcome>();
  private readonly backgroundTurns = new Set<string>();
  private readonly advancing = new Set<string>();
  private unsubscribe: (() => void) | null = null;

  constructor(options: GroupServiceOptions) {
    this.manager = options.manager;
    this.registry = options.registry;
    this.store = options.store;
    this.dataDir = options.dataDir;
    this.logger = options.logger ?? createSilentLogger();
  }

  subscribe(listener: GroupListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // -------------------------------------------------------------------------
  // 生命周期与重启恢复
  // -------------------------------------------------------------------------

  /**
   * 加载磁盘上的协作组并按成员会话当前状态恢复：
   * - 成员会话已不存在 → 从组中移除；
   * - running：各成员有结束回合就记结局，没有结束回合（重启时回合被打断）的记为失败，全部有结局后继续推进（建汇总会话 / 完成）；
   * - chairing：汇总会话尚未建出 → 重新建；汇总会话已有结束回合 → 据结局 done / failed；
   *   汇总会话存在但没有结束回合 → 继续等待它的下一次回合结束（用户可在会话里手动续跑）；汇总会话已被删除 → failed。
   */
  async start(): Promise<void> {
    this.unsubscribe = this.manager.subscribe({
      onStream: (envelope) => this.handleStream(envelope),
      onRemoved: (agentId) => this.handleAgentRemoved(agentId),
    });
    for (const group of await this.store.loadAll()) {
      this.groups.set(group.id, group);
    }
    for (const group of [...this.groups.values()]) {
      await this.recover(group);
    }
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.store.flush();
  }

  private agentExists(agentId: string): boolean {
    try {
      this.manager.getAgent(agentId);
      return true;
    } catch {
      return false;
    }
  }

  private async recover(group: AgentGroup): Promise<void> {
    let dirty = false;
    const members = group.members.filter((member) => this.agentExists(member.agentId));
    if (members.length !== group.members.length) {
      group.members = members;
      dirty = true;
    }
    if (group.chair?.agentId && !this.agentExists(group.chair.agentId)) {
      delete group.chair.agentId;
      if (group.status === "chairing") {
        group.status = "failed";
      }
      dirty = true;
    }
    for (const member of group.members) {
      this.agentIndex.set(member.agentId, group.id);
    }
    if (group.chair?.agentId) {
      this.agentIndex.set(group.chair.agentId, group.id);
    }
    if (dirty) {
      this.persist(group);
    }
    if (group.status === "running") {
      for (const member of group.members) {
        const { entries } = await this.manager.timeline(member.agentId).catch(() => ({ entries: [] }));
        this.outcomes.set(
          member.agentId,
          lastOutcome(entries) ?? { status: "failed", error: "sidecar 重启时该回合被中断" },
        );
      }
      this.advance(group);
    } else if (group.status === "chairing") {
      if (!group.chair?.agentId) {
        group.status = "running";
        for (const member of group.members) {
          this.outcomes.set(member.agentId, (await this.memberOutcome(member.agentId)) ?? { status: "failed" });
        }
        this.advance(group);
      } else {
        const { entries } = await this.manager
          .timeline(group.chair.agentId)
          .catch(() => ({ entries: [] as AgentStreamEnvelope[] }));
        const outcome = lastOutcome(entries);
        if (outcome) {
          this.resolveChair(group, outcome);
        }
      }
    }
  }

  private async memberOutcome(agentId: string): Promise<Outcome | undefined> {
    const known = this.outcomes.get(agentId);
    if (known) {
      return known;
    }
    const { entries } = await this.manager.timeline(agentId).catch(() => ({ entries: [] }));
    return lastOutcome(entries);
  }

  // -------------------------------------------------------------------------
  // RPC 入口
  // -------------------------------------------------------------------------

  list(): AgentGroup[] {
    return [...this.groups.values()].map((group) => structuredClone(group)).sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): AgentGroup {
    return structuredClone(this.require(id));
  }

  private require(id: string): AgentGroup {
    const group = this.groups.get(id);
    if (!group) {
      throw new AgentInvalidParamsError(`协作组不存在：${id}`);
    }
    return group;
  }

  async create(input: ParsedGroupCreate): Promise<AgentGroup> {
    const providers = new Set<string>([
      ...input.members.map((member) => member.provider),
      ...(input.chair ? [input.chair.provider] : []),
    ]);
    for (const provider of providers) {
      const client = this.registry.get(provider);
      if (!client) {
        throw new AgentRpcError("PROVIDER_NOT_FOUND", `未知的 provider：${provider}`);
      }
      const availability = await client.isAvailable();
      if (!availability.available) {
        throw new AgentRpcError(
          "PROVIDER_UNAVAILABLE",
          availability.reason ?? `provider ${provider} 当前不可用`,
        );
      }
    }
    const perMember = input.worktree === "per-member";
    if (perMember) {
      if (!(await isInsideGitRepo(input.cwd))) {
        throw new AgentInvalidParamsError(
          `「成员独立 worktree」要求工作目录位于 git 仓库内：${input.cwd}`,
        );
      }
      if (!this.dataDir) {
        throw new AgentRpcError("NOT_SUPPORTED", "未设置数据目录，无法创建 worktree");
      }
    }

    let id = randomUUID().slice(0, 8);
    while (this.groups.has(id)) {
      id = randomUUID().slice(0, 8);
    }
    const title = input.title?.trim() || input.prompt.trim().replace(/\s+/g, " ").slice(0, TITLE_MAX_CHARS);

    const worktrees: Array<{ path: string; branch: string } | undefined> = [];
    const rollbackWorktrees = async () => {
      for (const worktree of worktrees) {
        if (worktree) {
          await removeWorktree({
            repoCwd: input.cwd,
            path: worktree.path,
            branch: worktree.branch,
            deleteBranch: true,
          }).catch((error: unknown) =>
            this.logger.warn("回滚 worktree %s 失败：%s", worktree.path, errorMessage(error)),
          );
        }
      }
    };
    if (perMember) {
      for (let index = 0; index < input.members.length; index += 1) {
        const n = index + 1;
        try {
          worktrees.push(
            await addWorktree({
              repoCwd: input.cwd,
              path: path.join(this.dataDir!, "worktrees", id, String(n)),
              branch: `agentdeck/${id}/${n}`,
            }),
          );
        } catch (error) {
          await rollbackWorktrees();
          throw new AgentRpcError("INTERNAL_ERROR", errorMessage(error));
        }
      }
    }

    const created = await Promise.allSettled(
      input.members.map((member, index) =>
        this.manager.createAgent({
          provider: member.provider,
          cwd: worktrees[index]?.path ?? input.cwd,
          ...(member.model ? { model: member.model } : {}),
          ...(member.modeId ? { modeId: member.modeId } : {}),
          ...(member.thinkingOptionId ? { thinkingOptionId: member.thinkingOptionId } : {}),
          title: `${title} · 成员 ${index + 1}`,
          groupId: id,
          origin: "group",
        }),
      ),
    );
    const failed = created.find((item): item is PromiseRejectedResult => item.status === "rejected");
    if (failed) {
      for (const item of created) {
        if (item.status === "fulfilled") {
          await this.manager.deleteAgent(item.value.id).catch(() => undefined);
        }
      }
      await rollbackWorktrees();
      throw failed.reason instanceof AgentRpcError
        ? failed.reason
        : new AgentRpcError("INTERNAL_ERROR", `创建成员会话失败：${errorMessage(failed.reason)}`);
    }
    const agents = created.map((item) => (item as PromiseFulfilledResult<{ id: string }>).value);

    const group: AgentGroup = {
      id,
      title,
      prompt: input.prompt,
      cwd: input.cwd,
      createdAt: Date.now(),
      members: input.members.map((member, index) => ({
        agentId: agents[index]!.id,
        provider: member.provider,
        ...(member.model ? { model: member.model } : {}),
        ...(worktrees[index] ? { worktree: worktrees[index] } : {}),
      })),
      ...(input.chair
        ? {
            chair: {
              provider: input.chair.provider,
              ...(input.chair.model ? { model: input.chair.model } : {}),
              mode: input.chair.mode,
            },
          }
        : {}),
      status: "running",
    };
    this.groups.set(id, group);
    for (const member of group.members) {
      this.agentIndex.set(member.agentId, id);
    }
    this.persist(group);

    // 同时发送同一 prompt；某个成员发送失败记为该成员失败，不影响其余
    await Promise.all(
      group.members.map(async (member) => {
        try {
          await this.manager.sendPrompt(member.agentId, input.prompt, undefined, { internal: true });
        } catch (error) {
          this.logger.warn("协作组 %s 成员 %s 发送失败：%s", id, member.agentId, errorMessage(error));
          if (!this.outcomes.has(member.agentId)) {
            this.outcomes.set(member.agentId, { status: "failed", error: errorMessage(error) });
          }
        }
      }),
    );
    this.advance(group);
    return structuredClone(group);
  }

  /** 成员会话保留（只解除 groupId）；removeWorktrees 时先中断运行中的成员再删 worktree 与分支，失败项返回 warnings */
  async delete(id: string, removeWorktrees: boolean): Promise<{ warnings?: string[] }> {
    const group = this.require(id);
    this.groups.delete(id);
    const agentIds = [...group.members.map((member) => member.agentId), ...(group.chair?.agentId ? [group.chair.agentId] : [])];
    const warnings: string[] = [];
    for (const agentId of agentIds) {
      this.agentIndex.delete(agentId);
      this.outcomes.delete(agentId);
    }
    if (removeWorktrees) {
      for (const member of group.members) {
        await this.manager.cancel(member.agentId).catch(() => undefined);
      }
    }
    for (const agentId of agentIds) {
      await this.manager.setGroupId(agentId, null).catch(() => undefined);
    }
    if (removeWorktrees) {
      for (const member of group.members) {
        if (!member.worktree) {
          continue;
        }
        try {
          await removeWorktree({
            repoCwd: group.cwd,
            path: member.worktree.path,
            branch: member.worktree.branch,
            deleteBranch: true,
          });
        } catch (error) {
          warnings.push(`${member.worktree.path}：${errorMessage(error)}`);
        }
      }
    }
    await this.store.remove(id);
    for (const listener of this.listeners) {
      listener.onRemoved?.(id);
    }
    return warnings.length > 0 ? { warnings } : {};
  }

  // -------------------------------------------------------------------------
  // 回合结束监听与汇总
  // -------------------------------------------------------------------------

  private handleStream(envelope: AgentStreamEnvelope): void {
    const groupId = this.agentIndex.get(envelope.agentId);
    if (!groupId) {
      return;
    }
    const event = envelope.event;
    if (event.type === "turn_started") {
      if (event.origin === "background") {
        this.backgroundTurns.add(event.turnId);
      }
      return;
    }
    let outcome: Outcome;
    if (event.type === "turn_completed") {
      outcome = { status: "completed" };
    } else if (event.type === "turn_failed") {
      outcome = { status: "failed", error: event.error };
    } else if (event.type === "turn_canceled") {
      outcome = { status: "canceled" };
    } else {
      return;
    }
    if (this.backgroundTurns.delete(event.turnId)) {
      return;
    }
    const group = this.groups.get(groupId);
    if (!group) {
      return;
    }
    if (group.chair?.agentId === envelope.agentId) {
      if (group.status === "chairing") {
        this.resolveChair(group, outcome);
      }
      return;
    }
    if (!this.outcomes.has(envelope.agentId)) {
      this.outcomes.set(envelope.agentId, outcome);
      this.advance(group);
    }
  }

  private handleAgentRemoved(agentId: string): void {
    const groupId = this.agentIndex.get(agentId);
    if (!groupId) {
      return;
    }
    this.agentIndex.delete(agentId);
    this.outcomes.delete(agentId);
    const group = this.groups.get(groupId);
    if (!group) {
      return;
    }
    if (group.chair?.agentId === agentId) {
      delete group.chair.agentId;
      if (group.status === "chairing") {
        group.status = "failed";
      }
      this.persist(group);
      return;
    }
    group.members = group.members.filter((member) => member.agentId !== agentId);
    this.persist(group);
    this.advance(group);
  }

  /** 所有成员都有首个回合结局后：无 chair / 无成员 → done；有 chair → chairing 并建汇总会话 */
  private advance(group: AgentGroup): void {
    if (
      group.status !== "running" ||
      this.advancing.has(group.id) ||
      group.members.some((member) => !this.outcomes.has(member.agentId))
    ) {
      return;
    }
    if (!group.chair || group.members.length === 0) {
      group.status = "done";
      this.persist(group);
      return;
    }
    group.status = "chairing";
    this.persist(group);
    this.advancing.add(group.id);
    void this.runChair(group)
      .catch((error: unknown) => {
        this.logger.warn("协作组 %s 汇总失败：%s", group.id, errorMessage(error));
        if (this.groups.get(group.id) === group && group.status === "chairing") {
          group.status = "failed";
          this.persist(group);
        }
      })
      .finally(() => this.advancing.delete(group.id));
  }

  private async runChair(group: AgentGroup): Promise<void> {
    const chair = group.chair!;
    const inputs: ChairMemberInput[] = [];
    for (const [index, member] of group.members.entries()) {
      const { entries } = await this.manager.timeline(member.agentId).catch(() => ({ entries: [] }));
      let diff: string | undefined;
      if (member.worktree) {
        diff = await diffStat({ cwd: member.worktree.path }).catch((error: unknown) => `（读取失败：${errorMessage(error)}）`);
      }
      const reply = lastAssistantText(entries);
      inputs.push({
        label: `成员 ${index + 1}（${member.provider}${member.model ? `/${member.model}` : ""}）`,
        ...(this.outcomes.get(member.agentId) ? { outcome: this.outcomes.get(member.agentId)! } : {}),
        ...(reply !== undefined ? { reply } : {}),
        ...(diff !== undefined ? { diff } : {}),
        ...(member.worktree ? { worktree: member.worktree } : {}),
      });
    }
    const prompt = buildChairPrompt(chair.mode, group.prompt, inputs);
    const agent = await this.manager.createAgent({
      provider: chair.provider,
      cwd: group.cwd,
      ...(chair.model ? { model: chair.model } : {}),
      title: `${group.title} · 汇总`,
      groupId: group.id,
      origin: "group",
    });
    if (this.groups.get(group.id) !== group) {
      // 建会话期间协作组已被删除：不留孤儿汇总会话
      await this.manager.deleteAgent(agent.id).catch(() => undefined);
      return;
    }
    chair.agentId = agent.id;
    this.agentIndex.set(agent.id, group.id);
    this.persist(group);
    await this.manager.sendPrompt(agent.id, prompt, undefined, { internal: true });
  }

  private resolveChair(group: AgentGroup, outcome: Outcome): void {
    group.status = outcome.status === "completed" ? "done" : "failed";
    this.persist(group);
  }

  private persist(group: AgentGroup): void {
    void this.store.save(structuredClone(group)).catch((error: unknown) => {
      this.logger.error("持久化协作组 %s 失败：%s", group.id, errorMessage(error));
    });
    const snapshot = structuredClone(group);
    for (const listener of this.listeners) {
      try {
        listener.onChanged?.(snapshot);
      } catch (error) {
        this.logger.error("group.changed 监听器出错：%s", errorMessage(error));
      }
    }
  }
}
