import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AttemptRecord, EventSink, FleetEvent, FleetMessage, FleetRecord, HarnessAdapter, HarnessId, RunHandle, RunResult } from "@harness-fleet/protocol";
import { validateContracts } from "./contracts.js";
import { workerPrompt } from "./prompts.js";
const exec = promisify(execFile);

export interface SchedulerNode {
  fleetId: string; nodeId: string; spec: FleetRecord["spec"]["workers"][number]; status: string; currentAttempt: number;
}
export interface SchedulerStore {
  getFleet(id: string): FleetRecord | undefined;
  listNodes(id: string): SchedulerNode[];
  setFleetStatus(id: string, status: any, confirm?: boolean): void;
  setFullAccessConfirmed(id: string, confirmed: boolean): void;
  setNodeStatus(fleetId: string, nodeId: string, status: any, error?: string): void;
  createAttempt(fleet: FleetRecord, nodeId: string, harness: HarnessId, branch?: string): AttemptRecord;
  startAttempt(id: string, sessionId?: string, pid?: number): void;
  setAttemptSession(id: string, sessionId: string): void;
  updateAttemptCost(id: string, costUsd: number, quality: string): void;
  finishAttempt(id: string, status: any, result?: Record<string, unknown>): void;
  appendEvent(event: FleetEvent): number;
  updateReviewState(fleetId: string, nodeId: string, values: { iterationDelta?: number; lgtmDelta?: number; resetLgtm?: boolean }): { iteration: number; lgtmCount: number };
  inbox(fleetId: string, recipient: string): FleetMessage[];
  markMessage(id: string, status: "delivered" | "acknowledged" | "rejected"): void;
  acquireLease(fleetId: string, owner: string, ttlMs?: number): boolean;
  releaseLease(fleetId: string, owner: string): void;
}
export interface Workspace { cwd: string; branch?: string }
export interface SchedulerOptions {
  owner: string;
  adapters: Map<HarnessId, HarnessAdapter>;
  store: SchedulerStore;
  workspace: (fleet: FleetRecord, node: SchedulerNode, attempt: number) => Promise<Workspace>;
  onEvent?: EventSink;
  bridge: (fleet: FleetRecord, node: SchedulerNode, attempt: AttemptRecord) => Promise<HarnessRunBridge>;
  canDispatch?: (fleet: FleetRecord) => boolean;
}
export interface HarnessRunBridge { command: string; args: string[]; env: Record<string, string> }

export class FleetScheduler {
  private active = new Map<string, { adapter: HarnessAdapter; handle: RunHandle; attempt: AttemptRecord }>();
  private timers = new Map<string, NodeJS.Timeout>();
  private costs = new Map<string, number>();
  private attemptCosts = new Map<string, number>();
  private costWarned = new Set<string>();
  constructor(private readonly options: SchedulerOptions) {}

  async confirmAndLaunch(fleetId: string, allowFullAccess = false): Promise<void> {
    const fleet = this.requireFleet(fleetId);
    if (fleet.status !== "waiting_for_confirmation") throw new Error(`fleet cannot launch from ${fleet.status}`);
    if (!allowFullAccess && [fleet.spec.orchestrator, ...fleet.spec.workers].some((x) => x.permission_profile === "full-access")) {
      throw new Error("full-access requires an explicit, separate confirmation");
    }
    if (allowFullAccess) this.options.store.setFullAccessConfirmed(fleetId, true);
    this.options.store.setFleetStatus(fleetId, "running", true);
    await this.tick(fleetId);
  }

