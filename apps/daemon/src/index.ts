import { FleetStore } from "@harness-fleet/storage";
import { acquireDaemonLock, clearDescriptor, runtimePaths, writeDescriptor } from "./runtime.js";
import { createServer } from "./server.js";
import { writeFileSync } from "node:fs";

const release = acquireDaemonLock();
const store = new FleetStore(runtimePaths.db);
const provisional = writeDescriptor(0);
let app;
try {
  app = await createServer({ store, adminToken: provisional.token });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address(); if (!address || typeof address === "string") throw new Error("failed to bind daemon");
  writeFileSync(runtimePaths.descriptor, JSON.stringify({ ...provisional, port: address.port }, null, 2), { mode: 0o600 });
} catch (error) {
  store.close(); clearDescriptor(); release(); throw error;
}

const shutdown = async () => { await app.close(); store.close(); clearDescriptor(); release(); };
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
process.once("exit", () => { clearDescriptor(); release(); });
