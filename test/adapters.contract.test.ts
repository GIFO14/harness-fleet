import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { PiAdapter } from "../packages/adapter-pi/src/index.js";
import { ClaudeCodeAdapter } from "../packages/adapter-claude-code/src/index.js";
import { CodexAdapter } from "../packages/adapter-codex/src/index.js";
import type { HarnessAdapter, HarnessRunSpec } from "@harness-fleet/protocol";

const fixture = fileURLToPath(new URL("./fixtures/fake-cli.mjs", import.meta.url));
const factories: Array<[string, () => HarnessAdapter]> = [
  ["pi", () => new PiAdapter(process.execPath, [fixture, "pi"])],
  ["claude-code", () => new ClaudeCodeAdapter(process.execPath, [fixture, "claude"])],
  ["codex", () => new CodexAdapter(process.execPath, [fixture, "codex"])],
];
const spec = (prompt = "work"): HarnessRunSpec => ({ fleetId: "fleet", nodeId: "worker", attemptId: "attempt", cwd: process.cwd(), prompt, permissionProfile: "read-only" });

describe.each(factories)("%s adapter contract", (_name, factory) => {
  it("probes, starts, normalizes, resumes, sends, and cancels", async () => {
    const adapter = factory(); expect((await adapter.probe()).available).toBe(true); expect((await adapter.capabilities()).supportsResume).toBe(true);
    const events: string[] = []; const handle = await adapter.start(spec(), (event) => { events.push(event.type); });
    const delivery = await adapter.send(handle, { id: "m", from: "orchestrator", to: "worker", body: "note", createdAt: new Date().toISOString() });
    expect(delivery.accepted).toBe(true);
    const result = await handle.settled; expect(result.exitCode).toBe(0); expect(result.session?.id).toContain("session"); expect(result.finalMessage).toBe("done");
    expect(events).toContain("session.started"); expect(events).toContain("assistant.message");
    const resumed = await adapter.resume(result.session!, "continue", () => {}); expect((await resumed.settled).exitCode).toBe(0);
    const held = await adapter.start(spec("HOLD"), () => {}); await adapter.cancel(held, 0); expect((await held.settled).exitCode).not.toBe(0);
  }, 15_000);
});
