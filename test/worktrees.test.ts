import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { WorktreeManager, branchName } from "@harness-fleet/git-workspaces";
const exec = promisify(execFile); const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((x) => rm(x, { recursive: true, force: true }))));
describe("git workspaces", () => {
  it("creates a unique branch per attempt and preserves it during cleanup", async () => {
    const repo = join(tmpdir(), `harness-fleet-git-${randomUUID()}`); dirs.push(repo); await mkdir(repo);
    await exec("git", ["init", "-b", "main"], { cwd: repo }); await exec("git", ["config", "user.email", "fleet@example.invalid"], { cwd: repo });
    await exec("git", ["config", "user.name", "Harness Fleet Test"], { cwd: repo }); await writeFile(join(repo, "README.md"), "test");
    await exec("git", ["add", "README.md"], { cwd: repo }); await exec("git", ["commit", "-m", "initial"], { cwd: repo });
    const manager = new WorktreeManager(repo, join(repo, ".fleet", "id")); const created = await manager.create("Demo Fleet", "run-1", "worker", 2);
    expect(created.branch).toBe(branchName("Demo Fleet", "run-1", "worker", 2));
    await manager.cleanupWorktree(created.path);
    const branches = (await exec("git", ["branch", "--list", created.branch], { cwd: repo })).stdout;
    expect(branches).toContain(created.branch);
  });
});
