import { z } from "zod";

import { isValidCron } from "./cron.js";

export const DEFAULT_DONE_MARKER = "GOAL_DONE";

const cronExpr = z
  .string()
  .trim()
  .refine(isValidCron, "cron 表达式非法（需要 5 段：分 时 日 月 周）");

const triggerSchema = z.union([
  z.object({ cron: cronExpr }),
  z.object({ everyMinutes: z.number().int().min(1).max(525_600) }),
  z.object({ at: z.number().int().positive() }),
]);

const targetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent"), agentId: z.string().min(1) }),
  z.object({
    type: z.literal("new"),
    provider: z.string().min(1),
    cwd: z.string().min(1),
    model: z.string().nullable().optional(),
    modeId: z.string().nullable().optional(),
    thinkingOptionId: z.string().min(1).nullable().optional(),
    title: z.string().optional(),
  }),
]);

const name = z.string().trim().min(1).max(100);
const prompt = z.string().trim().min(1).max(20_000);

const common = {
  id: z.string().min(1).optional(),
  name,
  enabled: z.boolean().default(true),
};

/** schedule.upsert 的入参（也用于加载 schedules.json 时的字段校验与补默认值） */
export const scheduleDraftSchema = z.discriminatedUnion("kind", [
  z.object({
    ...common,
    kind: z.literal("cron"),
    trigger: triggerSchema,
    target: targetSchema,
    prompt,
    onBusy: z.enum(["skip", "wait"]).default("skip"),
  }),
  z.object({
    ...common,
    kind: z.literal("heartbeat"),
    agentId: z.string().min(1),
    idleMinutes: z.number().int().min(1).max(525_600),
    prompt,
    maxRuns: z.number().int().min(1).optional(),
    runs: z.number().int().min(0).optional(),
  }),
  z.object({
    ...common,
    kind: z.literal("goal"),
    agentId: z.string().min(1),
    goal: z.string().trim().min(1).max(10_000),
    doneMarker: z.string().trim().min(1).max(200).default(DEFAULT_DONE_MARKER),
    maxIterations: z.number().int().min(1).max(1000),
    iterations: z.number().int().min(0).optional(),
    judge: z
      .object({ provider: z.string().min(1), model: z.string().nullable().optional() })
      .optional(),
    stopOnFailure: z.boolean().default(true),
    state: z.enum(["running", "done", "stopped", "exhausted", "failed"]).optional(),
  }),
]);

export type ParsedScheduleDraft = z.output<typeof scheduleDraftSchema>;
