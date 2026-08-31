import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { FleetStore } from "@harness-fleet/storage";
import { createServer } from "../apps/daemon/src/server.js";
import { parseFleetSpec } from "@harness-fleet/core";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((x) => rm(x, { recursive: true, force: true }))));
describe("local API authority", () => {
  it("separates human confirmation from worker capability", async () => {
    const dir = join(tmpdir(), `harness-fleet-api-${randomUUID()}`); dirs.push(dir); await mkdir(dir);
    const store = new FleetStore(join(dir, "db.sqlite")); const app = await createServer({ store, adminToken: "admin" });
    const unauthorized = await app.inject({ method: "GET", url: "/api/v1/fleets" }); expect(unauthorized.statusCode).toBe(401);
    const spec = parseFleetSpec(`version: 1\nfleet_name: api\ngoal: test\norchestrator: { harness: pi }\nworkers:\n  - { id: worker, harness: pi, type: research, task: test }\n`);
    const fleet = store.createFleet(spec, dir);
    const blocked = await app.inject({ method: "POST", url: `/api/v1/fleets/${fleet.id}/launch`, headers: { authorization: "Bearer admin" }, payload: { confirm: false } });
    expect(blocked.statusCode).toBe(409); expect(store.getFleet(fleet.id)?.status).toBe("waiting_for_confirmation");
    const workerToken = store.issueToken({ scope: "worker", fleetId: fleet.id, nodeId: "worker", attemptId: "a" }, 60_000);
    const escalation = await app.inject({ method: "POST", url: "/api/v1/bridge/orchestrator/control", headers: { authorization: `Bearer ${workerToken}` }, payload: { action: "kill" } });
    expect(escalation.statusCode).toBe(403);
    const attempt = store.createAttempt(fleet, "worker", "pi"); const scopedToken = store.issueToken({ scope: "worker", fleetId: fleet.id, nodeId: "worker", attemptId: attempt.id }, 60_000);
    const traversal = await app.inject({ method: "GET", url: "/api/v1/bridge/files?path=../secret", headers: { authorization: `Bearer ${scopedToken}` } }); expect(traversal.statusCode).toBe(400);
    const readonlyWrite = await app.inject({ method: "POST", url: "/api/v1/bridge/files", headers: { authorization: `Bearer ${scopedToken}` }, payload: { path: "inside.txt", content: "no" } }); expect(readonlyWrite.statusCode).toBe(403);
    const privileged = structuredClone(spec); privileged.workers[0].permission_profile = "full-access";
    const ungatedEdit = await app.inject({ method: "PUT", url: `/api/v1/fleets/${fleet.id}`, headers: { authorization: "Bearer admin" }, payload: { spec: privileged } });
    expect(ungatedEdit.statusCode).toBe(409);
    const orchestratorToken = store.issueToken({ scope: "orchestrator", fleetId: fleet.id }, 60_000);
    const orchestratorEscalation = await app.inject({ method: "POST", url: "/api/v1/bridge/orchestrator/nodes", headers: { authorization: `Bearer ${orchestratorToken}` },
      payload: { id: "unsafe", harness: "pi", type: "code-run", task: "unsafe", permission_profile: "full-access" } });
    expect(orchestratorEscalation.statusCode).toBe(403); await app.close(); store.close();
  });
});
