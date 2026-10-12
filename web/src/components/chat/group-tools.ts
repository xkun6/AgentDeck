import type { ChatToolItem } from "./chat-types";

export type ToolDisplayEntry =
  | { kind: "single"; tool: ChatToolItem }
  | { kind: "group"; key: string; tools: ChatToolItem[] };

function normalizeContext(context: string | undefined): string {
  return (context ?? "").replace(/\s+/g, " ").trim();
}

function canMerge(tool: ChatToolItem): boolean {
  return tool.status === "done";
}

export function groupConsecutiveTools(
  tools: readonly ChatToolItem[],
): ToolDisplayEntry[] {
  const result: ToolDisplayEntry[] = [];
  let i = 0;
  while (i < tools.length) {
    const head = tools[i];
    if (!canMerge(head)) {
      result.push({ kind: "single", tool: head });
      i += 1;
      continue;
    }

    const ctx = normalizeContext(head.context);
    let j = i + 1;
    while (
      j < tools.length &&
      canMerge(tools[j]) &&
      tools[j].name === head.name &&
      normalizeContext(tools[j].context) === ctx
    ) {
      j += 1;
    }

    if (j - i >= 2) {
      const slice = tools.slice(i, j);
      result.push({
        kind: "group",
        key: `${head.name}|${ctx}|${slice[0].tool_id}|${slice.length}`,
        tools: slice,
      });
    } else {
      result.push({ kind: "single", tool: head });
    }
    i = j;
  }
  return result;
}

export function groupElapsedMs(tools: readonly ChatToolItem[]): number | undefined {
  if (tools.length === 0) return undefined;
  let total = 0;
  let saw = false;
  for (const tool of tools) {
    if (typeof tool.completedAt === "number") {
      total += Math.max(0, tool.completedAt - tool.startedAt);
      saw = true;
    }
  }
  return saw ? total : undefined;
}
