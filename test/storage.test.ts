import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { FleetStore } from "@harness-fleet/storage";
import { parseFleetSpec } from "@harness-fleet/core";

const dirs: string[] = [];
async function setup() {
  const dir = join(tmpdir(), `harness-fleet-store-${randomUUID()}`); dirs.push(dir); await mkdir(dir);
  return { dir, store: new FleetStore(join(dir, "fleet.db")) };
}
const spec = () => parseFleetSpec(`version: 1\nfleet_name: test\ngoal: test\norchestrator: { harness: codex }\nworkers:\n  - { id: worker, harness: pi, type: research, task: test }\n`);
afterEach(async () => { await Promise.all(dirs.splice(0).map((x) => rm(x, { recursive: true, force: true }))); });
describe("FleetStore", () => {
  it("uses immutable attempt directories and persists across reopen", async () => {
    const { dir, store } = await setup(); const fleet = store.createFleet(spec(), dir);
    const first = store.createAttempt(fleet, "worker", "pi"); store.finishAttempt(first.id, "failed");
    const second = store.createAttempt(fleet, "worker", "pi");
    expect(second.number).toBe(2); expect(second.artifactDir).not.toBe(first.artifactDir);
    store.close(); const reopened = new FleetStore(join(dir, "fleet.db"));
    expect(reopened.listAttempts(fleet.id)).toHaveLength(2); reopened.close();
  });
  it("grants only one scheduler lease", async () => {
    const { dir, store } = await setup(); const fleet = store.createFleet(spec(), dir);
    expect(store.acquireLease(fleet.id, "a")).toBe(true); expect(store.acquireLease(fleet.id, "b")).toBe(false);
    store.releaseLease(fleet.id, "a"); expect(store.acquireLease(fleet.id, "b")).toBe(true); store.close();
  });
  it("delivers messages at least once until acknowledged", async () => {
    const { dir, store } = await setup(); const fleet = store.createFleet(spec(), dir);
    const message = store.sendMessage({ fleetId: fleet.id, sender: "worker", recipient: "orchestrator", body: "done" });
    expect(store.inbox(fleet.id, "orchestrator")).toHaveLength(1); store.markMessage(message.id, "delivered");
    expect(store.inbox(fleet.id, "orchestrator")).toHaveLength(1); store.markMessage(message.id, "acknowledged");
    expect(store.inbox(fleet.id, "orchestrator")).toHaveLength(0); store.close();
  });
  it("consumes one-time web tokens once", async () => {
    const { store } = await setup(); const token = store.issueToken({ scope: "web-once", fleetId: "f" }, 1000, true);
    expect(store.consumeToken(token)?.scope).toBe("web-once"); expect(store.consumeToken(token)).toBeUndefined(); store.close();
  });
});
