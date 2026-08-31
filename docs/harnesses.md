# Harness adapters

Harness Fleet uses existing CLI authentication. It never reads, copies, or
stores the harness credential files.

## Pi

Command: `pi --mode rpc`.

The adapter disables extension discovery and loads only the packaged
`bridge-pi` extension. It configures a session directory, native model,
thinking level, and a tool allowlist. Read-only workers receive only read
operations. `workspace-write` does not receive Pi's unrestricted bash/edit/
write tools; it writes through capability-rooted bridge file tools instead.
`full-access` is the only profile that enables the unrestricted built-ins.
Messages use Pi steering at a safe turn boundary.
Sessions resume by exact Pi session ID.

## Claude Code

Command: `claude -p --input-format stream-json --output-format stream-json`.

A temporary strict MCP configuration contains only the Harness Fleet bridge.
The adapter passes the native model and effort and maps permissions to plan,
accepted edits, or—only after separate human authorization—the explicit
bypass mode. It captures session IDs, result messages, usage, cost, tool
events, and errors. Sessions resume with `--resume`.

## Codex

Command: `codex exec --json`.

The adapter sets the working directory, native model reasoning effort, and
`read-only` or `workspace-write` sandbox. `full-access` is translated to
the explicit dangerous bypass flag only after the daemon has verified the
human confirmation. MCP configuration is injected with per-run config
overrides. Sessions resume with `codex exec resume <thread-id>`.

Codex does not currently expose reliable incremental dollar cost through this
adapter, so its cost quality is `unavailable`, never zero.

## Contract and normalized events

All adapters implement `HarnessAdapter`: probe, capabilities, start, resume,
send, and cancel. They normalize session, turn, assistant, tool, usage,
process, approval, settlement, error, and exit events while retaining the
original payload in `raw`.

Cancellation targets the whole process tree. POSIX uses process-group TERM,
a grace period, then KILL. Windows uses `taskkill /T`, then `/F`.

Run `fleet doctor --json` to inspect installed versions and advertised
capabilities. Missing harnesses do not prevent fleets that do not use them.