  async tick(fleetId: string): Promise<void> {
    const fleet = this.requireFleet(fleetId);
    if (fleet.status !== "running" && fleet.status !== "waiting_for_confirmation") return;
    if (fleet.status === "running" && fleet.spec.config?.max_duration_minutes && Date.now() - Date.parse(fleet.confirmedAt ?? fleet.createdAt) > fleet.spec.config.max_duration_minutes * 60_000) {
      await this.kill(fleetId, undefined, 0); this.options.store.setFleetStatus(fleetId, "failed");
      await this.event(fleetId, undefined, undefined, "error", { reason: "fleet timeout exceeded" }); return;
    }
    if (!this.options.store.acquireLease(fleetId, this.options.owner)) return;
    try {
      const fresh = this.requireFleet(fleetId); if (fresh.status !== "running") return;
      if (this.options.canDispatch && !this.options.canDispatch(fresh)) return;
      const nodes = this.options.store.listNodes(fleetId);
      const completed = new Set(nodes.filter((x) => x.status === "completed").map((x) => x.nodeId));
      const running = nodes.filter((x) => x.status === "running").length;
      const available = Math.max(0, (fresh.spec.config?.max_concurrent ?? 4) - running);
      const ready = nodes.filter((x) => (x.status === "pending" || x.status === "ready") && (x.spec.depends_on ?? []).every((d) => completed.has(d))).slice(0, available);
      await Promise.all(ready.map((node) => this.dispatch(fresh, node)));
      const after = this.options.store.listNodes(fleetId);
      if (after.every((x) => x.status === "completed")) await this.event(fleetId, undefined, undefined, "fleet.status", { status: "completed" }, () => this.options.store.setFleetStatus(fleetId, "completed"));
      else {
        const done = new Set(after.filter((x) => x.status === "completed").map((x) => x.nodeId));
        const hasPath = after.some((x) => (x.status === "pending" || x.status === "ready") && (x.spec.depends_on ?? []).every((dep) => done.has(dep)));
        if (!after.some((x) => x.status === "running") && !hasPath) {
        await this.event(fleetId, undefined, undefined, "fleet.status", { status: "needs_attention" }, () => this.options.store.setFleetStatus(fleetId, "needs_attention"));
        }
      }
    } finally { this.options.store.releaseLease(fleetId, this.options.owner); }
  }

  private async dispatch(fleet: FleetRecord, node: SchedulerNode): Promise<void> {
    const adapter = this.options.adapters.get(node.spec.harness); if (!adapter) throw new Error(`adapter unavailable: ${node.spec.harness}`);
    const workspace = await this.options.workspace(fleet, node, node.currentAttempt + 1);
    const attempt = this.options.store.createAttempt(fleet, node.nodeId, node.spec.harness, workspace.branch);
    await mkdir(attempt.artifactDir, { recursive: true });
    const prompt = workerPrompt(fleet.spec, node.spec, attempt.artifactDir, this.dependencyContext(fleet.id, node));
    await writeFile(join(attempt.artifactDir, "prompt.md"), prompt);
    await Promise.all(["stdout.log", "stderr.log", "events.jsonl"].map((name) => writeFile(join(attempt.artifactDir, name), "")));
    attempt.startedAt = new Date().toISOString(); this.options.store.startAttempt(attempt.id);
    const bridge = await this.options.bridge(fleet, node, attempt);
    const sink: EventSink = async (event) => {
      await appendFile(join(attempt.artifactDir, "events.jsonl"), JSON.stringify(event) + "\n");
      if (event.type === "process.output" && typeof event.payload.text === "string") {
        const file = event.payload.stream === "stderr" ? "stderr.log" : "stdout.log"; await appendFile(join(attempt.artifactDir, file), event.payload.text + "\n");
      }
      const incremental = Number(event.payload.incrementalCostUsd);
      if (Number.isFinite(incremental) && incremental >= 0) {
        const attemptTotal = (this.attemptCosts.get(attempt.id) ?? 0) + incremental; this.attemptCosts.set(attempt.id, attemptTotal);
        this.options.store.updateAttemptCost(attempt.id, attemptTotal, String(event.payload.costQuality ?? "reported"));
        const total = (this.costs.get(fleet.id) ?? 0) + incremental; this.costs.set(fleet.id, total);
        if (fleet.spec.config?.warn_cost_usd && total >= fleet.spec.config.warn_cost_usd && !this.costWarned.has(fleet.id)) {
          this.costWarned.add(fleet.id); const warning: FleetEvent = { fleetId: fleet.id, type: "error", at: new Date().toISOString(), payload: { warning: "cost threshold reached", totalUsd: total } };
          warning.id = this.options.store.appendEvent(warning); await this.options.onEvent?.(warning);
        }
        if (fleet.spec.config?.max_cost_usd && total >= fleet.spec.config.max_cost_usd) {
          void this.kill(fleet.id, undefined, 0).then(() => this.options.store.setFleetStatus(fleet.id, "failed"));
        }
      }
      const id = this.options.store.appendEvent(event); await this.options.onEvent?.({ ...event, id });
    };
    try {
      const handle = await adapter.start({ fleetId: fleet.id, nodeId: node.nodeId, attemptId: attempt.id, cwd: workspace.cwd, prompt,
        model: node.spec.model, effort: node.spec.effort, permissionProfile: node.spec.permission_profile ?? "read-only",
        bridge, timeoutMs: node.spec.timeout_minutes ? node.spec.timeout_minutes * 60_000 : undefined }, sink);
      this.active.set(`${fleet.id}:${node.nodeId}`, { adapter, handle, attempt });
      this.options.store.startAttempt(attempt.id, handle.session?.id, handle.pid);
      for (const message of this.options.store.inbox(fleet.id, node.nodeId).filter((x) => x.status === "pending")) await this.deliverMessage(message);
      if (node.spec.timeout_minutes) this.timers.set(attempt.id, setTimeout(() => void this.kill(fleet.id, node.nodeId, 0), node.spec.timeout_minutes * 60_000));
      void handle.settled.then((result) => this.settle(fleet, node, attempt, workspace.cwd, result)).catch((error) => this.settle(fleet, node, attempt, workspace.cwd, { exitCode: -1, error: String(error) }));
    } catch (error) {
      this.options.store.finishAttempt(attempt.id, "failed", { error: error instanceof Error ? error.message : String(error) });
      await this.tick(fleet.id);
    }
  }

