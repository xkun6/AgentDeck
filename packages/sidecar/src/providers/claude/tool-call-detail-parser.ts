// Derived from paseo packages/server/src/server/agent/providers/claude/tool-call-detail-parser.ts (Apache-2.0); modified for AgentDeck
// 改动：ToolCallDetail 来自 @agentdeck/protocol（精简版）；去掉 speak 工具；Skill 的 plain_text 不带 icon；
// Task / Agent 子代理工具 → sub_agent（design.md 4.11；log 由会话按子代理活动补全）；
// AskUserQuestion → question（design.md 4.13，AgentDeck 新增）。
import { z } from "zod";

import type { AgentQuestion, AgentQuestionOption, ToolCallDetail } from "@agentdeck/protocol";

import {
  ToolEditInputSchema,
  ToolEditOutputSchema,
  ToolGlobOutputSchema,
  ToolGrepOutputSchema,
  ToolReadInputSchema,
  ToolReadOutputSchema,
  ToolSearchInputSchema,
  ToolShellInputSchema,
  ToolShellOutputSchema,
  ToolWebFetchInputSchema,
  ToolWebFetchOutputSchema,
  ToolWebSearchOutputSchema,
  ToolWriteInputSchema,
  ToolWriteOutputSchema,
  toEditToolDetail,
  toFetchToolDetail,
  toReadToolDetail,
  toSearchToolDetail,
  toShellToolDetail,
  toWriteToolDetail,
  toolDetailBranchByName,
} from "../shared/index.js";

const ClaudeGrepOutputSchema = z
  .union([
    ToolGrepOutputSchema,
    z
      .object({ output: z.string() })
      .passthrough()
      .transform(({ output }) => ({ numFiles: 0, filenames: [] as string[], content: output })),
  ])
  .nullable();

const ClaudeToolEnvelopeSchema = z
  .object({
    name: z.string().min(1),
    input: z.unknown().nullable(),
    output: z.unknown().nullable(),
  })
  .passthrough();

const TextOutputSchema = z
  .union([
    z
      .object({ output: z.string() })
      .passthrough()
      .transform((value) => value.output),
    z.string(),
  ])
  .nullable();

function readToolBranch(name: string) {
  return toolDetailBranchByName(name, ToolReadInputSchema, z.unknown(), (input, output) => {
    const parsedOutput = ToolReadOutputSchema.safeParse(output);
    return toReadToolDetail(input, parsedOutput.success ? parsedOutput.data : null);
  });
}

function subAgentBranch(name: string) {
  return toolDetailBranchByName(
    name,
    z
      .object({
        subagent_type: z.string().optional(),
        description: z.string().optional(),
        prompt: z.string().optional(),
      })
      .passthrough(),
    z.unknown(),
    // design.md 4.11：Task / Agent 的卡片为 sub_agent，log 由会话按子代理活动补全
    (input) =>
      ({
        type: "sub_agent" as const,
        ...(input?.subagent_type ? { subAgentType: input.subagent_type } : {}),
        ...(input?.description ? { description: input.description } : {}),
        log: "",
      }) satisfies ToolCallDetail,
  );
}

