import type { DeliveryResult, EventSink, HarnessAdapter, HarnessCapabilities, HarnessProbe, HarnessRunSpec, RoutedMessage, RunHandle, SessionRef } from "@harness-fleet/protocol";
import { commandProbe, killProcessTree, launchProcess, type ManagedRun } from "@harness-fleet/protocol";

export class PiAdapter implements HarnessAdapter {
  readonly id = "pi" as const;
  private runs = new Map<string, ManagedRun>();
  private bridges = new Map<string, HarnessRunSpec["bridge"]>();
  constructor(private readonly command = "pi", private readonly prefixArgs: string[] = []) {}
  async probe(): Promise<HarnessProbe> {
    const version = commandProbe(this.command, [...this.prefixArgs, "--offline", "--version"]);
    return { command: "pi", ...version, detail: version.available ? "Authentication is provider/model-specific; Pi verifies it when the run starts." : version.detail };
  }
  async capabilities(): Promise<HarnessCapabilities> {
    return { efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], supportsResume: true, supportsSteer: true,
      supportsReliableIncrementalCost: true, permissionProfiles: ["read-only", "workspace-write", "full-access"] };
  }
  async start(spec: HarnessRunSpec, sink: EventSink): Promise<RunHandle> {
    const args = ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--session-dir", spec.cwd + "/.fleet-sessions"];
    if (spec.bridge) args.push("-e", spec.bridge.args.at(-1) ?? spec.bridge.command);
    if (spec.model) args.push("--model", spec.model);
    if (spec.effort) args.push("--thinking", spec.effort);
    if (spec.permissionProfile === "read-only") args.push("--tools", "fleet_file_read,fleet_file_list,fleet_status,fleet_message,fleet_inbox,fleet_request_node,fleet_publish");
    else if (spec.permissionProfile === "workspace-write") args.push("--tools", "fleet_file_read,fleet_file_list,fleet_file_write,fleet_status,fleet_message,fleet_inbox,fleet_request_node,fleet_publish,fleet_add_node,fleet_edit_node,fleet_control,fleet_report");
    else args.push("--tools", "read,bash,edit,write,grep,find,ls,fleet_file_read,fleet_file_list,fleet_file_write,fleet_status,fleet_message,fleet_inbox,fleet_request_node,fleet_publish,fleet_add_node,fleet_edit_node,fleet_control,fleet_report");
    const run = launchProcess(this.id, spec, sink, {
      command: this.command, args: [...this.prefixArgs, ...args], input: JSON.stringify({ type: "prompt", message: spec.prompt }) + "\n",
      env: spec.bridge?.env,
      parse: (value, stream) => mapPi(value, stream),
      sessionFrom: (value) => object(value)?.sessionId as string | undefined,
      finalFrom: (value) => {
        const event = object(value); const message = object(event?.message);
        return event?.type === "message_end" && message?.role === "assistant" ? textContent(message.content) : undefined;
      },
    });
    void run.settled.then((result) => { if (result.session) this.bridges.set(result.session.id, spec.bridge); });
    this.runs.set(run.id, run); return run;
  }
  async resume(session: SessionRef, message: string, sink: EventSink): Promise<RunHandle> {
    const spec: HarnessRunSpec = { fleetId: "resume", nodeId: "orchestrator", attemptId: session.id, cwd: session.cwd, prompt: message,
      permissionProfile: "workspace-write", bridge: this.bridges.get(session.id) };
    const args = ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--session", session.id,
      "--tools", "fleet_file_read,fleet_file_list,fleet_file_write,fleet_status,fleet_message,fleet_inbox,fleet_request_node,fleet_publish,fleet_add_node,fleet_edit_node,fleet_control,fleet_report"];
    if (spec.bridge) args.push("-e", spec.bridge.args.at(-1) ?? spec.bridge.command);
    const run = launchProcess(this.id, spec, sink, { command: this.command, args: [...this.prefixArgs, ...args], input: JSON.stringify({ type: "prompt", message }) + "\n", env: spec.bridge?.env,
      parse: (value, stream) => mapPi(value, stream), sessionFrom: () => session.id,
      finalFrom: (value) => { const event = object(value); const response = object(event?.message); return event?.type === "message_end" && response?.role === "assistant" ? textContent(response.content) : undefined; } });
    this.runs.set(run.id, run); return run;
  }
  async send(handle: RunHandle, message: RoutedMessage): Promise<DeliveryResult> {
    const run = this.runs.get(handle.id); if (!run || run.process.exitCode !== null) return { accepted: false, boundary: "next-turn", detail: "session is not running" };
    run.process.stdin.write(JSON.stringify({ type: "steer", message: `Fleet message from ${message.from}: ${message.body}` }) + "\n");
    return { accepted: true, boundary: "next-turn" };
  }
  async cancel(handle: RunHandle, graceMs: number): Promise<void> { const run = this.runs.get(handle.id); if (run) await killProcessTree(run.process, graceMs); }
}

function object(value: unknown): Record<string, any> | undefined { return value && typeof value === "object" ? value as Record<string, any> : undefined; }
function textContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  return value.filter((x) => object(x)?.type === "text").map((x) => object(x)?.text).join("\n") || undefined;
}
function mapPi(value: unknown, stream: "stdout" | "stderr") {
  const e = object(value); if (!e) return { type: "process.output" as const, payload: { stream, text: String(value) } };
  const map: Record<string, any> = { agent_start: "session.started", turn_start: "turn.started", turn_end: "turn.completed",
    message_end: "assistant.message", tool_execution_start: "tool.call", tool_execution_end: "tool.result", agent_end: "session.settled" };
  const type = map[e.type] ?? (stream === "stderr" ? "error" : "process.output");
  const usage = object(object(e.message)?.usage);
  return { type, payload: usage ? { ...e, incrementalCostUsd: usage.cost?.total, costQuality: usage.cost?.total === undefined ? "unavailable" : "reported" } : e };
}
