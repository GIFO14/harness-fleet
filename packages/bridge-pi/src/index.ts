type PiApi = { registerTool(tool: Record<string, unknown>): void };

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", properties, required, additionalProperties: false,
});

async function bridge(path: string, body?: unknown): Promise<any> {
  const url = process.env.HARNESS_FLEET_URL; const token = process.env.HARNESS_FLEET_TOKEN;
  if (!url || !token) throw new Error("Harness Fleet bridge environment is missing");
  const response = await fetch(`${url}/api/v1/bridge${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `bridge request failed (${response.status})`);
  return value;
}
const output = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

export default function register(pi: PiApi): void {
  pi.registerTool({ name: "fleet_status", label: "Fleet status", description: "Read authorized fleet status", parameters: objectSchema({}),
    execute: async () => output(await bridge("/status")) });
  pi.registerTool({ name: "fleet_inbox", label: "Fleet inbox", description: "Read pending messages", parameters: objectSchema({}),
    execute: async () => output(await bridge("/inbox")) });
  pi.registerTool({ name: "fleet_message", label: "Fleet message", description: "Send an audited message",
    parameters: objectSchema({ recipient: { type: "string" }, body: { type: "string" } }, ["recipient", "body"]),
    execute: async (_id: string, args: any) => output(await bridge("/messages", args)) });
  pi.registerTool({ name: "fleet_ack", label: "Acknowledge", description: "Acknowledge a message",
    parameters: objectSchema({ message_id: { type: "string" } }, ["message_id"]),
    execute: async (_id: string, args: any) => output(await bridge(`/messages/${encodeURIComponent(args.message_id)}/ack`, {})) });
  pi.registerTool({ name: "fleet_publish", label: "Publish", description: "Publish attempt status or artifact",
    parameters: objectSchema({ status: { type: "string" }, path: { type: "string" }, content: { type: "string" }, note: { type: "string" } }),
    execute: async (_id: string, args: any) => output(await bridge("/publish", args)) });
  pi.registerTool({ name: "fleet_file_read", label: "Read workspace file", description: "Read a UTF-8 file inside the authorized workspace",
    parameters: objectSchema({ path: { type: "string" } }, ["path"]),
    execute: async (_id: string, args: any) => output(await bridge(`/files?path=${encodeURIComponent(args.path)}`)) });
  pi.registerTool({ name: "fleet_file_list", label: "List workspace", description: "List a directory inside the authorized workspace",
    parameters: objectSchema({ path: { type: "string" } }),
    execute: async (_id: string, args: any) => output(await bridge(`/files/list?path=${encodeURIComponent(args.path ?? ".")}`)) });
  pi.registerTool({ name: "fleet_file_write", label: "Write workspace file", description: "Write a UTF-8 file inside a workspace-write root",
    parameters: objectSchema({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
    execute: async (_id: string, args: any) => output(await bridge("/files", args)) });
  pi.registerTool({ name: "fleet_request_node", label: "Request worker", description: "Ask the orchestrator for a new node",
    parameters: objectSchema({ reason: { type: "string" }, suggested_task: { type: "string" }, suggested_harness: { enum: ["pi", "claude-code", "codex"] } }, ["reason", "suggested_task"]),
    execute: async (_id: string, args: any) => output(await bridge("/node-requests", args)) });
  pi.registerTool({ name: "fleet_add_node", label: "Add worker", description: "Orchestrator-only: add a worker",
    parameters: objectSchema({ worker: { type: "object" } }, ["worker"]),
    execute: async (_id: string, args: any) => output(await bridge("/orchestrator/nodes", args.worker)) });
  pi.registerTool({ name: "fleet_edit_node", label: "Edit worker", description: "Orchestrator-only: edit a non-running worker",
    parameters: objectSchema({ node_id: { type: "string" }, worker: { type: "object" } }, ["node_id", "worker"]),
    execute: async (_id: string, args: any) => output(await bridge(`/orchestrator/nodes/${encodeURIComponent(args.node_id)}`, args.worker)) });
  pi.registerTool({ name: "fleet_control", label: "Control fleet", description: "Orchestrator-only: pause, resume, kill, or relaunch",
    parameters: objectSchema({ action: { enum: ["pause", "resume", "kill", "relaunch"] }, node_id: { type: "string" } }, ["action"]),
    execute: async (_id: string, args: any) => output(await bridge("/orchestrator/control", { action: args.action, nodeId: args.node_id })) });
  pi.registerTool({ name: "fleet_report", label: "Fleet report", description: "Orchestrator-only: generate report", parameters: objectSchema({}),
    execute: async () => output(await bridge("/orchestrator/report")) });
}