const ClaudeToolDetailPass2Schema = z.union([
  toolDetailBranchByName("Bash", ToolShellInputSchema, ToolShellOutputSchema, toShellToolDetail),
  toolDetailBranchByName("bash", ToolShellInputSchema, ToolShellOutputSchema, toShellToolDetail),
  toolDetailBranchByName("shell", ToolShellInputSchema, ToolShellOutputSchema, toShellToolDetail),
  toolDetailBranchByName(
    "exec_command",
    ToolShellInputSchema,
    ToolShellOutputSchema,
    toShellToolDetail,
  ),
  readToolBranch("Read"),
  readToolBranch("read"),
  readToolBranch("read_file"),
  readToolBranch("view_file"),
  toolDetailBranchByName("Write", ToolWriteInputSchema, ToolWriteOutputSchema, toWriteToolDetail),
  toolDetailBranchByName("write", ToolWriteInputSchema, ToolWriteOutputSchema, toWriteToolDetail),
  toolDetailBranchByName(
    "write_file",
    ToolWriteInputSchema,
    ToolWriteOutputSchema,
    toWriteToolDetail,
  ),
  toolDetailBranchByName(
    "create_file",
    ToolWriteInputSchema,
    ToolWriteOutputSchema,
    toWriteToolDetail,
  ),
  toolDetailBranchByName("Edit", ToolEditInputSchema, ToolEditOutputSchema, toEditToolDetail),
  toolDetailBranchByName("MultiEdit", ToolEditInputSchema, ToolEditOutputSchema, toEditToolDetail),
  toolDetailBranchByName("multi_edit", ToolEditInputSchema, ToolEditOutputSchema, toEditToolDetail),
  toolDetailBranchByName("edit", ToolEditInputSchema, ToolEditOutputSchema, toEditToolDetail),
  toolDetailBranchByName(
    "apply_patch",
    ToolEditInputSchema,
    ToolEditOutputSchema,
    toEditToolDetail,
  ),
  toolDetailBranchByName("apply_diff", ToolEditInputSchema, ToolEditOutputSchema, toEditToolDetail),
  toolDetailBranchByName(
    "str_replace_editor",
    ToolEditInputSchema,
    ToolEditOutputSchema,
    toEditToolDetail,
  ),
  toolDetailBranchByName(
    "WebSearch",
    ToolSearchInputSchema,
    ToolWebSearchOutputSchema.nullable(),
    (input, output) => toSearchToolDetail({ input, output, toolName: "web_search" }),
  ),
  toolDetailBranchByName(
    "web_search",
    ToolSearchInputSchema,
    ToolWebSearchOutputSchema.nullable(),
    (input, output) => toSearchToolDetail({ input, output, toolName: "web_search" }),
  ),
  toolDetailBranchByName("search", ToolSearchInputSchema, z.unknown(), (input) =>
    toSearchToolDetail({ input, toolName: "search" }),
  ),
  toolDetailBranchByName("Grep", ToolSearchInputSchema, ClaudeGrepOutputSchema, (input, output) =>
    toSearchToolDetail({ input, output, toolName: "grep" }),
  ),
  toolDetailBranchByName("grep", ToolSearchInputSchema, ClaudeGrepOutputSchema, (input, output) =>
    toSearchToolDetail({ input, output, toolName: "grep" }),
  ),
  toolDetailBranchByName(
    "Glob",
    ToolSearchInputSchema,
    ToolGlobOutputSchema.nullable(),
    (input, output) => toSearchToolDetail({ input, output, toolName: "glob" }),
  ),
  toolDetailBranchByName(
    "glob",
    ToolSearchInputSchema,
    ToolGlobOutputSchema.nullable(),
    (input, output) => toSearchToolDetail({ input, output, toolName: "glob" }),
  ),
  toolDetailBranchByName(
    "WebFetch",
    ToolWebFetchInputSchema,
    ToolWebFetchOutputSchema,
    toFetchToolDetail,
  ),
  toolDetailBranchByName(
    "web_fetch",
    ToolWebFetchInputSchema,
    ToolWebFetchOutputSchema,
    toFetchToolDetail,
  ),
  toolDetailBranchByName(
    "WebFetchTool",
    ToolWebFetchInputSchema,
    ToolWebFetchOutputSchema,
    toFetchToolDetail,
  ),
  toolDetailBranchByName(
    "web_fetch_tool",
    ToolWebFetchInputSchema,
    ToolWebFetchOutputSchema,
    toFetchToolDetail,
  ),
  toolDetailBranchByName(
    "webfetch",
    ToolWebFetchInputSchema,
    ToolWebFetchOutputSchema,
    toFetchToolDetail,
  ),
  toolDetailBranchByName(
    "Skill",
    z.object({ skill: z.string() }).passthrough(),
    TextOutputSchema,
    (input, output) => {
      const skillName = input?.skill;
      if (!skillName) {
        return undefined;
      }
      return {
        type: "plain_text" as const,
        label: skillName,
        ...(output ? { text: output } : {}),
      } satisfies ToolCallDetail;
    },
  ),
  subAgentBranch("Task"),
  subAgentBranch("Agent"),
]);

type QuestionToolDetail = Extract<ToolCallDetail, { type: "question" }>;

/** Claude AskUserQuestion 的工具名 */
export const CLAUDE_ASK_USER_QUESTION_TOOL = "AskUserQuestion";

/**
 * AskUserQuestion 的 input → question detail（design.md 4.13）。宽松解析：缺 question / 没有合法选项的题目、
 * 缺 label 的选项一律跳过；answers 只保留字符串值。没有任何合法题目时返回 null。
 */
export function toQuestionToolDetail(input: unknown): QuestionToolDetail | null {
  if (!isRecord(input) || !Array.isArray(input.questions)) {
    return null;
  }
  const questions: AgentQuestion[] = [];
  for (const raw of input.questions) {
    if (!isRecord(raw) || !nonEmptyString(raw.question) || !Array.isArray(raw.options)) {
      continue;
    }
    const options = raw.options.flatMap((option): AgentQuestionOption[] => {
      if (!isRecord(option) || !nonEmptyString(option.label)) {
        return [];
      }
      return [
        {
          label: option.label,
          ...(nonEmptyString(option.description) ? { description: option.description } : {}),
          ...(nonEmptyString(option.preview) ? { preview: option.preview } : {}),
        },
      ];
    });
    if (options.length === 0) {
      continue;
    }
    questions.push({
      question: raw.question,
      ...(nonEmptyString(raw.header) ? { header: raw.header } : {}),
      multiSelect: raw.multiSelect === true,
      options,
    });
  }
  if (questions.length === 0) {
    return null;
  }
  const answers = readQuestionAnswers(input.answers);
  return { type: "question", questions, ...(answers ? { answers } : {}) };
}

/** answers 对象中的字符串值；没有任何非空回答时返回 undefined */
export function readQuestionAnswers(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const answers: Record<string, string> = {};
  for (const [question, answer] of Object.entries(value)) {
    if (nonEmptyString(answer)) {
      answers[question] = answer;
    }
  }
  return Object.keys(answers).length > 0 ? answers : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function deriveClaudeToolDetail(
  name: string,
  input: unknown,
  output: unknown,
): ToolCallDetail {
  if (name === CLAUDE_ASK_USER_QUESTION_TOOL) {
    const question = toQuestionToolDetail(input);
    if (question) {
      return question;
    }
  }
  const pass1 = ClaudeToolEnvelopeSchema.safeParse({
    name,
    input: input ?? null,
    output: output ?? null,
  });
  if (!pass1.success) {
    return {
      type: "unknown",
      input: input ?? null,
      output: output ?? null,
    };
  }

  const pass2 = ClaudeToolDetailPass2Schema.safeParse(pass1.data);
  if (pass2.success && pass2.data) {
    return pass2.data;
  }

  return {
    type: "unknown",
    input: pass1.data.input,
    output: pass1.data.output,
  };
}
