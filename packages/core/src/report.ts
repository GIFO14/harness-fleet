import type { FleetRecord, FleetEvent, AttemptRecord } from "@harness-fleet/protocol";

export function renderReport(fleet: FleetRecord, attempts: AttemptRecord[], events: FleetEvent[]): string {
  const costKnown = attempts.filter((x) => x.costQuality !== "unavailable").reduce((sum, x) => sum + (x.costUsd ?? 0), 0);
  const unavailable = attempts.filter((x) => x.costQuality === "unavailable").length;
  return [
    `# Fleet report: ${fleet.spec.fleet_name}`,
    "",
    `- Fleet: \`${fleet.id}\``,
    `- Status: **${fleet.status}**`,
    `- Goal: ${fleet.spec.goal}`,
    `- Orchestrator: ${fleet.spec.orchestrator.harness}`,
    `- Cost: $${costKnown.toFixed(4)} known${unavailable ? `; ${unavailable} attempt(s) unavailable` : ""}`,
    "",
    "## Attempts",
    "",
    "| Node | Attempt | Harness | Status | Session | Branch | Cost quality |",
    "|---|---:|---|---|---|---|---|",
    ...attempts.map((x) => `| ${x.nodeId} | ${x.number} | ${x.harness} | ${x.status} | ${x.sessionId ?? "—"} | ${x.branch ?? "—"} | ${x.costQuality} |`),
    "",
    "## Event summary",
    "",
    ...Object.entries(events.reduce<Record<string, number>>((counts, event) => {
      counts[event.type] = (counts[event.type] ?? 0) + 1; return counts;
    }, {})).map(([type, count]) => `- ${type}: ${count}`),
  ].join("\n");
}
