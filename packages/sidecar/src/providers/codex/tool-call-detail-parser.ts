// Derived from paseo packages/server/src/server/agent/providers/codex/tool-call-detail-parser.ts (Apache-2.0); modified for AgentDeck
// 改动：ToolCallDetail 来自 @agentdeck/protocol；去掉 speak 分支；stripCwdPrefix 内联（paseo 在 protocol/path-utils）。
import type { ToolCallDetail } from "@agentdeck/protocol";
import { z } from "zod";

import {
  ToolEditInputSchema,
  ToolEditOutputSchema,
  ToolReadInputSchema,
  ToolReadOutputWithPathSchema,
  ToolSearchInputSchema,
  ToolShellInputSchema,
  ToolShellOutputSchema,
  ToolWriteInputSchema,
  ToolWriteOutputSchema,
  toEditToolDetail,
  toReadToolDetail,
  toSearchToolDetail,
  toShellToolDetail,
  toWriteToolDetail,
  toolDetailBranchByNameWithCwd,
} from "../shared/index.js";

const CodexToolEnvelopeSchema = z
  .object({
    name: z.string().min(1),
    input: z.unknown().nullable(),
    output: z.unknown().nullable(),
    cwd: z.string().nullable().optional(),
  })
  .passthrough();

const CodexLooseEditOutputSchema = z.unknown().transform((value) => {
  const parsed = ToolEditOutputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
});

/** 把位于 cwd 之下的绝对路径改写为相对路径（统一用 / 分隔） */
export function stripCwdPrefix(filePath: string, cwd?: string | null): string {
  if (!cwd || !filePath) {
    return filePath;
  }
  const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = filePath.replace(/\\/g, "/");
  const prefix = `${normalizedCwd}/`;
  if (normalizedPath.toLowerCase().startsWith(prefix.toLowerCase())) {
    return normalizedPath.slice(prefix.length);
  }
  if (normalizedPath.toLowerCase() === normalizedCwd.toLowerCase()) {
    return ".";
  }
  return filePath;
}

export function normalizeCodexFilePath(
  filePath: string,
  cwd: string | null | undefined,
): string | undefined {
  if (!filePath) {
    return undefined;
  }
  if (typeof cwd === "string" && cwd.length > 0) {
    return stripCwdPrefix(filePath, cwd);
  }
  return filePath;
}

function normalizePathForCwd(cwd: string | null): (filePath: string) => string | undefined {
  return (filePath) => normalizeCodexFilePath(filePath, cwd);
}

const shellBranch = (name: string) =>
  toolDetailBranchByNameWithCwd(name, ToolShellInputSchema, ToolShellOutputSchema, (input, output) =>
    toShellToolDetail(input, output),
  );

const readBranch = (name: string) =>
  toolDetailBranchByNameWithCwd(name, ToolReadInputSchema, z.unknown(), (input, output, cwd) => {
    const parsedOutput = ToolReadOutputWithPathSchema.safeParse(output);
    return toReadToolDetail(input, parsedOutput.success ? parsedOutput.data : null, {
      normalizePath: normalizePathForCwd(cwd),
    });
  });

const writeBranch = (name: string) =>
  toolDetailBranchByNameWithCwd(
    name,
    ToolWriteInputSchema,
    ToolWriteOutputSchema,
    (input, output, cwd) =>
      toWriteToolDetail(input, output, { normalizePath: normalizePathForCwd(cwd) }),
  );

const editBranch = (name: string) =>
  toolDetailBranchByNameWithCwd(
    name,
    ToolEditInputSchema,
    CodexLooseEditOutputSchema,
    (input, output, cwd) =>
      toEditToolDetail(input, output, { normalizePath: normalizePathForCwd(cwd) }),
  );

const CodexToolDetailPass2Schema = z.union([
  shellBranch("Bash"),
  shellBranch("shell"),
  shellBranch("bash"),
  shellBranch("exec"),
  shellBranch("exec_command"),
  shellBranch("command"),
  readBranch("read"),
  readBranch("read_file"),
  writeBranch("write"),
  writeBranch("write_file"),
  writeBranch("create_file"),
  editBranch("edit"),
  editBranch("apply_patch"),
  editBranch("apply_diff"),
  toolDetailBranchByNameWithCwd("search", ToolSearchInputSchema, z.unknown(), (input) =>
    toSearchToolDetail({ input, toolName: "search" }),
  ),
  toolDetailBranchByNameWithCwd("web_search", ToolSearchInputSchema, z.unknown(), (input) =>
    toSearchToolDetail({ input, toolName: "web_search" }),
  ),
]);

export function deriveCodexToolDetail(params: {
  name: string;
  input: unknown;
  output: unknown;
  cwd?: string | null;
}): ToolCallDetail {
  const pass1 = CodexToolEnvelopeSchema.safeParse({
    name: params.name,
    input: params.input ?? null,
    output: params.output ?? null,
    cwd: params.cwd ?? null,
  });
  if (!pass1.success) {
    return {
      type: "unknown",
      input: params.input ?? null,
      output: params.output ?? null,
    };
  }

  const pass2 = CodexToolDetailPass2Schema.safeParse(pass1.data);
  if (pass2.success && pass2.data) {
    return pass2.data;
  }

  return {
    type: "unknown",
    input: pass1.data.input,
    output: pass1.data.output,
  };
}
