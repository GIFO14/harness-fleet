# Security policy

## Supported versions

Until 1.0, only the latest released minor version receives security fixes.

## Reporting

Do not open a public issue for a vulnerability. Use GitHub private
vulnerability reporting once the repository is published, and include:
affected version, platform, prerequisites, reproduction, impact, and any
suggested remediation. Maintainers should acknowledge within 72 hours.

## Security properties

- The API remains loopback-only.
- Human launch and full-access confirmation cannot be delegated to prompts.
- Worker tokens cannot mutate other nodes or control the fleet.
- Artifact and cleanup paths cannot escape their owned roots.
- Attempts do not reuse earlier outputs.
- Cancellation terminates full process trees.
- Harness credentials are owned and read only by their native CLIs.

Out of scope: a fully compromised local OS user, a malicious harness binary,
and damage deliberately authorized through `full-access`.

See [docs/security-and-permissions.md](docs/security-and-permissions.md) for
the threat model and residual risks.
