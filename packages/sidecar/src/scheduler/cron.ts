import { Cron } from "croner";

/** 5 段 cron（分 时 日 月 周，本地时区；design.md 4.25）是否合法 */
export function isValidCron(expr: string): boolean {
  const text = expr.trim();
  if (text.split(/\s+/).length !== 5) {
    return false;
  }
  try {
    new Cron(text);
    return true;
  } catch {
    return false;
  }
}

/** `fromMs` 之后（不含）的下一次触发时间（ms）；表达式非法或不再触发返回 null */
export function nextCronAfter(expr: string, fromMs: number): number | null {
  try {
    const next = new Cron(expr.trim()).nextRun(new Date(fromMs));
    return next ? next.getTime() : null;
  } catch {
    return null;
  }
}
