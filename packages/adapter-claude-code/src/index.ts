import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DeliveryResult, EventSink, HarnessAdapter, HarnessCapabilities, HarnessProbe, HarnessRunSpec, RoutedMessage, RunHandle, SessionRef } from "@harness-fleet/protocol";
import { commandProbe, killProcessTree, launchProcess, type ManagedRun } from "@harness-fleet/protocol";

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly id = "claude-code" as const;
  private runs = new Map<string, ManagedRun>();
  private bridges = new Map<string, HarnessRunSpec["bridge"]>();
  constructor(private readonly command = "claude", private readonly prefixArgs: string[] = []) {}
  async probe(): Promise<HarnessProbe> {
    const version = commandProbe(this.command, [...this.prefixArgs, "--version"]); const auth = version.available ? commandProbe(this.command, [...this.prefixArgs, "auth", "status"]) : undefined;
    return { command: "claude", ...version, authenticated: auth?.available };
  }
  async capabilities(): Promise<HarnessCapabilities> {
    return { efforts: ["low", "medium", "high", "xhigh", "max"], supportsResume: true, supportsSteer: true,
      supportsReliableIncrementalCost: true, permissionProfiles: ["read-only", "workspace-write", "full-access"] };
  }
  async start(spec: HarnessRunSpec, sink: EventSink): Promise<RunHandle> {
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
    if (spec.model) args.push("--model", spec.model);
    if (spec.effort) args.push("--effort", spec.effort);
    if (spec.permissionProfile === "read-only") args.push("--permission-mode", "plan");
    else if (spec.permissionProfile === "workspace-write") args.push("--permission-mode", "acceptEdits");
    else args.push("--dangerously-skip-permissions");
    if (spec.bridge) {
      const path = join(spec.cwd, ".fleet-claude-mcp.json"); mkdirSync(spec.cwd, { recursive: true });
      writeFileSync(path, JSON.stringify({ mcpServers: { "harness-fleet": spec.bridge } }));
      args.push("--mcp-config", path, "--strict-mcp-config");
    }
    const run = launchProcess(this.id, spec, sink, {
      command: this.command, args: [...this.prefixArgs, ...args], input: JSON.stringify({ type: "user", message: { role: "user", content: spec.prompt } }) + "\n",
      env: spec.bridge?.env, parse: mapClaude,
      sessionFrom: (value) => object(value)?.session_id as string | undefined,
      finalFrom: (value) => object(value)?.type === "result" ? String(object(value)?.result ?? "") : undefined,
    });
    void run.settled.then((result) => { if (result.session) this.bridges.set(result.session.id, spec.bridge); });
    this.runs.set(run.id, run); return run;
  }
  async resume(session: SessionRef, message: string, sink: EventSink): Promise<RunHandle> {
    const spec: HarnessRunSpec = { fleetId: "resume", nodeId: "orchestrator", attemptId: session.id, cwd: session.cwd, prompt: message, permissionProfile: "workspace-write" };
    const args = ["-p", "--resume", session.id, "--output-format", "stream-json", "--verbose"];
    const bridge = this.bridges.get(session.id);
    if (bridge) { const path = join(session.cwd, ".fleet-claude-mcp.json"); writeFileSync(path, JSON.stringify({ mcpServers: { "harness-fleet": bridge } })); args.push("--mcp-config", path, "--strict-mcp-config"); }
    const run = launchProcess(this.id, { ...spec, bridge }, sink, { command: this.command, args: [...this.prefixArgs, ...args],
      input: message, parse: mapClaude, sessionFrom: () => session.id, finalFrom: (v) => object(v)?.type === "result" ? String(object(v)?.result ?? "") : undefined });
    this.runs.set(run.id, run); return run;
  }
  async send(handle: RunHandle, message: RoutedMessage): Promise<DeliveryResult> {
    const run = this.runs.get(handle.id); if (!run || run.process.exitCode !== null) return { accepted: false, boundary: "next-turn", detail: "session is not running" };
    run.process.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: `Fleet message from ${message.from}: ${message.body}` } }) + "\n");
    return { accepted: true, boundary: "next-turn" };
  }
  async cancel(handle: RunHandle, graceMs: number): Promise<void> { const run = this.runs.get(handle.id); if (run) await killProcessTree(run.process, graceMs); }
}
function object(value: unknown): Record<string, any> | undefined { return value && typeof value === "object" ? value as Record<string, any> : undefined; }
function mapClaude(value: unknown, stream: "stdout" | "stderr"): any {
  const e = object(value); if (!e) return { type: "process.output" as const, payload: { stream, text: String(value) } };
  const type = e.type === "system" ? "session.started" : e.type === "assistant" ? "assistant.message" : e.type === "result" ? (e.is_error ? "turn.failed" : "turn.completed") : stream === "stderr" ? "error" : "process.output";
  return { type, payload: { ...e, incrementalCostUsd: e.total_cost_usd, costQuality: e.total_cost_usd === undefined ? "unavailable" : "reported" } };
}
