# Security and permissions

Harness Fleet assumes the local OS user is trusted and agent-generated input
is not. The API is loopback-only and is not designed to be exposed through a
proxy or LAN binding.

## Permission profiles

- `read-only`: no file-writing tool or writable sandbox.
- `workspace-write`: may modify only the assigned checkout/worktree under
  the harness sandbox and tool policy.
- `full-access`: uses the harness's unsandboxed/bypass mode. A separate human
  launch flag is required. A prompt, spec edit, message, or orchestrator tool
  cannot grant it.

Code workers default to isolated worktrees and `workspace-write`. Shared
checkout is explicit. Harness Fleet does not weaken a harness's own login,
enterprise policy, or native restrictions.

Pi has no native filesystem sandbox. For its `workspace-write` profile,
Harness Fleet therefore disables Pi's unrestricted bash/edit/write built-ins
and exposes capability-rooted read/list/write bridge operations. Unrestricted
Pi built-ins are available only under separately confirmed `full-access`.

## Capability model

- Admin: CLI and HttpOnly/SameSite web session; human controls and spec edits.
- Orchestrator: one fleet; normal planning and operational mutations, but no
  launch confirmation or privilege escalation.
- Worker: one fleet, node, and immutable attempt; status, inbox, messages,
  owned artifact publication, and node requests only.
- Web-once: 60-second, single-use token exchanged for a clean cookie URL.

Tokens are 256-bit random values. SQLite stores hashes, not bearer values.
Every bridge request rechecks scope. Worker-to-worker messages do not transfer
authority.

## Filesystem protections

Contract and artifact paths are resolved and rejected if they escape their
allowed root. Attempts receive new directories. Cleanup verifies that targets
remain under the fleet worktree directory; branches are never deleted.

## Threat model summary

Primary threats are prompt-injected privilege requests, loopback token theft,
path traversal, stale-output reuse, process-orphan escape, double scheduling,
malicious project instructions, and command argument injection. Controls
include capability scope, expiry, human gating, path checks, immutable
attempts, process-tree cancellation, daemon and scheduler locks, explicit
argument arrays, and harness-native sandboxes.

Residual risks:

- `workspace-write` agents can damage data inside their worktree.
- `full-access` deliberately removes important isolation.
- Another process running as the same OS user may be able to inspect local
  process state or user-owned files.
- A compromised harness CLI has the authority granted to that process.

See [SECURITY.md](../SECURITY.md) for disclosure and supported versions.
