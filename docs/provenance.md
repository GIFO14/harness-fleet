# Provenance

Harness Fleet began from the MIT-licensed
`pi-agent-fleet` v0.7.1 source at commit
`b4e732ad1884de9541693066145229537ff72572`, authored by Sagar Sarkale.
The exact imported snapshot is retained under
`upstream/pi-agent-fleet-v0.7.1/` for review.

The original copyright and MIT text remain in `LICENSE`; `NOTICE.md`
records the derivation.

## Material changes

- Removed Pi host-process and extension API dependencies from the core.
- Replaced the injected Pi spawn function with an explicit multi-harness
  adapter contract.
- Added a per-user Fastify daemon, SQLite WAL persistence, migrations,
  append-only events, leases, restart recovery, and capability tokens.
- Added standalone CLI and React DAG control panel.
- Added Pi RPC, Claude Code stream-json, and Codex JSONL adapters.
- Added MCP and Pi bridges with server-enforced worker/orchestrator authority.
- Made attempts and output freshness immutable, fixed branch naming and
  iterative worktrees, added process-tree hard kill and explicit unknown cost.
- Replaced shallow ad-hoc parsing with YAML and JSON Schema validation.

This repository has its own history and is not represented as an official
continuation or endorsement by the upstream author.
