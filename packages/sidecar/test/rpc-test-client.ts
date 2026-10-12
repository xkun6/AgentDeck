import type {
  AgentRpcErrorObject,
  AgentRpcMethodName,
  AgentRpcMethods,
  AgentRpcResult,
  AgentSnapshot,
  AgentStreamEnvelope,
  AgentStreamEvent,
} from "@agentdeck/protocol";
import { WebSocket } from "ws";

export interface RawResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: AgentRpcErrorObject;
}

interface Waiter {
  predicate: () => boolean;
  resolve: () => void;
}

export class RpcCallError extends Error {
  constructor(readonly error: AgentRpcErrorObject) {
    super(error.message);
  }
}

/** 测试用 JSON-RPC over WS 客户端：记录所有通知，按 id 匹配响应 */
export class TestRpcClient {
  readonly streams: AgentStreamEnvelope[] = [];
  readonly states: AgentSnapshot[] = [];
  readonly removed: string[] = [];
  readonly rawResponses: RawResponse[] = [];
  private nextId = 1;
  private readonly pending = new Map<string | number, (response: RawResponse) => void>();
  private readonly waiters = new Set<Waiter>();

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data) => this.onMessage(String(data)));
  }

  static connect(url: string): Promise<TestRpcClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.once("open", () => resolve(new TestRpcClient(ws)));
      ws.once("error", reject);
    });
  }

  /** 发请求并返回原始响应（含 error） */
  request(method: string, params?: unknown): Promise<RawResponse> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          ...(params !== undefined ? { params } : {}),
        }),
      );
    });
  }

  /** 发请求，成功返回 result，失败抛 RpcCallError */
  async call<M extends AgentRpcMethodName>(
    method: M,
    ...params: undefined extends AgentRpcMethods[M]["params"]
      ? [AgentRpcMethods[M]["params"]?]
      : [AgentRpcMethods[M]["params"]]
  ): Promise<AgentRpcResult<M>> {
    const response = await this.request(method, params[0]);
    if (response.error) {
      throw new RpcCallError(response.error);
    }
    return response.result as AgentRpcResult<M>;
  }

  /** 发送任意文本帧，等待下一条 id 为 null 或任意的响应 */
  sendRaw(text: string): Promise<RawResponse> {
    const before = this.rawResponses.length;
    this.ws.send(text);
    return this.waitFor(() => this.rawResponses.length > before).then(
      () => this.rawResponses[before]!,
    );
  }

  waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
    if (predicate()) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        predicate,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`waitFor 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  eventsFor(agentId: string): AgentStreamEvent[] {
    return this.streams.filter((s) => s.agentId === agentId).map((s) => s.event);
  }

  async waitForEvent<T extends AgentStreamEvent["type"]>(
    agentId: string,
    type: T,
    timeoutMs?: number,
  ): Promise<Extract<AgentStreamEvent, { type: T }>> {
    let found: AgentStreamEvent | undefined;
    await this.waitFor(() => {
      found = this.eventsFor(agentId).find((e) => e.type === type);
      return found !== undefined;
    }, timeoutMs);
    return found as Extract<AgentStreamEvent, { type: T }>;
  }

  /** 等待本 agent 的第 n 个 turn 结束事件（completed / failed / canceled） */
  async waitForTurnEnd(agentId: string, nth = 1, timeoutMs?: number): Promise<AgentStreamEvent> {
    const ends = () =>
      this.eventsFor(agentId).filter(
        (e) =>
          e.type === "turn_completed" || e.type === "turn_failed" || e.type === "turn_canceled",
      );
    await this.waitFor(() => ends().length >= nth, timeoutMs);
    return ends()[nth - 1]!;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }

  private onMessage(text: string): void {
    const message = JSON.parse(text) as Record<string, unknown>;
    if (typeof message.method === "string" && !("id" in message)) {
      if (message.method === "agent.stream") {
        this.streams.push(message.params as AgentStreamEnvelope);
      } else if (message.method === "agent.state") {
        this.states.push((message.params as { agent: AgentSnapshot }).agent);
      } else if (message.method === "agent.removed") {
        this.removed.push((message.params as { agentId: string }).agentId);
      }
    } else {
      const response = message as unknown as RawResponse;
      this.rawResponses.push(response);
      if (response.id !== null) {
        const resolve = this.pending.get(response.id);
        this.pending.delete(response.id);
        resolve?.(response);
      }
    }
    for (const waiter of Array.from(this.waiters)) {
      if (waiter.predicate()) {
        this.waiters.delete(waiter);
        waiter.resolve();
      }
    }
  }
}

/** 用不带 token 或错误 token 连接，返回 HTTP 状态码 */
export function connectExpectingRejection(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.once("open", () => {
      ws.close();
      reject(new Error("连接意外成功"));
    });
    ws.once("error", () => undefined);
  });
}
