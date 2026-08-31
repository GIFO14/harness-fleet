#!/usr/bin/env node

// apps/daemon/src/runtime.ts
import envPaths from "env-paths";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
var runtimePaths = (() => {
  const paths = envPaths("harness-fleet");
  mkdirSync(paths.data, { recursive: true });
  mkdirSync(paths.temp, { recursive: true });
  return { dataDir: paths.data, tempDir: paths.temp, db: join(paths.data, "fleet.db"), descriptor: join(paths.data, "daemon.json"), lock: join(paths.data, "daemon.lock") };
})();
function readDescriptor() {
  try {
    const value = JSON.parse(readFileSync(runtimePaths.descriptor, "utf8"));
    process.kill(value.pid, 0);
    return value;
  } catch {
    return void 0;
  }
}
function acquireDaemonLock() {
  if (existsSync(runtimePaths.lock)) {
    const current = readDescriptor();
    if (current) throw new Error(`Harness Fleet daemon is already running (PID ${current.pid})`);
    try {
      unlinkSync(runtimePaths.lock);
    } catch {
    }
  }
  let fd;
  try {
    fd = openSync(runtimePaths.lock, "wx", 384);
  } catch {
    throw new Error("another Harness Fleet daemon is starting");
  }
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  return () => {
    try {
      unlinkSync(runtimePaths.lock);
    } catch {
    }
  };
}
function writeDescriptor(port) {
  const value = { pid: process.pid, port, token: randomBytes(32).toString("base64url"), startedAt: (/* @__PURE__ */ new Date()).toISOString() };
  writeFileSync(runtimePaths.descriptor, JSON.stringify(value, null, 2), { mode: 384 });
  return value;
}
function clearDescriptor() {
  try {
    unlinkSync(runtimePaths.descriptor);
  } catch {
  }
}

export {
  runtimePaths,
  readDescriptor,
  acquireDaemonLock,
  writeDescriptor,
  clearDescriptor
};
//# sourceMappingURL=chunk-4EZ5LDRD.js.map