import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "apps/cli/src/index.ts",
    daemon: "apps/daemon/src/index.ts",
    "bridge-mcp": "packages/bridge-mcp/src/index.ts",
    "bridge-pi": "packages/bridge-pi/src/index.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  bundle: true,
  sourcemap: true,
  clean: true,
  external: ["better-sqlite3"],
  banner: { js: "#!/usr/bin/env node" },
});
