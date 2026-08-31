#!/usr/bin/env node
import {
  readDescriptor
} from "./chunk-4EZ5LDRD.js";

// apps/cli/src/index.ts
import { Command } from "commander";
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline/promises";
import { stdin, stdout } from "process";
import { parse as parseYaml } from "yaml";
var moduleDir = dirname(fileURLToPath(import.meta.url));
var root = existsSync(join(moduleDir, "..", "package.json")) ? resolve(moduleDir, "..") : resolve(moduleDir, "../../..");
async function healthy(client) {
  try {
    return (await fetch(`${client.url}/api/v1/health`, { signal: AbortSignal.timeout(1e3) })).ok;
  } catch {
    return false;
  }
}
async function ensureDaemon() {
  const current = readDescriptor();
  if (current) {
    const client = { url: `http://127.0.0.1:${current.port}`, token: current.token };
    if (await healthy(client)) return client;
  }
  const built = join(root, "dist", "daemon.js");
  if (!existsSync(built)) throw new Error("Daemon build not found. Run `npm run build` once before using the development CLI.");
  const child = spawn(process.execPath, [built], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  for (let i = 0; i < 150; i++) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    const descriptor = readDescriptor();
    if (descriptor) {
      const client = { url: `http://127.0.0.1:${descriptor.port}`, token: descriptor.token };
      if (await healthy(client)) return client;
    }
  }
  throw new Error("Harness Fleet daemon did not start");
}
async function api(path, init) {
  const client = await ensureDaemon();
  const response = await fetch(`${client.url}/api/v1${path}`, { ...init, headers: { authorization: `Bearer ${client.token}`, "content-type": "application/json", ...init?.headers } });
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  if (!response.ok) throw new Error(value?.error ?? String(value));
  return value;
}
var jsonBody = (value) => ({ method: "POST", body: JSON.stringify(value) });
var print = (value) => {
  stdout.write(typeof value === "string" ? value + (value.endsWith("\n") ? "" : "\n") : JSON.stringify(value, null, 2) + "\n");
};
var readStructured = (path) => {
  const text = readFileSync(resolve(path), "utf8");
  return path.toLowerCase().endsWith(".json") ? JSON.parse(text) : parseYaml(text);
};
async function confirm(question) {
  if (!stdin.isTTY) return false;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return ["y", "yes"].includes((await rl.question(`${question} [y/N] `)).trim().toLowerCase());
  } finally {
    rl.close();
  }
}
function showPreview(value) {
  const preview = value.preview ?? value;
  print(`
Fleet: ${preview.name}
Goal: ${preview.goal}
Orchestrator: ${preview.orchestrator.harness}`);
  print("\nWorkers:");
  for (const w of preview.workers ?? []) print(`  ${w.id.padEnd(20)} ${String(w.harness).padEnd(13)} ${String(w.permission).padEnd(16)} worktree=${w.worktree ? "yes" : "no"} deps=${(w.dependsOn ?? []).join(",") || "\u2014"}`);
  if (preview.warnings?.length) {
    print("\nWarnings:");
    for (const warning of preview.warnings) print(`  ! ${warning}`);
  }
}
var program = new Command().name("fleet").description("Standalone multi-harness agent fleet orchestrator").version("0.1.0");
program.command("run").argument("<goal>").requiredOption("--orchestrator <harness>", "pi, claude-code, or codex").option("--model <id>").option("--effort <level>").option("--repo <path>", "repository", process.cwd()).option("-y, --yes", "confirm launch").option("--full-access-confirm", "separately authorize any full-access agents").action(async (goal, options) => {
  await api("/doctor");
  const result = await api("/fleets/design", jsonBody({ goal, orchestrator: options.orchestrator, model: options.model, effort: options.effort, repoPath: resolve(options.repo) }));
  showPreview(result);
  const accepted = options.yes || await confirm("Launch this fleet?");
  if (!accepted) {
    print(`Fleet ${result.fleet.id} saved in waiting_for_confirmation.`);
    return;
  }
  await api(`/fleets/${result.fleet.id}/launch`, jsonBody({ confirm: true, fullAccessConfirm: options.fullAccessConfirm === true }));
  print(`Fleet ${result.fleet.id} launched.`);
});
program.command("plan").requiredOption("--file <path>").option("--repo <path>", "repository", process.cwd()).action(async (options) => {
  const result = await api("/fleets", jsonBody({ spec: readFileSync(resolve(options.file), "utf8"), format: options.file.endsWith(".json") ? "json" : "yaml", repoPath: resolve(options.repo) }));
  const full = await api(`/fleets/${result.id}`);
  showPreview({
    name: full.spec.fleet_name,
    goal: full.spec.goal,
    orchestrator: full.spec.orchestrator,
    workers: full.spec.workers.map((x) => ({ id: x.id, harness: x.harness, permission: x.permission_profile, worktree: x.worktree, dependsOn: x.depends_on }))
  });
  print(`Saved as ${result.id}; run fleet launch ${result.id}`);
});
program.command("launch").argument("<fleet-id>").option("--full-access-confirm", "separately authorize full access").option("-y, --yes").action(async (id, options) => {
  const ok = options.yes || await confirm(`Launch fleet ${id}?`);
  if (!ok) return;
  await api(`/fleets/${id}/launch`, jsonBody({ confirm: true, fullAccessConfirm: options.fullAccessConfirm === true }));
  print("Launched.");
});
program.command("list").action(async () => print(await api("/fleets")));
program.command("status").argument("<fleet-id>").action(async (id) => print(await api(`/fleets/${id}`)));
program.command("logs").argument("<fleet-id>").argument("[node]").option("--after <id>", "event id", "0").action(async (id, node, options) => {
  const events = await api(`/fleets/${id}/events?after=${options.after}`);
  print(node ? events.filter((x) => x.nodeId === node) : events);
});
program.command("open").argument("[fleet-id]").action(async (id) => {
  const fleets = id ? void 0 : await api("/fleets");
  const fleetId = id ?? fleets[0]?.id;
  if (!fleetId) throw new Error("no fleets found");
  const { token } = await api(`/fleets/${fleetId}/open-token`, jsonBody({}));
  const client = await ensureDaemon();
  const url = `${client.url}/api/v1/web/exchange?token=${encodeURIComponent(token)}`;
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  print(url);
});
for (const name of ["pause", "resume", "continue"]) program.command(name).argument("<fleet-id>").action(async (id) => {
  await api(`/fleets/${id}/${name === "continue" ? "resume" : name}`, jsonBody({}));
  print("OK");
});
program.command("kill").argument("<fleet-id>").argument("[target]", "node id or all", "all").option("--immediate").action(async (id, target, options) => {
  await api(`/fleets/${id}/kill`, jsonBody({ nodeId: target === "all" ? void 0 : target, graceMs: options.immediate ? 0 : 5e3 }));
  print("Kill requested.");
});
program.command("relaunch").argument("<fleet-id>").argument("<node-id>").option("--harness <harness>").option("--model <model>").action(async (id, node, options) => {
  await api(`/fleets/${id}/relaunch/${node}`, jsonBody({ harness: options.harness, model: options.model }));
  print("Relaunched.");
});
program.command("replay").argument("<fleet-id>").argument("<node-id>").description("Replay a node as a fresh immutable attempt").action(async (id, node) => {
  await api(`/fleets/${id}/relaunch/${node}`, jsonBody({}));
  print("Replay launched as a new attempt.");
});
program.command("run-once").requiredOption("--file <worker-spec>").requiredOption("--orchestrator <harness>").option("--repo <path>", "repository", process.cwd()).option("-y, --yes").option("--full-access-confirm").action(async (options) => {
  const worker = readStructured(options.file);
  const spec = { version: 1, fleet_name: `run-once-${worker.id}`, goal: worker.task, orchestrator: { harness: options.orchestrator }, workers: [worker] };
  const fleet = await api("/fleets", jsonBody({ spec, repoPath: resolve(options.repo) }));
  const ok = options.yes || await confirm(`Launch one-off fleet ${fleet.id}?`);
  if (ok) await api(`/fleets/${fleet.id}/launch`, jsonBody({ confirm: true, fullAccessConfirm: options.fullAccessConfirm === true }));
  print(fleet);
});
program.command("orchestrator").argument("<fleet-id>").requiredOption("--harness <harness>").option("--model <model>").option("--effort <effort>").action(async (id, options) => {
  await api(`/fleets/${id}/orchestrator`, { method: "PUT", body: JSON.stringify({ harness: options.harness, model: options.model, effort: options.effort }) });
  print("Replacement orchestrator is ready; resume the fleet when desired.");
});
program.command("add").argument("<fleet-id>").requiredOption("--file <worker-spec>").option("--full-access-confirm").action(async (id, options) => {
  const fleet = await api(`/fleets/${id}`);
  fleet.spec.workers.push(readStructured(options.file));
  await api(`/fleets/${id}`, { method: "PUT", body: JSON.stringify({ spec: fleet.spec, fullAccessConfirm: options.fullAccessConfirm === true }) });
  print("Worker added.");
});
program.command("edit").argument("<fleet-id>").requiredOption("--file <spec>").option("--full-access-confirm").action(async (id, options) => {
  await api(`/fleets/${id}`, { method: "PUT", body: JSON.stringify({ spec: readStructured(options.file), fullAccessConfirm: options.fullAccessConfirm === true }) });
  print("Fleet updated.");
});
program.command("report").argument("<fleet-id>").action(async (id) => print(await api(`/fleets/${id}/report`)));
program.command("doctor").option("--json").action(async (options) => {
  const value = await api("/doctor");
  options.json ? print(value) : value.harnesses.forEach((x) => print(`${x.id.padEnd(13)} ${x.probe.available ? "available" : "missing"} ${x.probe.version ?? x.probe.detail ?? ""}`));
});
var config = program.command("config");
config.command("list").action(async () => print(await api("/config")));
config.command("set").argument("<key>").argument("<value>").action(async (key, value) => {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = value;
  }
  await api("/config", jsonBody({ key, value: parsed }));
  print("Saved.");
});
var daemon = program.command("daemon");
daemon.command("start").action(async () => {
  const client = await ensureDaemon();
  print({ running: true, url: client.url });
});
daemon.command("status").action(async () => {
  const descriptor = readDescriptor();
  print(descriptor ? { running: await healthy({ url: `http://127.0.0.1:${descriptor.port}`, token: descriptor.token }), pid: descriptor.pid, port: descriptor.port, startedAt: descriptor.startedAt } : { running: false });
});
daemon.command("stop").action(async () => {
  await api("/shutdown", jsonBody({}));
  print("Stopping.");
});
program.command("cleanup").argument("<fleet-id>").action(async (id) => {
  await api(`/fleets/${id}/cleanup`, jsonBody({}));
  print("Worktrees removed; branches preserved.");
});
program.parseAsync().catch((error) => {
  process.stderr.write(`fleet: ${error instanceof Error ? error.message : String(error)}
`);
  process.exitCode = 1;
});
//# sourceMappingURL=cli.js.map