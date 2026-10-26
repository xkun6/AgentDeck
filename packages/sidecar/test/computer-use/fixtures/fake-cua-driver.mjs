// 假的 cua-driver（stdio MCP server）：list_windows 返回固定窗口；pid 工具返回自身 pid；exit 工具让进程退出
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "fake-cua-driver", version: "0.0.1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ["list_windows", "pid", "exit"].map((name) => ({ name, inputSchema: { type: "object" } })),
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "exit") {
    setTimeout(() => process.exit(0), 10);
    return { content: [{ type: "text", text: "bye" }] };
  }
  if (request.params.name === "pid") {
    return { content: [{ type: "text", text: String(process.pid) }] };
  }
  const structured = { windows: [{ window_id: 1, pid: 1, bounds: { x: 0, y: 0, width: 1, height: 1 } }] };
  return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
});
process.stderr.write("fake driver ready\n");
await server.connect(new StdioServerTransport());
