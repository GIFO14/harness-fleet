import { describe, expect, it } from "vitest";
import { parseFleetSpec, topologicalOrder, validateCapabilities, FleetValidationError } from "@harness-fleet/core";
import type { FleetSpec, HarnessCapabilities } from "@harness-fleet/protocol";

const mixed = `
version: 1
fleet_name: mixed-demo
goal: Ship a reviewed change
orchestrator:
  harness: codex
  effort: high
workers:
  - id: research
    harness: pi
    type: research
    task: Find the relevant code
  - id: implement
    harness: claude-code
    type: code-run
    task: Implement it
    depends_on: [research]
  - id: review
    harness: codex
    type: review
    task: Review it
    depends_on: [implement]
`;
describe("fleet spec", () => {
  it("parses real YAML, applies safe defaults, and orders a mixed DAG", () => {
    const spec = parseFleetSpec(mixed);
    expect(spec.config?.max_workers).toBe(32);
    expect(spec.workers[0].permission_profile).toBe("read-only");
    expect(spec.workers[1].permission_profile).toBe("workspace-write");
    expect(spec.workers[1].worktree).toBe(true);
    expect(topologicalOrder(spec).map((x) => x.id)).toEqual(["research", "implement", "review"]);
  });
  it("requires a harness on every worker", () => {
    expect(() => parseFleetSpec(mixed.replace("    harness: pi\n", ""))).toThrow(FleetValidationError);
  });
  it("rejects cycles", () => {
    expect(() => parseFleetSpec(mixed.replace("    task: Find the relevant code", "    task: Find the relevant code\n    depends_on: [review]"))).toThrow(/cycle/);
  });
  it("does not silently degrade unsupported effort", async () => {
    const spec = parseFleetSpec(mixed);
    const caps: HarnessCapabilities = { efforts: ["low"], supportsResume: true, supportsSteer: false,
      supportsReliableIncrementalCost: false, permissionProfiles: ["read-only", "workspace-write", "full-access"] };
    await expect(validateCapabilities(spec, async () => caps)).rejects.toThrow(/does not support effort/);
  });
  it("refuses a hard cost cap with incomplete cost telemetry", async () => {
    const spec = parseFleetSpec(mixed) as FleetSpec; spec.config!.max_cost_usd = 10; spec.orchestrator.effort = undefined;
    const caps: HarnessCapabilities = { efforts: ["low"], supportsResume: true, supportsSteer: false,
      supportsReliableIncrementalCost: false, permissionProfiles: ["read-only", "workspace-write", "full-access"] };
    await expect(validateCapabilities(spec, async () => caps)).rejects.toThrow(/reliable incremental cost/);
  });
});
