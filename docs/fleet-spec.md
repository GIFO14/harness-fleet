# Fleet specification v1

Specifications may be YAML or JSON. YAML is parsed by `yaml`; JSON and the
resulting object are validated against the complete JSON Schema exported as
`FLEET_SCHEMA`.

## Top-level fields

| Field | Required | Meaning |
|---|---:|---|
| `version` | yes | Must be `1`. |
| `fleet_name` | yes | Human-readable, non-empty name. |
| `goal` | yes | Shared outcome. |
| `repository` | no | Informational repository value; CLI `--repo` selects the actual checkout. |
| `orchestrator` | yes | Harness, native model, effort, and permission profile. |
| `config` | no | Concurrency, budgets, retries, duration, and loop policy. |
| `workers` | yes | Between 1 and 32 worker nodes by default. |

Every orchestrator and worker requires one of `pi`, `claude-code`, or
`codex`. Model IDs are passed through unchanged to the selected harness.

Effort is one of `off|minimal|low|medium|high|xhigh|max`. A plan fails if
the adapter does not advertise that exact value. There is no silent fallback.

## Workers

```yaml
- id: implementation
  harness: claude-code
  model: optional-native-model-id
  effort: high
  type: code-run
  task: Implement the requested change.
  permission_profile: workspace-write
  worktree: true
  shared_checkout: false
  depends_on: [research]
  timeout_minutes: 30
  max_attempts: 3
  reviewer_for: []
  outputs:
    - path: src/auth.ts
      kind: file-exists
      required: true
```

IDs must match `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`. Dependencies must exist and
the graph must be acyclic. Code and integrator workers default to
`workspace-write` with a worktree. Research and review default to
`read-only`. `shared_checkout: true` explicitly disables the worktree.

## Output contracts

Supported kinds:

- `file-exists`: regular file exists.
- `markdown`: non-empty text.
- `json`: parses as JSON.
- `yaml`: parses as YAML.
- `json-schema`: JSON passes the inline `schema`.
- `regex`: text matches `pattern`.

Paths may not escape the validation root. Required outputs must have a
modification timestamp from the current attempt; a stale file cannot satisfy
a retry.

## Limits and loops

```yaml
config:
  max_concurrent: 4
  max_workers: 32
  warn_cost_usd: 10
  max_cost_usd: 20
  max_duration_minutes: 120
  max_attempts: 3
  loop:
    gate: reviewer
    max_iterations: 4
    lgtm_count: 1
```

A hard cost cap is accepted only if every active adapter reports reliable
incremental cost. Otherwise use duration, attempt, or native harness limits.
A reviewer must end with an explicit `LGTM` or `iterate`; unclear verdicts
move the node to `needs_attention`.
