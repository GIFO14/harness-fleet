import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export function slug(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "fleet";
}

export function branchName(fleetName: string, runId: string, nodeId: string, attempt: number): string {
  return `fleet/${slug(fleetName)}/${slug(runId)}/${slug(nodeId)}/attempt-${attempt}`;
}

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", repo, ...args], { windowsHide: true }); return stdout.trim();
}

export async function assertGitRepository(repo: string): Promise<void> {
  const top = await git(repo, ["rev-parse", "--show-toplevel"]);
  if (!top) throw new Error(`${repo} is not a git repository`);
}

export class WorktreeManager {
  constructor(private readonly repo: string, private readonly fleetDir: string) {}

  async create(fleetName: string, runId: string, nodeId: string, attempt: number): Promise<{ path: string; branch: string }> {
    await assertGitRepository(this.repo);
    const excludeValue = await git(this.repo, ["rev-parse", "--git-path", "info/exclude"]); const excludePath = isAbsolute(excludeValue) ? excludeValue : resolve(this.repo, excludeValue);
    const exclude = await readFile(excludePath, "utf8").catch(() => ""); if (!exclude.split(/\r?\n/).includes(".fleet/")) await appendFile(excludePath, `${exclude.endsWith("\n") || !exclude ? "" : "\n"}.fleet/\n`);
    const branch = branchName(fleetName, runId, nodeId, attempt);
    const path = join(this.fleetDir, "worktrees", slug(nodeId), `attempt-${attempt}`);
    await mkdir(dirname(path), { recursive: true });
    await git(this.repo, ["worktree", "add", "-b", branch, path, "HEAD"]);
    return { path, branch };
  }

  async integrate(branches: string[], targetBranch?: string): Promise<{ merged: string[]; conflict?: string }> {
    if (targetBranch) await git(this.repo, ["switch", targetBranch]);
    const merged: string[] = [];
    for (const branch of branches) {
      try { await git(this.repo, ["merge", "--no-ff", "--no-edit", branch]); merged.push(branch); }
      catch (error) { return { merged, conflict: error instanceof Error ? error.message : String(error) }; }
    }
    return { merged };
  }

  async cleanupWorktree(path: string): Promise<void> {
    const rel = relative(resolve(this.fleetDir, "worktrees"), resolve(path));
    if (isAbsolute(rel) || rel.startsWith("..")) throw new Error("refusing to remove a path outside this fleet's worktrees");
    await git(this.repo, ["worktree", "remove", "--force", path]);
    await rm(path, { recursive: true, force: true });
  }
}
