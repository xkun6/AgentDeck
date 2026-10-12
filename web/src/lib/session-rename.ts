import { rememberSessionTitleOverride } from "@/lib/session-ui-state";
import { resolveGatewaySessionId } from "@/lib/session-map";

function isSessionNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("session not found");
}

export interface RenameDeps {
  setSessionTitle: (gatewaySessionId: string, title: string) => Promise<string | undefined>;
  resumeSession: (persistentSessionId: string) => Promise<string>;
}

/**
 * Persist a new title for a session.
 *
 * Tries the live gateway first; if that session no longer exists, attempts to
 * resume it and retry. Always writes the title to the local override store so
 * the UI reflects the change even if the gateway can't be reached.
 */
export async function renameSession(
  persistentSessionId: string,
  newTitle: string,
  deps: RenameDeps,
): Promise<string> {
  const cleanTitle = newTitle.trim();
  if (!cleanTitle) throw new Error("请输入会话名称");

  const initialSessionId = resolveGatewaySessionId(persistentSessionId) ?? persistentSessionId;
  let savedTitle: string | undefined;

  try {
    savedTitle = await deps.setSessionTitle(initialSessionId, cleanTitle);
  } catch (error) {
    if (!isSessionNotFoundError(error)) throw error;
    try {
      const resumedSessionId = await deps.resumeSession(persistentSessionId);
      savedTitle = await deps.setSessionTitle(resumedSessionId, cleanTitle);
      rememberSessionTitleOverride(resumedSessionId, savedTitle ?? cleanTitle);
    } catch (resumeError) {
      if (!isSessionNotFoundError(resumeError)) throw resumeError;
      savedTitle = cleanTitle;
    }
  }

  rememberSessionTitleOverride(persistentSessionId, savedTitle ?? cleanTitle);
  if (initialSessionId !== persistentSessionId) {
    rememberSessionTitleOverride(initialSessionId, savedTitle ?? cleanTitle);
  }
  return savedTitle ?? cleanTitle;
}
