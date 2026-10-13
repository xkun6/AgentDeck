// Derived from paseo packages/server/src/server/agent/providers/claude/subagents/live-source.ts (Apache-2.0); modified for AgentDeck
// 改动：消息类型换成 AgentDeck 自写的 stream-json-types；去掉 workflow 结果文件读取与 effort hooks（observeHook）。
import type { ProviderSubagentStatus } from "@agentdeck/protocol";

import type { ClaudeOutputMessage, ClaudeTaskSystemMessage } from "../stream-json-types.js";
import type { SubagentObservation } from "./observation.js";
import {
  buildClaudeSubagentSubtitle,
  resolveObservedClaudeModelId,
  type ClaudeSubagentPresentationFacts,
  type ClaudeSubagentUsage,
} from "./presentation.js";

/**
 * Claude Code 在 stream-json 输出里公告子代理生命周期（2.1.296 实测）：
 *
 *   task_started       task_id, tool_use_id, description, subagent_type, task_type, prompt
 *   task_updated       task_id, patch.status, patch.is_backgrounded
 *   task_progress      task_id, usage.total_tokens
 *   task_notification  task_id, tool_use_id, status, usage
 *
 * 只有 task_started 带规范的 tool_use_id，所以要记住 task_id → 子代理 id 的映射；同一 task 恢复时
 * 可能以新的 tool_use_id 再次公告，后来的 id 视为第一个 id 的别名。
 * 映射表是会话级的（task id 是会话级的），回合结束不清空——回合结束只需 cancelRunningForegroundTasks。
 */

/** Task 工具派出的子代理；后台 shell 命令公告为 local_bash */
const CLAUDE_SUBAGENT_TASK_TYPE = "local_agent";
/** workflow 执行与 Task 子代理走同一套 task 生命周期 */
const CLAUDE_WORKFLOW_TASK_TYPE = "local_workflow";

interface TaskStartedFields {
  taskId: string;
  toolUseId: string | undefined;
  description: string | undefined;
  subagentType: string | undefined;
  taskType: string | undefined;
  prompt: string | undefined;
  skipTranscript: boolean;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** 有 task_type 时只认 local_agent / local_workflow；早于 task_type 的版本要求有 subagent_type */
function isProviderSubagentTask(message: TaskStartedFields): boolean {
  if (message.taskType) {
    return (
      message.taskType === CLAUDE_SUBAGENT_TASK_TYPE || message.taskType === CLAUDE_WORKFLOW_TASK_TYPE
    );
  }
  return message.subagentType !== undefined;
}

function readUsage(usage: { total_tokens?: unknown } | undefined): ClaudeSubagentUsage | null {
  if (!usage || typeof usage.total_tokens !== "number") return null;
  return { totalTokens: usage.total_tokens };
}

/** 描述里没有 paused / pending，二者都不是终态，按 running；killed 是取消而不是失败 */
function mapTaskStatus(status: unknown): ProviderSubagentStatus | undefined {
  switch (status) {
    case "pending":
    case "running":
    case "paused":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "killed":
    case "stopped":
      return "canceled";
    default:
      return undefined;
  }
}

export interface ClaudeTaskProtocolSourceInput {
  /** 父会话 Task 调用的 input（按 tool_use_id）；Task 调用显式的 `name` 优先于 subagent_type 作为标题 */
  getToolInput?: (toolUseId: string) => Record<string, unknown> | null | undefined;
}

export class ClaudeTaskProtocolSource {
  /** task_id → 规范子代理 id（Task 的 tool_use_id），由 task_started 建立 */
  private readonly subagentIdByTaskId = new Map<string, string>();
  /** 公告过的每个 tool id → 第一个公开标识该子代理的 tool id */
  private readonly canonicalIdByToolUseId = new Map<string, string>();
  /** sidechain 里发起的工具调用 → 发起它的直接子代理 */
  private readonly ownerSubagentIdByToolUseId = new Map<string, string>();
  /** 被公告的 task 继承其工具调用的归属（含 local_bash） */
  private readonly ownerSubagentIdByTaskId = new Map<string, string>();
  /** 本 source 声明过的全部子代理 id；不在这里的 id 要么被过滤要么从未公告 */
  private readonly declaredIds = new Set<string>();
  /** workflow 调用在父时间线里已有自己的 Workflow 卡片；嵌套子代理的卡片在上级 sidechain 里 */
  private readonly idsWithExistingParentToolCard = new Set<string>();
  /** 已转入后台的子代理：活得比派出它的回合久，回合结束不代表它停了 */
  private readonly backgroundedIds = new Set<string>();
  /** 每个子代理最后一次发出的状态，避免重复广播 */
  private readonly lastStatusById = new Map<string, ProviderSubagentStatus>();
  private readonly presentationById = new Map<string, ClaudeSubagentPresentationFacts>();
  private readonly lastSubtitleById = new Map<string, string>();
  private sawTaskStarted = false;
  private sawAnyTask = false;
  private readonly getToolInput: (toolUseId: string) => Record<string, unknown> | null | undefined;

