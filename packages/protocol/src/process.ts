import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { EventSink, FleetEvent, HarnessId, HarnessRunSpec, RunHandle, RunResult, SessionRef } from "./index.js";

export interface ProcessLaunch {
  command: string;
  args: string[];
  input?: string;
  closeInputAfterWrite?: boolean;
  env?: NodeJS.ProcessEnv;
  parse: (value: unknown, stream: "stdout" | "stderr") => Partial<FleetEvent> | undefined;
  sessionFrom?: (value: unknown) => string | undefined;
  finalFrom?: (value: unknown) => string | undefined;
}

export interface ManagedRun extends RunHandle { process: ChildProcessWithoutNullStreams }

function resolvedCommand(command: string): { command: string; prefix: string[] } {
  if (process.platform !== "win32" || extname(command)) return { command, prefix: [] };
  const directories = (process.env.PATH ?? "").split(delimiter);
  for (const extension of [".exe", ".com", ".cmd"]) for (const directory of directories) {
    if (directory.toLowerCase().endsWith(`\\${command}${extension}`) && existsSync(directory)) return { command: directory, prefix: [] };
    const candidate = join(directory, command + extension); if (!existsSync(candidate)) continue;
    if (extension !== ".cmd") return { command: candidate, prefix: [] };
    const script = readFileSync(candidate, "utf8").match(/"%dp0%\\([^"\r\n]+\.js)"/)?.[1];
    if (script) return { command: existsSync(join(dirname(candidate), "node.exe")) ? join(dirname(candidate), "node.exe") : process.execPath, prefix: [resolve(dirname(candidate), script)] };
  }
  return { command, prefix: [] };
}

function emitLine(spec: HarnessRunSpec, sink: EventSink, launch: ProcessLaunch, line: string, stream: "stdout" | "stderr"): { session?: string; final?: string } {
  let raw: unknown = line;
  try { raw = JSON.parse(line); } catch { /* process output is still preserved */ }
  const mapped = launch.parse(raw, stream) ?? { type: "process.output", payload: { stream, text: line } };
  void sink({ fleetId: spec.fleetId, nodeId: spec.nodeId, attemptId: spec.attemptId, at: new Date().toISOString(), raw, ...mapped } as FleetEvent);
  return { session: launch.sessionFrom?.(raw), final: launch.finalFrom?.(raw) };
}

export function launchProcess(harness: HarnessId, spec: HarnessRunSpec, sink: EventSink, launch: ProcessLaunch): ManagedRun {
  const executable = resolvedCommand(launch.command);
  const child = spawn(executable.command, [...executable.prefix, ...launch.args], {
    cwd: spec.cwd, env: { ...process.env, ...launch.env }, windowsHide: true,
    detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
  });
  const runId = randomUUID(); let sessionId: string | undefined; let finalMessage: string | undefined;
  let stdout = ""; let stderr = "";
  const consume = (stream: "stdout" | "stderr", chunk: Buffer) => {
    const current = (stream === "stdout" ? stdout : stderr) + chunk.toString("utf8");
    const lines = current.split("\n"); const rest = lines.pop() ?? "";
    if (stream === "stdout") stdout = rest; else stderr = rest;
    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line) continue;
      const found = emitLine(spec, sink, launch, line, stream);
      sessionId = found.session ?? sessionId; finalMessage = found.final ?? finalMessage;
    }
  };
  child.stdout.on("data", (x: Buffer) => consume("stdout", x));
  child.stderr.on("data", (x: Buffer) => consume("stderr", x));
  if (launch.input !== undefined) {
    if (launch.closeInputAfterWrite) child.stdin.end(launch.input);
    else child.stdin.write(launch.input);
  }
  const settled = new Promise<RunResult>((resolve) => {
    let spawnError: string | undefined;
    child.on("error", (error) => { spawnError = error.message; });
    child.on("close", (code) => {
      if (stdout) emitLine(spec, sink, launch, stdout, "stdout");
      if (stderr) emitLine(spec, sink, launch, stderr, "stderr");
      const session = sessionId ? { id: sessionId, harness, cwd: spec.cwd } satisfies SessionRef : undefined;
      void sink({ fleetId: spec.fleetId, nodeId: spec.nodeId, attemptId: spec.attemptId, type: code === 0 ? "session.settled" : "error", at: new Date().toISOString(), payload: { exitCode: code, error: spawnError } });
      resolve({ exitCode: code, session, finalMessage, error: spawnError ?? (code === 0 ? undefined : `${launch.command} exited with ${code}`) });
    });
  });
  return { id: runId, harness, pid: child.pid, settled, process: child };
}

export async function killProcessTree(child: ChildProcessWithoutNullStreams, graceMs: number): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T"], { windowsHide: true });
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, graceMs)));
    if (child.exitCode === null) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  try { process.kill(-child.pid, "SIGTERM"); } catch { return; }
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, graceMs)));
  if (child.exitCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } }
}

export function commandProbe(command: string, args = ["--version"]): { available: boolean; version?: string; detail?: string } {
  const executable = resolvedCommand(command);
  const result = spawnSync(executable.command, [...executable.prefix, ...args], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  return result.error
    ? { available: false, detail: result.error.message }
    : { available: result.status === 0, version: (result.stdout || result.stderr).trim().split(/\r?\n/)[0], detail: result.status === 0 ? undefined : result.stderr.trim() };
}
