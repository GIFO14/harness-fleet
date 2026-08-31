import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const baseUrl = process.env.HARNESS_FLEET_URL;
const token = process.env.HARNESS_FLEET_TOKEN;
if (!baseUrl || !token) throw new Error("HARNESS_FLEET_URL and HARNESS_FLEET_TOKEN are required");

async function call(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${baseUrl}/api/v1/bridge${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init?.headers },
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `bridge request failed (${response.status})`);
  return value;
}
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const server = new McpServer({ name: "harness-fleet", version: "0.1.0" });

server.registerTool("fleet_status", { description: "Read your authorized fleet/node status", inputSchema: {} }, async () => result(await call("/status")));
server.registerTool("fleet_inbox", { description: "Read pending messages addressed to this session", inputSchema: {} }, async () => result(await call("/inbox")));
server.registerTool("fleet_message", {
  description: "Send an audited message to the orchestrator or another worker",
  inputSchema: { recipient: z.string(), body: z.string().min(1) },
}, async ({ recipient, body }) => result(await call("/messages", { method: "POST", body: JSON.stringify({ recipient, body }) })));
server.registerTool("fleet_ack", {
  description: "Acknowledge a delivered fleet message",
  inputSchema: { message_id: z.string() },
}, async ({ message_id }) => result(await call(`/messages/${encodeURIComponent(message_id)}/ack`, { method: "POST" })));
server.registerTool("fleet_publish", {
  description: "Publish status or an attempt-owned artifact path",
  inputSchema: { status: z.string().optional(), path: z.string().optional(), content: z.string().optional(), note: z.string().optional() },
}, async (body) => result(await call("/publish", { method: "POST", body: JSON.stringify(body) })));
server.registerTool("fleet_file_read", {
  description: "Read a UTF-8 file inside the capability-owned workspace",
  inputSchema: { path: z.string() },
}, async ({ path }) => result(await call(`/files?path=${encodeURIComponent(path)}`)));
server.registerTool("fleet_file_list", {
  description: "List a directory inside the capability-owned workspace",
  inputSchema: { path: z.string().default(".") },
}, async ({ path }) => result(await call(`/files/list?path=${encodeURIComponent(path)}`)));
server.registerTool("fleet_file_write", {
  description: "Write a UTF-8 file inside a workspace-write capability root",
  inputSchema: { path: z.string(), content: z.string() },
}, async (body) => result(await call("/files", { method: "POST", body: JSON.stringify(body) })));
server.registerTool("fleet_request_node", {
  description: "Request that the orchestrator add a new worker; this does not create the worker",
  inputSchema: { reason: z.string().min(1), suggested_task: z.string().min(1), suggested_harness: z.enum(["pi", "claude-code", "codex"]).optional() },
}, async (body) => result(await call("/node-requests", { method: "POST", body: JSON.stringify(body) })));
server.registerTool("fleet_add_node", {
  description: "Orchestrator-only: add a validated pending worker",
  inputSchema: { worker: z.record(z.string(), z.unknown()) },
}, async ({ worker }) => result(await call("/orchestrator/nodes", { method: "POST", body: JSON.stringify(worker) })));
server.registerTool("fleet_edit_node", {
  description: "Orchestrator-only: edit a non-running worker",
  inputSchema: { node_id: z.string(), worker: z.record(z.string(), z.unknown()) },
}, async ({ node_id, worker }) => result(await call(`/orchestrator/nodes/${encodeURIComponent(node_id)}`, { method: "PUT", body: JSON.stringify(worker) })));
server.registerTool("fleet_control", {
  description: "Orchestrator-only: pause, resume, kill, or relaunch. Launch is always human-only.",
  inputSchema: { action: z.enum(["pause", "resume", "kill", "relaunch"]), node_id: z.string().optional() },
}, async ({ action, node_id }) => result(await call("/orchestrator/control", { method: "POST", body: JSON.stringify({ action, nodeId: node_id }) })));
server.registerTool("fleet_report", { description: "Orchestrator-only: generate the current fleet report", inputSchema: {} },
  async () => result(await call("/orchestrator/report")));

await server.connect(new StdioServerTransport());
