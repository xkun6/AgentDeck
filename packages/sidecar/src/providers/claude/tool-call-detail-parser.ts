// Derived from paseo packages/server/src/server/agent/providers/claude/tool-call-detail-parser.ts (Apache-2.0); modified for AgentDeck
// 改动：ToolCallDetail 来自 @agentdeck/protocol（精简版）；去掉 speak 工具；Skill 的 plain_text 不带 icon；
// Task / Agent 子代理工具 → sub_agent（design.md 4.11；log 由会话按子代理活动补全）。
import { z } from "zod";

import type { ToolCallDetail } from "@agentdeck/protocol";

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

export function deriveClaudeToolDetail(
  name: string,
  input: unknown,
  output: unknown,
): ToolCallDetail {
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
