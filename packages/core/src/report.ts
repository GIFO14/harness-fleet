import type { FleetRecord, FleetEvent, AttemptRecord } from "@harness-fleet/protocol";

export function renderReport(fleet: FleetRecord, attempts: AttemptRecord[], events: FleetEvent[]): string {
  const knownAttempts = attempts.filter((x) => x.costQuality !== "unavailable" && x.costUsd !== undefined);
  const costKnown = knownAttempts.reduce((sum, x) => sum + x.costUsd!, 0);
  const unavailable = attempts.filter((x) => x.costQuality === "unavailable").length;
  const costSummary = attempts.length === 0 ? "No attempts yet"
    : knownAttempts.length === 0 ? `Unavailable for ${unavailable} attempt(s)`
    : `$${costKnown.toFixed(4)} known${unavailable ? `; unavailable for ${unavailable} attempt(s)` : ""}`;
  return [
    `# Fleet report: ${fleet.spec.fleet_name}`,
    "",
    `- Fleet: \`${fleet.id}\``,
    `- Status: **${fleet.status}**`,
    `- Goal: ${fleet.spec.goal}`,
    `- Orchestrator: ${fleet.spec.orchestrator.harness}`,
    `- Cost: ${costSummary}`,
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