  constructor(input: ClaudeTaskProtocolSourceInput = {}) {
    this.getToolInput = input.getToolInput ?? (() => null);
  }

  /** 本会话至少声明过一个子代理 */
  get isActive(): boolean {
    return this.sawTaskStarted;
  }

  /**
   * 本会话公告过任何 task（含被过滤的）。一旦 CLI 公告 task 就会公告全部 task，
   * 所以未声明 id 的 sidechain 帧必然属于被过滤的工作，应丢弃。
   */
  get announcesTasks(): boolean {
    return this.sawAnyTask;
  }

  isDeclared(subagentId: string): boolean {
    return this.declaredIds.has(subagentId);
  }

  /** Claude tool id → 拥有其状态与时间线的子代理 id */
  resolveSubagentId(toolUseId: string): string | undefined {
    const canonicalId = this.canonicalIdByToolUseId.get(toolUseId);
    return canonicalId && this.declaredIds.has(canonicalId) ? canonicalId : undefined;
  }

  needsSyntheticParentToolCard(subagentId: string): boolean {
    return !this.idsWithExistingParentToolCard.has(subagentId);
  }

  observe(message: ClaudeOutputMessage): SubagentObservation[] {
    if (message.type !== "system") return [];
    const task = message as ClaudeTaskSystemMessage;
    switch (message.subtype) {
      case "task_started":
        return this.observeTaskStarted(task);
      case "task_updated":
        return this.observeTaskUpdated(task);
      case "task_notification":
        return this.observeTaskNotification(task);
      case "task_progress":
        return this.observeUsage(task);
      default:
        return [];
    }
  }

  /** 忘掉整个会话（只在会话关闭时调用） */
  reset(): void {
    this.subagentIdByTaskId.clear();
    this.canonicalIdByToolUseId.clear();
    this.ownerSubagentIdByToolUseId.clear();
    this.ownerSubagentIdByTaskId.clear();
    this.declaredIds.clear();
    this.idsWithExistingParentToolCard.clear();
    this.backgroundedIds.clear();
    this.lastStatusById.clear();
    this.presentationById.clear();
    this.lastSubtitleById.clear();
    this.sawTaskStarted = false;
    this.sawAnyTask = false;
  }

  /**
   * 回合被取消：把它在前台运行的子代理记为 canceled。只报告状态、不动路由表，
   * 之后到达的 task_notification 仍可纠正这个猜测。已转入后台的子代理跳过。
   */
  cancelRunningForegroundTasks(): SubagentObservation[] {
    const observations: SubagentObservation[] = [];
    for (const id of this.declaredIds) {
      if (this.backgroundedIds.has(id)) continue;
      if (this.lastStatusById.get(id) !== "running") continue;
      this.lastStatusById.set(id, "canceled");
      observations.push({ kind: "status", id, status: "canceled" });
    }
    return observations;
  }

  /** claude 进程丢失：它拥有的所有任务（含后台）都结束为 failed */
  failRunningTasks(): SubagentObservation[] {
    const observations: SubagentObservation[] = [];
    for (const id of this.declaredIds) {
      if (this.lastStatusById.get(id) !== "running") continue;
      this.lastStatusById.set(id, "failed");
      observations.push({ kind: "status", id, status: "failed" });
    }
    return observations;
  }

