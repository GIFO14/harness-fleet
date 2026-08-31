import Ajv2020 from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import { EFFORTS, FLEET_SCHEMA, type FleetSpec, type HarnessCapabilities, type HarnessId, type WorkerSpec } from "@harness-fleet/protocol";

const ajv = new (Ajv2020 as any)({ allErrors: true, useDefaults: true });
const validateSchema = ajv.compile(FLEET_SCHEMA);

export class FleetValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid fleet specification:\n${issues.map((x) => `- ${x}`).join("\n")}`);
  }
}

export function parseFleetSpec(source: string, format?: "yaml" | "json"): FleetSpec {
  let value: unknown;
  try {
    value = format === "json" ? JSON.parse(source) : parseYaml(source);
  } catch (error) {
    throw new FleetValidationError([`parse error: ${error instanceof Error ? error.message : String(error)}`]);
  }
  if (!validateSchema(value)) {
    throw new FleetValidationError((validateSchema.errors ?? []).map((e: any) => `${e.instancePath || "/"} ${e.message}`));
  }
  return applyDefaults(value as FleetSpec);
}

export function applyDefaults(spec: FleetSpec): FleetSpec {
  const clone = structuredClone(spec);
  clone.config = {
    max_concurrent: 4, max_workers: 32, max_attempts: 3,
    ...clone.config,
    loop: clone.config?.loop ? { max_iterations: 4, lgtm_count: 1, ...clone.config.loop } : undefined,
  };
  clone.orchestrator.permission_profile ??= "workspace-write";
  for (const worker of clone.workers) {
    worker.depends_on ??= [];
    worker.outputs ??= [];
    worker.permission_profile ??= worker.type === "code-run" || worker.type === "integrator" ? "workspace-write" : "read-only";
    if (worker.worktree === undefined) worker.worktree = worker.permission_profile === "workspace-write";
    if (worker.shared_checkout) worker.worktree = false;
    worker.max_attempts ??= clone.config.max_attempts;
  }
  validateGraph(clone);
  return clone;
}

export function validateGraph(spec: FleetSpec): void {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const worker of spec.workers) {
    if (ids.has(worker.id)) issues.push(`duplicate worker id '${worker.id}'`);
    ids.add(worker.id);
  }
  if (spec.workers.length > (spec.config?.max_workers ?? 32)) issues.push("worker count exceeds max_workers");
  for (const worker of spec.workers) {
    for (const dep of worker.depends_on ?? []) {
      if (!ids.has(dep)) issues.push(`worker '${worker.id}' depends on unknown worker '${dep}'`);
      if (dep === worker.id) issues.push(`worker '${worker.id}' depends on itself`);
    }
    if (worker.permission_profile === "full-access") issues.push(`worker '${worker.id}' requires explicit full-access confirmation`);
  }
  if (spec.config?.loop?.gate && !ids.has(spec.config.loop.gate)) issues.push(`loop gate '${spec.config.loop.gate}' does not exist`);
  const visiting = new Set<string>(); const visited = new Set<string>();
  const byId = new Map(spec.workers.map((x) => [x.id, x]));
  const visit = (id: string, trail: string[]) => {
    if (visiting.has(id)) { issues.push(`dependency cycle: ${[...trail, id].join(" -> ")}`); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id)?.depends_on ?? []) visit(dep, [...trail, id]);
    visiting.delete(id); visited.add(id);
  };
  for (const worker of spec.workers) visit(worker.id, []);
  const fatal = issues.filter((x) => !x.includes("requires explicit full-access"));
  if (fatal.length) throw new FleetValidationError(issues);
}

export function topologicalOrder(spec: FleetSpec): WorkerSpec[] {
  const byId = new Map(spec.workers.map((x) => [x.id, x]));
  const seen = new Set<string>(); const result: WorkerSpec[] = [];
  const visit = (worker: WorkerSpec) => {
    if (seen.has(worker.id)) return;
    for (const dep of worker.depends_on ?? []) visit(byId.get(dep)!);
    seen.add(worker.id); result.push(worker);
  };
  for (const worker of spec.workers) visit(worker);
  return result;
}

export async function validateCapabilities(
  spec: FleetSpec,
  capabilities: (harness: HarnessId) => Promise<HarnessCapabilities>,
): Promise<void> {
  const issues: string[] = [];
  for (const agent of [{ id: "orchestrator", ...spec.orchestrator }, ...spec.workers]) {
    if (!agent.effort) continue;
    if (!EFFORTS.includes(agent.effort)) continue;
    const caps = await capabilities(agent.harness);
    if (!caps.efforts.includes(agent.effort)) issues.push(`${agent.id}: ${agent.harness} does not support effort '${agent.effort}'`);
    if (agent.permission_profile && !caps.permissionProfiles.includes(agent.permission_profile)) {
      issues.push(`${agent.id}: ${agent.harness} does not support permission '${agent.permission_profile}'`);
    }
  }
  if (spec.config?.max_cost_usd) {
    const harnesses = new Set([spec.orchestrator.harness, ...spec.workers.map((x) => x.harness)]);
    for (const harness of harnesses) {
      if (!(await capabilities(harness)).supportsReliableIncrementalCost) {
        issues.push(`hard max_cost_usd requires reliable incremental cost, unavailable for ${harness}`);
      }
    }
  }
  if (issues.length) throw new FleetValidationError(issues);
}
