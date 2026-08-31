import envPaths from "env-paths";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface DaemonDescriptor { pid: number; port: number; token: string; startedAt: string }
export const runtimePaths = (() => {
  const paths = envPaths("harness-fleet");
  mkdirSync(paths.data, { recursive: true }); mkdirSync(paths.temp, { recursive: true });
  return { dataDir: paths.data, tempDir: paths.temp, db: join(paths.data, "fleet.db"), descriptor: join(paths.data, "daemon.json"), lock: join(paths.data, "daemon.lock") };
})();

export function readDescriptor(): DaemonDescriptor | undefined {
  try {
    const value = JSON.parse(readFileSync(runtimePaths.descriptor, "utf8")) as DaemonDescriptor;
    process.kill(value.pid, 0); return value;
  } catch { return undefined; }
}

export function acquireDaemonLock(): () => void {
  if (existsSync(runtimePaths.lock)) {
    const current = readDescriptor();
    if (current) throw new Error(`Harness Fleet daemon is already running (PID ${current.pid})`);
    try { unlinkSync(runtimePaths.lock); } catch { /* another process won the race */ }
  }
  let fd: number;
  try { fd = openSync(runtimePaths.lock, "wx", 0o600); }
  catch { throw new Error("another Harness Fleet daemon is starting"); }
  writeFileSync(fd, String(process.pid)); closeSync(fd);
  return () => { try { unlinkSync(runtimePaths.lock); } catch { /* already removed */ } };
}

export function writeDescriptor(port: number): DaemonDescriptor {
  const value = { pid: process.pid, port, token: randomBytes(32).toString("base64url"), startedAt: new Date().toISOString() };
  writeFileSync(runtimePaths.descriptor, JSON.stringify(value, null, 2), { mode: 0o600 }); return value;
}

export function clearDescriptor(): void { try { unlinkSync(runtimePaths.descriptor); } catch { /* already gone */ } }
