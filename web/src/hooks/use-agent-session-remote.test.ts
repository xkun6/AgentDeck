import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { RemoteStatus } from "@agentdeck/protocol";
import { AGENT_QUERY_KEYS } from "@/lib/agent-query-keys";
import { bindRemoteToQueries } from "./use-agent-session";

describe("bindRemoteToQueries", () => {
  it("remote.changed 直接写入 remote.status 缓存，解绑后不再写入", () => {
    let listener: ((status: RemoteStatus) => void) | null = null;
    const client = {
      onRemoteChanged: (next: (status: RemoteStatus) => void) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
    };
    const queryClient = new QueryClient();
    const unbind = bindRemoteToQueries(client, queryClient);
    const status: RemoteStatus = { enabled: true, port: 47_631, listening: true, addresses: [], devices: [] };
    listener!(status);
    expect(queryClient.getQueryData(AGENT_QUERY_KEYS.remoteStatus)).toEqual(status);
    unbind();
    expect(listener).toBeNull();
    queryClient.clear();
  });
});