  /**
   * 子代理自己的 assistant 帧：记录它发起的工具调用（嵌套子代理的归属），并读出它实际运行的模型。
   * 只认已声明的子代理，避免被过滤的任务以无名、永远运行的行出现。
   */
  observeSidechainFrame(message: ClaudeOutputMessage, subagentId: string): SubagentObservation[] {
    if (message.type !== "assistant" || !this.declaredIds.has(subagentId)) return [];
    const content = message.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "tool_use" && typeof block.id === "string") {
          this.ownerSubagentIdByToolUseId.set(block.id, subagentId);
        }
      }
    }
    const model = resolveObservedClaudeModelId(message.message?.model);
    if (!model) return [];
    return this.updatePresentation(subagentId, { model });
  }

  private observeTaskStarted(message: ClaudeTaskSystemMessage): SubagentObservation[] {
    // 在过滤之前记录：这证明 CLI 会公告 task，与本 task 是否子代理无关
    this.sawAnyTask = true;
    const taskId = readString(message.task_id);
    if (!taskId) return [];
    const fields: TaskStartedFields = {
      taskId,
      toolUseId: readString(message.tool_use_id),
      description: readString(message.description),
      subagentType: readString(message.subagent_type),
      taskType: readString(message.task_type),
      prompt: readString(message.prompt),
      skipTranscript: message.skip_transcript === true,
    };

    const id = fields.toolUseId;
    const parentSubagentId = id ? this.ownerSubagentIdByToolUseId.get(id) : undefined;
    if (parentSubagentId) this.ownerSubagentIdByTaskId.set(taskId, parentSubagentId);
    // skip_transcript 表示不该出现在记录里的后台杂务
    if (!id || fields.skipTranscript || !isProviderSubagentTask(fields)) return [];

    this.sawTaskStarted = true;
    const existingId = this.subagentIdByTaskId.get(taskId);
    if (existingId) {
      return this.observeExistingTaskStart(fields, id, existingId);
    }
    return this.observeNewTaskStart(fields, id, parentSubagentId);
  }

  private observeExistingTaskStart(
    message: TaskStartedFields,
    toolUseId: string,
    existingId: string,
  ): SubagentObservation[] {
    this.canonicalIdByToolUseId.set(toolUseId, existingId);
    const observations: SubagentObservation[] = [];
    if (this.lastStatusById.get(existingId) !== "running") {
      this.lastStatusById.set(existingId, "running");
      observations.push({ kind: "status", id: existingId, status: "running" });
    }
    const prompt =
      message.taskType === CLAUDE_WORKFLOW_TASK_TYPE ? message.description : message.prompt;
    if (prompt) {
      observations.push({
        kind: "timeline",
        id: existingId,
        item: { type: "user_message", text: prompt },
      });
    }
    return observations;
  }

  private observeNewTaskStart(
    message: TaskStartedFields,
    id: string,
    parentSubagentId: string | undefined,
  ): SubagentObservation[] {
    this.subagentIdByTaskId.set(message.taskId, id);
    this.canonicalIdByToolUseId.set(id, id);
    this.declaredIds.add(id);
    this.lastStatusById.set(id, "running");

    const isWorkflow = message.taskType === CLAUDE_WORKFLOW_TASK_TYPE;
    if (isWorkflow || parentSubagentId) {
      this.idsWithExistingParentToolCard.add(id);
    }
    // Task 调用显式的 name 优先于类型：否则五个并发 Explore 看起来一模一样
    const title = isWorkflow
      ? "Workflow"
      : (readString(this.getToolInput(id)?.name) ?? message.subagentType);
    const observations: SubagentObservation[] = [
      {
        kind: "declared",
        id,
        toolCallId: id,
        ...(title ? { title } : {}),
        ...(message.description ? { description: message.description } : {}),
        ...(parentSubagentId ? { parentSubagentId } : {}),
      },
    ];
    const initialPresentation = title ? { title } : {};
    this.presentationById.set(id, initialPresentation);
    const initialSubtitle = buildClaudeSubagentSubtitle(initialPresentation);
    if (initialSubtitle) {
      this.lastSubtitleById.set(id, initialSubtitle);
      observations.push({ kind: "subtitle", id, subtitle: initialSubtitle });
    }

    // 子代理时间线以它实际收到的任务开头；workflow 的 prompt 是脚本源码，改用 description
    const prompt = isWorkflow ? message.description : message.prompt;
    if (prompt) {
      observations.push({ kind: "timeline", id, item: { type: "user_message", text: prompt } });
    }
    return observations;
  }

  private observeTaskUpdated(message: ClaudeTaskSystemMessage): SubagentObservation[] {
    const taskId = readString(message.task_id);
    if (!taskId) return [];
    const id = this.subagentIdByTaskId.get(taskId);
    const backgrounded = message.patch?.is_backgrounded;
    if (id && typeof backgrounded === "boolean") {
      if (backgrounded) this.backgroundedIds.add(id);
      else this.backgroundedIds.delete(id);
    }
    return this.observeStatus(taskId, message.patch?.status);
  }

  private observeTaskNotification(message: ClaudeTaskSystemMessage): SubagentObservation[] {
    const taskId = readString(message.task_id);
    if (!taskId) return [];
    return [...this.observeUsage(message), ...this.observeStatus(taskId, message.status)];
  }

  /** task_progress 每次工具调用触发一次，是后台子代理（没有 sidechain 帧）唯一的活动信号 */
  private observeUsage(message: ClaudeTaskSystemMessage): SubagentObservation[] {
    const taskId = readString(message.task_id);
    const id = taskId ? this.subagentIdByTaskId.get(taskId) : undefined;
    const usage = readUsage(message.usage);
    if (!id || !usage) return [];
    return this.updatePresentation(id, { usage });
  }

  private updatePresentation(
    id: string,
    patch: ClaudeSubagentPresentationFacts,
  ): SubagentObservation[] {
    const previous = this.presentationById.get(id) ?? {};
    const next: ClaudeSubagentPresentationFacts = { ...previous, ...patch };
    this.presentationById.set(id, next);
    const subtitle = buildClaudeSubagentSubtitle(next);
    if (!subtitle || this.lastSubtitleById.get(id) === subtitle) return [];
    this.lastSubtitleById.set(id, subtitle);
    return [{ kind: "subtitle", id, subtitle }];
  }

  /**
   * 状态只经由本 source 声明过的 task 路由：被过滤的 task 也会收到 task_notification，
   * 回退到它的 tool_use_id 会让被过滤的东西以无名行重新出现。
   */
  private observeStatus(taskId: string, rawStatus: unknown): SubagentObservation[] {
    const id = this.subagentIdByTaskId.get(taskId);
    if (!id) return [];
    const status = mapTaskStatus(rawStatus);
    if (!status || this.lastStatusById.get(id) === status) return [];
    this.lastStatusById.set(id, status);
    return [{ kind: "status", id, status }];
  }
}
