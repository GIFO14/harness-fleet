import { randomUUID } from "node:crypto";
import type { DeliveryResult, EventSink, HarnessAdapter, HarnessCapabilities, HarnessProbe, HarnessRunSpec, RoutedMessage, RunHandle, SessionRef } from "@harness-fleet/protocol";

export interface FakeResponse { exitCode?: number; finalMessage?: string; delayMs?: number; error?: string }
export class FakeHarness implements HarnessAdapter {
  readonly id = "pi" as const;
  readonly starts: HarnessRunSpec[] = []; readonly messages: RoutedMessage[] = []; readonly cancelled: string[] = [];
  constructor(private readonly responses: FakeResponse[] = []) {}
  async probe(): Promise<HarnessProbe> { return { available: true, authenticated: true, command: "fake", version: "1.0.0" }; }
  async capabilities(): Promise<HarnessCapabilities> { return { efforts: ["off","minimal","low","medium","high","xhigh","max"], supportsResume: true,
    supportsSteer: true, supportsReliableIncrementalCost: true, permissionProfiles: ["read-only","workspace-write","full-access"] }; }
  async start(spec: HarnessRunSpec, sink: EventSink): Promise<RunHandle> {
    this.starts.push(spec); const response = this.responses.shift() ?? {}; const session = { id: randomUUID(), harness: this.id, cwd: spec.cwd } as const;
    await sink({ fleetId: spec.fleetId, nodeId: spec.nodeId, attemptId: spec.attemptId, type: "session.started", at: new Date().toISOString(), payload: { sessionId: session.id } });
    const settled = new Promise<any>((resolve) => setTimeout(() => resolve({ exitCode: response.exitCode ?? 0, session, finalMessage: response.finalMessage, error: response.error }), response.delayMs ?? 0));
    return { id: randomUUID(), harness: this.id, session, settled };
  }
  async resume(session: SessionRef, message: string, sink: EventSink): Promise<RunHandle> {
    return this.start({ fleetId: "resume", nodeId: "orchestrator", attemptId: session.id, cwd: session.cwd, prompt: message, permissionProfile: "workspace-write" }, sink);
  }
  async send(_handle: RunHandle, message: RoutedMessage): Promise<DeliveryResult> { this.messages.push(message); return { accepted: true, boundary: "next-turn" }; }
  async cancel(handle: RunHandle): Promise<void> { this.cancelled.push(handle.id); }
}
