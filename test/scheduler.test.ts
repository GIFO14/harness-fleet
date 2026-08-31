import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { FleetStore } from "@harness-fleet/storage";
import { FleetScheduler, parseFleetSpec } from "@harness-fleet/core";
import { FakeHarness } from "@harness-fleet/testing";

const dirs: string[] = [];
async function waitFor(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise((r) => setTimeout(r, 10)); } throw new Error("timed out"); }
afterEach(async () => { await Promise.all(dirs.splice(0).map((x) => rm(x, { recursive: true, force: true }))); });

describe("FleetScheduler", () => {
  it("requires confirmation and completes dependencies in DAG order", async () => {
    const dir = join(tmpdir(), `harness-fleet-scheduler-${randomUUID()}`); dirs.push(dir); await mkdir(dir);
    const store = new FleetStore(join(dir, "db.sqlite"));
    const spec = parseFleetSpec(`version: 1\nfleet_name: scheduler\ngoal: test\norchestrator: { harness: pi }\nworkers:\n  - { id: one, harness: pi, type: research, task: one }\n  - { id: two, harness: pi, type: research, task: two, depends_on: [one] }\n`);
    const fleet = store.createFleet(spec, dir); const fake = new FakeHarness([{ delayMs: 5 }, { delayMs: 5 }]);
    const scheduler = new FleetScheduler({ owner: "test", store, adapters: new Map([["pi", fake]]), workspace: async () => ({ cwd: dir }),
      bridge: async () => ({ command: "fake", args: [], env: {} }) });
    await scheduler.tick(fleet.id); expect(fake.starts).toHaveLength(0);
    await scheduler.confirmAndLaunch(fleet.id); await waitFor(() => store.getFleet(fleet.id)?.status === "completed");
    expect(fake.starts.map((x) => x.nodeId)).toEqual(["one", "two"]); expect(store.listAttempts(fleet.id)).toHaveLength(2); store.close();
  });
  it("retries with a new immutable attempt", async () => {
    const dir = join(tmpdir(), `harness-fleet-retry-${randomUUID()}`); dirs.push(dir); await mkdir(dir);
    const store = new FleetStore(join(dir, "db.sqlite"));
    const spec = parseFleetSpec(`version: 1\nfleet_name: retry\ngoal: test\norchestrator: { harness: pi }\nconfig: { max_attempts: 2 }\nworkers:\n  - { id: flaky, harness: pi, type: research, task: test }\n`);
    const fleet = store.createFleet(spec, dir); const fake = new FakeHarness([{ exitCode: 1 }, { exitCode: 0 }]);
    const scheduler = new FleetScheduler({ owner: "test", store, adapters: new Map([["pi", fake]]), workspace: async () => ({ cwd: dir }),
      bridge: async () => ({ command: "fake", args: [], env: {} }) });
    await scheduler.confirmAndLaunch(fleet.id); await waitFor(() => store.getFleet(fleet.id)?.status === "completed");
    const attempts = store.listAttempts(fleet.id); expect(attempts.map((x) => x.number)).toEqual([1, 2]); expect(attempts[0].artifactDir).not.toBe(attempts[1].artifactDir); store.close();
  });
  it("runs an iterate-to-LGTM reviewer loop without reusing attempts", async () => {
    const dir = join(tmpdir(), `harness-fleet-loop-${randomUUID()}`); dirs.push(dir); await mkdir(dir);
    const store = new FleetStore(join(dir, "db.sqlite"));
    const spec = parseFleetSpec(`version: 1\nfleet_name: loop\ngoal: test\norchestrator: { harness: pi }\nconfig:\n  loop: { gate: review, max_iterations: 3, lgtm_count: 1 }\nworkers:\n  - { id: code, harness: pi, type: code-run, task: code, worktree: false }\n  - { id: review, harness: pi, type: review, task: review, depends_on: [code], reviewer_for: [code] }\n`);
    const fleet = store.createFleet(spec, dir); const fake = new FakeHarness([
      { finalMessage: "implemented" }, { finalMessage: "iterate: fix tests" }, { finalMessage: "fixed" }, { finalMessage: "LGTM" },
    ]);
    const scheduler = new FleetScheduler({ owner: "test", store, adapters: new Map([["pi", fake]]), workspace: async () => ({ cwd: dir }),
      bridge: async () => ({ command: "fake", args: [], env: {} }) });
    await scheduler.confirmAndLaunch(fleet.id); await waitFor(() => store.getFleet(fleet.id)?.status === "completed");
    expect(store.listAttempts(fleet.id).map((x) => `${x.nodeId}:${x.number}`)).toEqual(["code:1", "code:2", "review:1", "review:2"]); store.close();
  });
});