  private async settle(fleet: FleetRecord, node: SchedulerNode, attempt: AttemptRecord, cwd: string, result: RunResult): Promise<void> {
    const timer = this.timers.get(attempt.id); if (timer) clearTimeout(timer);
    this.active.delete(`${fleet.id}:${node.nodeId}`);
    if (result.session?.id) this.options.store.setAttemptSession(attempt.id, result.session.id);
    const startedAt = attempt.startedAt ? Date.parse(attempt.startedAt) : Date.now() - 1;
    const contracts = result.exitCode === 0 ? await validateContracts(attempt.artifactDir, node.spec.outputs ?? [], startedAt, [cwd]) : [];
    await writeFile(join(attempt.artifactDir, "result.json"), JSON.stringify(result, null, 2));
    if (result.finalMessage) { await mkdir(join(attempt.artifactDir, "output"), { recursive: true }); await writeFile(join(attempt.artifactDir, "output", "final.md"), result.finalMessage); }
    if (cwd !== fleet.repoPath) try {
      const { stdout: base } = await exec("git", ["-C", fleet.repoPath, "rev-parse", "HEAD"], { windowsHide: true });
      const { stdout: diff } = await exec("git", ["-C", cwd, "diff", "--binary", base.trim()], { windowsHide: true, maxBuffer: 50 * 1024 * 1024 });
      await writeFile(join(attempt.artifactDir, "diff.patch"), diff);
    } catch { /* report still retains branch and process evidence */ }
    const contractFailure = contracts.find((x) => !x.ok);
    if (result.exitCode === 0 && !contractFailure) this.options.store.finishAttempt(attempt.id, "completed", { exitCode: 0 });
    else {
      const error = result.error ?? contractFailure?.detail ?? `exit code ${result.exitCode}`;
      const latest = this.options.store.listNodes(fleet.id).find((x) => x.nodeId === node.nodeId)!;
      const max = node.spec.max_attempts ?? fleet.spec.config?.max_attempts ?? 3;
      this.options.store.finishAttempt(attempt.id, latest.currentAttempt < max ? "pending" : "failed", { exitCode: result.exitCode, error });
      if (contractFailure) await this.event(fleet.id, node.nodeId, attempt.id, "contract.failed", { results: contracts });
    }
    const gate = fleet.spec.config?.loop?.gate;
    if (result.exitCode === 0 && !contractFailure && (node.spec.type === "review" || gate === node.nodeId) && result.finalMessage) {
      const verdict = /\biterate\b/i.test(result.finalMessage) ? "iterate" : /\blgtm\b/i.test(result.finalMessage) ? "lgtm" : "unclear";
      await this.event(fleet.id, node.nodeId, attempt.id, "review.verdict", { verdict, message: result.finalMessage });
      if (verdict === "iterate") {
        const state = this.options.store.updateReviewState(fleet.id, node.nodeId, { iterationDelta: 1, resetLgtm: true });
        const max = fleet.spec.config?.loop?.max_iterations ?? 4;
        if (state.iteration >= max) this.options.store.setNodeStatus(fleet.id, node.nodeId, "needs_attention", "review loop reached max_iterations");
        else {
          for (const target of node.spec.reviewer_for?.length ? node.spec.reviewer_for : node.spec.depends_on ?? []) this.options.store.setNodeStatus(fleet.id, target, "pending");
          this.options.store.setNodeStatus(fleet.id, node.nodeId, "pending");
        }
      } else if (verdict === "lgtm") {
        const state = this.options.store.updateReviewState(fleet.id, node.nodeId, { lgtmDelta: 1 });
        if (state.lgtmCount < (fleet.spec.config?.loop?.lgtm_count ?? 1)) this.options.store.setNodeStatus(fleet.id, node.nodeId, "pending");
      } else this.options.store.setNodeStatus(fleet.id, node.nodeId, "needs_attention", "reviewer returned no explicit LGTM or iterate verdict");
    }
    const settledNode = this.options.store.listNodes(fleet.id).find((x) => x.nodeId === node.nodeId);
    await this.event(fleet.id, node.nodeId, attempt.id, "node.status", { status: settledNode?.status, exitCode: result.exitCode, error: result.error });
    await this.tick(fleet.id);
  }

