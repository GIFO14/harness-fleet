import { describe, expect, it } from "vitest";
import { renderReport } from "@harness-fleet/core";

describe("fleet reports", () => {
  it("never presents an unavailable cost as zero", () => {
    const fleet = {
      id: "fleet", runId: "run", repoPath: ".", status: "completed", fullAccessConfirmed: false,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      spec: { version: 1, fleet_name: "demo", goal: "test", orchestrator: { harness: "codex", permission_profile: "workspace-write" }, workers: [] },
    } as any;
    const attempts = [{ nodeId: "worker", number: 1, harness: "codex", status: "completed", costQuality: "unavailable" }] as any;
    const report = renderReport(fleet, attempts, []);
    expect(report).toContain("Cost: Unavailable for 1 attempt(s)");
    expect(report).not.toContain("$0.0000 known");
  });
});
