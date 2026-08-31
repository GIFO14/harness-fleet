import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@harness-fleet/protocol": `${root}packages/protocol/src/index.ts`,
      "@harness-fleet/core": `${root}packages/core/src/index.ts`,
      "@harness-fleet/storage": `${root}packages/storage/src/index.ts`,
      "@harness-fleet/git-workspaces": `${root}packages/git-workspaces/src/index.ts`,
      "@harness-fleet/testing": `${root}packages/testing/src/index.ts`,
    },
  },
  test: { include: ["test/**/*.test.ts", "packages/**/*.test.ts"] },
});
