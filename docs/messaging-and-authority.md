# Messaging and authority

There are no peer-to-peer agent connections. All messages enter an audited,
ordered SQLite inbox through the daemon.

Recipients are `orchestrator` or a worker ID. Delivery is at least once:
`pending → delivered → acknowledged`. Until acknowledgment, inbox reads may
return the same stable message ID. Unknown recipients return an explicit
error; a message never expands the receiver's capability.

Pi and Claude Code accept messages at safe turn boundaries. Codex messages
remain queued until the next `codex exec resume`.

## Authority

| Action | Human | Orchestrator | Worker |
|---|---:|---:|---:|
| Confirm launch | yes | no | no |
| Authorize full access | yes | no | no |
| Pause/resume/kill | yes | fleet-scoped | no |
| Add/edit/relaunch node | yes | pending/fleet-scoped | request only |
| Read all fleet state | yes | own fleet | own node/context |
| Send message | optional | yes | yes |
| Publish owned artifact | yes | yes | own attempt |

The orchestrator is resumed on meaningful worker messages, terminal node
events, contract failures, reviewer verdicts, cost warnings, approval blocks,
and scheduler attention states. Three failed resume attempts use 1, 2, and 4
second backoff. Active workers may finish, but no new node is dispatched; the
fleet becomes `paused_orchestrator_unavailable`.