  async pause(fleetId: string): Promise<void> { const fleet = this.requireFleet(fleetId); if (fleet.status !== "running") throw new Error(`fleet cannot pause from ${fleet.status}`); this.options.store.setFleetStatus(fleetId, "paused"); }
  async resume(fleetId: string): Promise<void> {
    const fleet = this.requireFleet(fleetId); if (!["paused", "needs_attention", "paused_orchestrator_unavailable"].includes(fleet.status)) throw new Error(`fleet cannot resume from ${fleet.status}`);
    this.options.store.setFleetStatus(fleetId, "running"); await this.tick(fleetId);
  }
  async kill(fleetId: string, nodeId?: string, graceMs = 5_000): Promise<void> {
    const targets = [...this.active].filter(([key]) => key.startsWith(`${fleetId}:`) && (!nodeId || key === `${fleetId}:${nodeId}`));
    await Promise.all(targets.map(async ([key, run]) => { await run.adapter.cancel(run.handle, graceMs); this.options.store.finishAttempt(run.attempt.id, "cancelled"); this.active.delete(key); }));
    if (!nodeId) this.options.store.setFleetStatus(fleetId, "cancelled");
  }
  async relaunch(fleetId: string, nodeId: string): Promise<void> {
    const fleet = this.requireFleet(fleetId); this.options.store.setNodeStatus(fleetId, nodeId, "pending");
    if (["needs_attention", "failed"].includes(fleet.status)) this.options.store.setFleetStatus(fleetId, "running"); await this.tick(fleetId);
  }
  async deliverMessage(message: FleetMessage): Promise<boolean> {
    const run = this.active.get(`${message.fleetId}:${message.recipient}`); if (!run) return false;
    const result = await run.adapter.send(run.handle, { id: message.id, from: message.sender, to: message.recipient, body: message.body, createdAt: message.createdAt });
    if (result.accepted) this.options.store.markMessage(message.id, "delivered"); return result.accepted;
  }

  private dependencyContext(fleetId: string, node: SchedulerNode): string {
    return this.options.store.listNodes(fleetId).filter((x) => (node.spec.depends_on ?? []).includes(x.nodeId))
      .map((x) => `${x.nodeId}: completed`).join("\n");
  }
  private requireFleet(id: string): FleetRecord { const fleet = this.options.store.getFleet(id); if (!fleet) throw new Error(`unknown fleet ${id}`); return fleet; }
  private async event(fleetId: string, nodeId: string | undefined, attemptId: string | undefined, type: any, payload: Record<string, unknown>, mutate?: () => void): Promise<void> {
    mutate?.(); const event = { fleetId, nodeId, attemptId, type, at: new Date().toISOString(), payload }; const id = this.options.store.appendEvent(event);
    await this.options.onEvent?.({ ...event, id });
  }
}
