import type { DeliveryResult, EventSink, HarnessAdapter, HarnessCapabilities, HarnessProbe, HarnessRunSpec, RoutedMessage, RunHandle, SessionRef } from "@harness-fleet/protocol";
import { commandProbe, killProcessTree, launchProcess, type ManagedRun } from "@harness-fleet/protocol";

export class CodexAdapter implements HarnessAdapter {
  readonly id = "codex" as const;
  private runs = new Map<string, ManagedRun>();
  private bridges = new Map<string, HarnessRunSpec["bridge"]>();
  constructor(private readonly command = "codex", private readonly prefixArgs: string[] = []) {}
  async probe(): Promise<HarnessProbe> {
    const version = commandProbe(this.command, [...this.prefixArgs, "--version"]); const auth = version.available ? commandProbe(this.command, [...this.prefixArgs, "login", "status"]) : undefined;
    return { command: "codex", ...version, authenticated: auth?.available };
  }
  async capabilities(): Promise<HarnessCapabilities> {
    return { efforts: ["minimal", "low", "medium", "high", "xhigh", "max"], supportsResume: true, supportsSteer: false,
      supportsReliableIncrementalCost: false, permissionProfiles: ["read-only", "workspace-write", "full-access"] };
  }
  async start(spec: HarnessRunSpec, sink: EventSink): Promise<RunHandle> {
    const args = ["exec", "--json", "--color", "never", "-C", spec.cwd];
    if (spec.model) args.push("--model", spec.model);
    if (spec.effort) args.push("-c", `model_reasoning_effort="${spec.effort}"`);
    if (spec.permissionProfile === "full-access") args.push("--dangerously-bypass-approvals-and-sandbox");
    else args.push("--sandbox", spec.permissionProfile);
    if (spec.bridge) {
      args.push("-c", `mcp_servers.harness_fleet.command=${JSON.stringify(spec.bridge.command)}`);
      args.push("-c", `mcp_servers.harness_fleet.args=${JSON.stringify(spec.bridge.args)}`);
      for (const [key, value] of Object.entries(spec.bridge.env)) args.push("-c", `mcp_servers.harness_fleet.env.${key}=${JSON.stringify(value)}`);
    }
    args.push("-");
    const run = launchProcess(this.id, spec, sink, { command: this.command, args: [...this.prefixArgs, ...args], input: spec.prompt, closeInputAfterWrite: true, env: spec.bridge?.env,
      parse: mapCodex, sessionFrom: (v) => object(v)?.thread_id as string | undefined,
      finalFrom: (v) => object(v)?.type === "item.completed" && object(object(v)?.item)?.type === "agent_message" ? String(object(object(v)?.item)?.text ?? "") : undefined });
    void run.settled.then((result) => { if (result.session) this.bridges.set(result.session.id, spec.bridge); });
    this.runs.set(run.id, run); return run;
  }
  async resume(session: SessionRef, message: string, sink: EventSink): Promise<RunHandle> {
    const spec: HarnessRunSpec = { fleetId: "resume", nodeId: "orchestrator", attemptId: session.id, cwd: session.cwd, prompt: message, permissionProfile: "workspace-write" };
    const bridge = this.bridges.get(session.id); const args = ["exec", "resume", "--json"];
    if (bridge) {
      args.push("-c", `mcp_servers.harness_fleet.command=${JSON.stringify(bridge.command)}`);
      args.push("-c", `mcp_servers.harness_fleet.args=${JSON.stringify(bridge.args)}`);
      for (const [key, value] of Object.entries(bridge.env)) args.push("-c", `mcp_servers.harness_fleet.env.${key}=${JSON.stringify(value)}`);
    }
    args.push(session.id, "-");
    const run = launchProcess(this.id, { ...spec, bridge }, sink, { command: this.command, args: [...this.prefixArgs, ...args],
      input: message, closeInputAfterWrite: true, parse: mapCodex, sessionFrom: () => session.id,
      finalFrom: (v) => object(v)?.type === "item.completed" && object(object(v)?.item)?.type === "agent_message" ? String(object(object(v)?.item)?.text ?? "") : undefined });
    this.runs.set(run.id, run); return run;
  }
  async send(): Promise<DeliveryResult> { return { accepted: true, boundary: "next-turn", detail: "queued by daemon for the next codex exec resume" }; }
  async cancel(handle: RunHandle, graceMs: number): Promise<void> { const run = this.runs.get(handle.id); if (run) await killProcessTree(run.process, graceMs); }
}
function object(value: unknown): Record<string, any> | undefined { return value && typeof value === "object" ? value as Record<string, any> : undefined; }
function mapCodex(value: unknown, stream: "stdout" | "stderr"): any {
  const e = object(value); if (!e) return { type: "process.output" as const, payload: { stream, text: String(value) } };
  const item = object(e.item);
  const type = e.type === "thread.started" ? "session.started" : e.type === "turn.started" ? "turn.started" : e.type === "turn.completed" ? "turn.completed"
    : e.type === "turn.failed" ? "turn.failed" : e.type === "item.started" && item?.type?.includes("tool") ? "tool.call"
    : e.type === "item.completed" && item?.type?.includes("tool") ? "tool.result" : e.type === "item.completed" && item?.type === "agent_message" ? "assistant.message"
    : stream === "stderr" ? "error" : "process.output";
  return { type, payload: { ...e, costQuality: "unavailable" } };
}
