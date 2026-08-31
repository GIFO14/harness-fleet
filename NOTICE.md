# Notices

Harness Fleet is a new standalone work derived from
[pi-agent-fleet](https://github.com/sagarsrc/pi-agent-fleet) v0.7.1
(base commit `b4e732ad1884de9541693066145229537ff72572`).

The upstream work is Copyright © 2026 Sagar Sarkale and is used under the MIT
License included in this repository. Harness Fleet preserves that notice and
documents its architectural and behavioral changes in
[`docs/provenance.md`](docs/provenance.md).

The principal changes are: extraction from the Pi host process, a persistent
local daemon, SQLite-backed state, explicit harness adapters, capability-scoped
bridges, a standalone CLI, and support for Pi, Claude Code, and Codex in the
same fleet.
