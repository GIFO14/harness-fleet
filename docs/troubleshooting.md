# Troubleshooting

Start with:

```bash
fleet doctor --json
fleet daemon status
fleet logs <fleet-id>
```

## Harness is missing

Install its CLI, authenticate using that CLI, and make sure its executable is
on `PATH`. Harness Fleet supports Windows npm `.cmd` shims without enabling
a shell. Claude Code may legitimately be absent if the fleet does not use it.

## Daemon will not start

Check the descriptor shown by `fleet daemon status`. A stale lock is removed
only when its PID cannot be reached. If the process exists, stop it with
`fleet daemon stop`; do not run two daemons for the same user data directory.

## Fleet waits for confirmation

This is expected after `fleet plan` or a declined `fleet run` preview:

```bash
fleet launch <fleet-id>
```

Add `--full-access-confirm` only after inspecting every full-access node.

## Orchestrator unavailable

Active workers may finish, but dispatch is paused. Inspect its events and CLI
authentication, then restore the harness and run `fleet resume <fleet-id>`.
Changing orchestrator harness/model is intentionally a human operation.

## Worktree creation fails

Confirm the path is a Git repository with an initial commit. Inspect existing
worktrees with `git worktree list`. Harness Fleet never removes branches
automatically; use `fleet cleanup` for its checkouts.

## Contracts fail after a retry

Outputs must be modified during the current attempt. Copying an old artifact
without updating it is deliberately rejected. Inspect the attempt directory
and `contract.failed` event details.

## Cost shows unavailable

Unavailable means the harness did not report reliable dollar cost. It is not
zero. Hard cost caps cannot be used for a fleet containing such an adapter;
use duration, attempts, or native provider limits.
