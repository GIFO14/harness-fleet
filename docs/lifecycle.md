# Lifecycle and state machines

## Fleet

```mermaid
stateDiagram-v2
  [*] --> planning
  planning --> waiting_for_confirmation
  waiting_for_confirmation --> running: human confirms
  running --> paused
  paused --> running
  running --> paused_orchestrator_unavailable: 3 resume failures
  paused_orchestrator_unavailable --> running: human recovers orchestrator
  running --> needs_attention: no dispatchable path
  needs_attention --> running: edit/relaunch
  running --> completed
  running --> failed
  running --> cancelled: kill all
```

The scheduler never dispatches from `waiting_for_confirmation`. Pausing
prevents new dispatch but does not implicitly kill running agents. Kill all
terminates process trees and marks the fleet cancelled.

## Node and attempt

```mermaid
stateDiagram-v2
  [*] --> pending
  pending --> ready
  ready --> running
  running --> completed
  running --> failed
  running --> needs_attention
  running --> cancelled
  failed --> pending: retry/relaunch
  completed --> pending: reviewer iterate
```

Each transition into `running` creates a monotonically numbered attempt
record and a new directory. Attempts are immutable historical facts even when
the node is relaunched with another model or harness.

## Review loop

The configured gate emits `review.verdict`. `iterate` resets the selected
`reviewer_for` nodes (or direct dependencies) and the reviewer to pending,
while preserving their earlier attempts and branches. `LGTM` increments the
approval counter. The loop completes at `lgtm_count`; it moves to
`needs_attention` at `max_iterations` or on an unclear verdict.

## Restart

SQLite commits precede scheduling side effects where possible. At daemon
startup, running process IDs are reconciled. Unmanaged orphan trees are killed,
their attempts become retryable, completed nodes remain completed, and every
running fleet is ticked again under a fresh lease.
