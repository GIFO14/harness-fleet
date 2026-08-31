# Worktrees and integration

Writing nodes use Git worktrees unless `shared_checkout: true` is explicit.
Every attempt gets both a unique checkout and branch:

```text
fleet/<fleet-slug>/<run-id>/<node-id>/attempt-<n>
```

This prevents a retry or reviewer iteration from overwriting an earlier
branch. Worktrees live below the fleet artifact directory and are assigned as
the harness working directory.

The integrator merges selected branches with `--no-ff`. It stops at the
first conflict and returns the merged set plus conflict details; it never
resets or discards user changes. Integration history is therefore auditable.

`fleet cleanup <fleet-id>` is explicit. It only removes registered paths
under that fleet's worktree root. Branches are preserved intentionally so a
human can inspect, merge, or delete them later with normal Git commands.

Before launching writing nodes, ensure the repository has at least one commit
and a clean enough base for the worktrees you want to create. Unrelated user
changes are not automatically reset or moved.
