# Harness Fleet

Harness Fleet is a local, standalone control plane for running one DAG of
coding agents across **Pi**, **Claude Code**, and **Codex**. No harness hosts
the others: a per-user daemon owns scheduling, durable state, messages,
permissions, attempts, and the web control panel.

> Status: pre-1.0. The schema and API are versioned, but may still change
> before the first stable release.

## Why

Agent fleets are useful when research, implementation, review, and integration
benefit from different models or harnesses. Harness Fleet makes that mixture
explicit while preserving a human launch gate and emergency controls.

- One mandatory, configurable orchestrator agent per fleet.
- A harness is required on every node: `pi`, `claude-code`, or `codex`.
- Immutable attempts, audited messages, SQLite WAL, and restart recovery.
- Worktrees by default for code-writing nodes.
- Capability-scoped MCP bridge for Claude Code and Codex; a minimal injected
  extension for Pi RPC mode.
- CLI and live DAG control panel. No editor or general-purpose terminal.

## Quickstart

Requirements: Node.js 22+, Git, and at least one authenticated harness CLI.

```bash
npm install -g github:GIFO14/harness-fleet

fleet doctor
fleet run "Research the auth flow, implement the fix, then review it" \
  --orchestrator codex
```

Or run it without a global installation:

```bash
npx github:GIFO14/harness-fleet doctor
npx github:GIFO14/harness-fleet run "Research, implement, and review the change" \
  --orchestrator codex
```

`fleet run` asks the orchestrator to design a DAG, prints a preview, and
waits for a human confirmation. To start from a reviewed spec:

```bash
fleet plan --file examples/three-harness-demo.yaml --repo /path/to/repo
fleet launch <fleet-id>
fleet open <fleet-id>
```

Both GitHub installation methods build and use the same `fleet` executable.
No npm registry publication is required.

## Example

```yaml
version: 1
fleet_name: auth-refactor
goal: Refactor and review the authentication boundary

orchestrator:
  harness: codex
  effort: high

config:
  max_concurrent: 3
  max_attempts: 3
  loop:
    gate: review
    max_iterations: 3
    lgtm_count: 1

workers:
  - id: research
    harness: pi
    type: research
    task: Map the current authentication flow.

  - id: implementation
    harness: claude-code
    type: code-run
    task: Implement the refactor using the research findings.
    depends_on: [research]

  - id: review
    harness: codex
    type: review
    task: Review the implementation. End with LGTM or iterate.
    depends_on: [implementation]
    reviewer_for: [implementation]
```

Safe defaults are applied: research is read-only; code runs use
`workspace-write` in a worktree. `full-access` requires a separate human
confirmation and cannot be granted by a prompt.

## CLI

```text
fleet run "<goal>" --orchestrator pi|claude-code|codex
fleet plan --file <spec>
fleet launch|status|pause|resume|continue|report <fleet-id>
fleet logs <fleet-id> [node]
fleet kill <fleet-id> [node-id|all] [--immediate]
fleet relaunch <fleet-id> <node-id>
fleet add|edit <fleet-id> --file <spec>
fleet open [fleet-id]
fleet doctor [--json]
fleet config list|set ...
fleet cleanup <fleet-id>
fleet daemon start|stop|status
```

## Documentation

- [Architecture](docs/architecture.md)
- [Fleet specification](docs/fleet-spec.md)
- [Harness adapters](docs/harnesses.md)
- [Permissions and security](docs/security-and-permissions.md)
- [Messaging and authority](docs/messaging-and-authority.md)
- [Lifecycle and state machines](docs/lifecycle.md)
- [Worktrees and integration](docs/worktrees.md)
- [REST, WebSocket, bridge tools, and OpenAPI](docs/api.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Upstream provenance](docs/provenance.md)

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the
[changelog](CHANGELOG.md) before contributing or reporting a vulnerability.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run check
```

Live harness smoke tests are intentionally opt-in: contributors should never
need credentials to run the normal suite.

## License and provenance

MIT. Harness Fleet is derived from `pi-agent-fleet` v0.7.1. The original
copyright is preserved in [LICENSE](LICENSE), with details in
[NOTICE.md](NOTICE.md) and [docs/provenance.md](docs/provenance.md).
