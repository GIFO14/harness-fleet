# Contributing

Harness Fleet requires Node.js 22 and Git.

```bash
npm install
npm run check
```

Keep core packages independent of concrete harnesses. New adapters must pass
the shared adapter contract suite and preserve raw events. Do not add a
fallback that silently changes model, effort, sandbox, or cost quality.

Pull requests should include tests, user-facing documentation, and a changelog
entry when behavior changes. Normal tests must use fake CLIs and never require
credentials; live Pi, Claude Code, and Codex smoke tests are opt-in.

Security-sensitive changes should test capability scope, path traversal,
attempt freshness, process-tree termination, and crash recovery where
relevant. Run the Windows/macOS/Linux CI matrix before release.

By contributing, you agree that your contribution is licensed under MIT.
