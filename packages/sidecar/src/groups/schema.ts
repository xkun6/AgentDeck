import { z } from "zod";

export const GROUP_MEMBERS_MIN = 2;
export const GROUP_MEMBERS_MAX = 6;

const memberInput = z.object({
  provider: z.string().min(1),
  model: z.string().nullable().optional(),
  modeId: z.string().nullable().optional(),
  thinkingOptionId: z.string().min(1).nullable().optional(),
});

const chairMode = z.enum(["synthesize", "review"]);

/** group.create 入参（design.md 4.27） */
export const groupCreateSchema = z.object({
  title: z.string().trim().max(200).optional(),
  prompt: z.string().trim().min(1, "prompt 不能为空").max(100_000),
  cwd: z.string().min(1),
  members: z
    .array(memberInput)
    .min(GROUP_MEMBERS_MIN, `成员数需为 ${GROUP_MEMBERS_MIN}–${GROUP_MEMBERS_MAX} 个`)
    .max(GROUP_MEMBERS_MAX, `成员数需为 ${GROUP_MEMBERS_MIN}–${GROUP_MEMBERS_MAX} 个`),
  worktree: z.enum(["none", "per-member"]),
  chair: z
    .object({ provider: z.string().min(1), model: z.string().nullable().optional(), mode: chairMode })
    .optional(),
});

export type ParsedGroupCreate = z.output<typeof groupCreateSchema>;

/** 加载 groups/<id>.json 时的结构校验（宽松：只确认必需字段与类型） */
export const storedGroupSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  prompt: z.string(),
  cwd: z.string(),
  createdAt: z.number(),
  members: z.array(
    z.object({
      agentId: z.string().min(1),
      provider: z.string().min(1),
      model: z.string().nullable().optional(),
      worktree: z.object({ path: z.string(), branch: z.string() }).optional(),
    }),
  ),
  chair: z
    .object({
      provider: z.string().min(1),
      model: z.string().nullable().optional(),
      mode: chairMode,
      agentId: z.string().min(1).optional(),
    })
    .optional(),
  status: z.enum(["running", "chairing", "done", "failed"]),
});
