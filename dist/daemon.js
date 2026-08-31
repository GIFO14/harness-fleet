#!/usr/bin/env node
import {
  acquireDaemonLock,
  clearDescriptor,
  runtimePaths,
  writeDescriptor
} from "./chunk-M2HTSGR5.js";

// packages/storage/src/index.ts
import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
var MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS fleets(
     id TEXT PRIMARY KEY, run_id TEXT NOT NULL, spec_json TEXT NOT NULL, repo_path TEXT NOT NULL,
     status TEXT NOT NULL, confirmed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
     lease_owner TEXT, lease_until INTEGER
   );
   CREATE TABLE IF NOT EXISTS nodes(
     fleet_id TEXT NOT NULL, node_id TEXT NOT NULL, spec_json TEXT NOT NULL, status TEXT NOT NULL,
     current_attempt INTEGER NOT NULL DEFAULT 0, iteration INTEGER NOT NULL DEFAULT 0,
     lgtm_count INTEGER NOT NULL DEFAULT 0, last_error TEXT,
     PRIMARY KEY(fleet_id,node_id), FOREIGN KEY(fleet_id) REFERENCES fleets(id)
   );
   CREATE TABLE IF NOT EXISTS attempts(
     id TEXT PRIMARY KEY, fleet_id TEXT NOT NULL, node_id TEXT NOT NULL, number INTEGER NOT NULL,
     harness TEXT NOT NULL, status TEXT NOT NULL, session_id TEXT, pid INTEGER, artifact_dir TEXT NOT NULL,
     branch TEXT, started_at TEXT, finished_at TEXT, exit_code INTEGER, error TEXT, cost_usd REAL,
     cost_quality TEXT NOT NULL DEFAULT 'unavailable', UNIQUE(fleet_id,node_id,number)
   );
   CREATE TABLE IF NOT EXISTS events(
     id INTEGER PRIMARY KEY AUTOINCREMENT, fleet_id TEXT NOT NULL, node_id TEXT, attempt_id TEXT,
     type TEXT NOT NULL, at TEXT NOT NULL, payload_json TEXT NOT NULL, raw_json TEXT
   );
   CREATE INDEX IF NOT EXISTS events_fleet_idx ON events(fleet_id,id);
   CREATE TABLE IF NOT EXISTS messages(
     id TEXT PRIMARY KEY, fleet_id TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL,
     body TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, delivered_at TEXT, acknowledged_at TEXT
   );
   CREATE INDEX IF NOT EXISTS messages_inbox_idx ON messages(fleet_id,recipient,status,created_at);
   CREATE TABLE IF NOT EXISTS capability_tokens(
     token_hash TEXT PRIMARY KEY, scope TEXT NOT NULL, fleet_id TEXT, node_id TEXT, attempt_id TEXT,
     expires_at INTEGER NOT NULL, one_time INTEGER NOT NULL DEFAULT 0, consumed_at INTEGER
   );
   CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value_json TEXT NOT NULL);`,
  `CREATE TABLE IF NOT EXISTS orchestrators(
     fleet_id TEXT PRIMARY KEY, harness TEXT NOT NULL, model TEXT, effort TEXT, permission_profile TEXT NOT NULL,
     session_id TEXT, status TEXT NOT NULL, failure_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
     FOREIGN KEY(fleet_id) REFERENCES fleets(id)
   );`,
  `ALTER TABLE fleets ADD COLUMN full_access_confirmed INTEGER NOT NULL DEFAULT 0;`
];
var FleetStore = class {
  constructor(path) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }
  path;
  db;
  migrate() {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const applied = new Set(this.db.prepare("SELECT version FROM schema_migrations").all().map((x) => x.version));
    MIGRATIONS.forEach((sql, index) => {
      const version = index + 1;
      if (applied.has(version)) return;
      this.db.transaction(() => {
        this.db.exec(sql);
        this.db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)").run(version, (/* @__PURE__ */ new Date()).toISOString());
      })();
    });
  }
  close() {
    this.db.close();
  }
  createFleet(spec, repoPath, id = randomUUID()) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const runId = randomUUID().slice(0, 8);
    const record = { id, runId, spec, repoPath: resolve(repoPath), status: "waiting_for_confirmation", createdAt: now, updatedAt: now };
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO fleets(id,run_id,spec_json,repo_path,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, runId, JSON.stringify(spec), record.repoPath, record.status, now, now);
      const insert = this.db.prepare("INSERT INTO nodes(fleet_id,node_id,spec_json,status) VALUES (?,?,?,'pending')");
      for (const worker of spec.workers) insert.run(id, worker.id, JSON.stringify(worker));
      this.db.prepare("INSERT INTO orchestrators(fleet_id,harness,model,effort,permission_profile,status,updated_at) VALUES (?,?,?,?,?,'ready',?)").run(id, spec.orchestrator.harness, spec.orchestrator.model ?? null, spec.orchestrator.effort ?? null, spec.orchestrator.permission_profile ?? "workspace-write", now);
    })();
    mkdirSync(this.fleetArtifactDir(record), { recursive: true });
    writeFileSync(join(this.fleetArtifactDir(record), "fleet.json"), JSON.stringify(spec, null, 2));
    return record;
  }
  getFleet(id) {
    const row = this.db.prepare("SELECT * FROM fleets WHERE id=?").get(id);
    return row ? this.mapFleet(row) : void 0;
  }
  listFleets() {
    return this.db.prepare("SELECT * FROM fleets ORDER BY created_at DESC").all().map((x) => this.mapFleet(x));
  }
  setFleetStatus(id, status, confirm = false) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.db.prepare("UPDATE fleets SET status=?, confirmed_at=CASE WHEN ? THEN ? ELSE confirmed_at END, updated_at=? WHERE id=?").run(status, confirm ? 1 : 0, now, now, id);
  }
  setFullAccessConfirmed(id, confirmed) {
    this.db.prepare("UPDATE fleets SET full_access_confirmed=?,updated_at=? WHERE id=?").run(confirmed ? 1 : 0, (/* @__PURE__ */ new Date()).toISOString(), id);
  }
  updateSpec(id, spec) {
    this.db.prepare("UPDATE fleets SET spec_json=?,updated_at=? WHERE id=?").run(JSON.stringify(spec), (/* @__PURE__ */ new Date()).toISOString(), id);
  }
  setOrchestratorSession(fleetId, sessionId, status, failureCount = 0) {
    this.db.prepare("UPDATE orchestrators SET session_id=?,status=?,failure_count=?,updated_at=? WHERE fleet_id=?").run(sessionId ?? null, status, failureCount, (/* @__PURE__ */ new Date()).toISOString(), fleetId);
  }
  replaceOrchestrator(fleetId, value) {
    this.db.prepare("UPDATE orchestrators SET harness=?,model=?,effort=?,permission_profile=?,session_id=NULL,status='starting',failure_count=0,updated_at=? WHERE fleet_id=?").run(value.harness, value.model ?? null, value.effort ?? null, value.permissionProfile, (/* @__PURE__ */ new Date()).toISOString(), fleetId);
  }
  getOrchestrator(fleetId) {
    const r = this.db.prepare("SELECT * FROM orchestrators WHERE fleet_id=?").get(fleetId);
    return r ? {
      harness: r.harness,
      model: r.model ?? void 0,
      effort: r.effort ?? void 0,
      permissionProfile: r.permission_profile,
      sessionId: r.session_id ?? void 0,
      status: r.status,
      failureCount: r.failure_count
    } : void 0;
  }
  listNodes(fleetId) {
    return this.db.prepare("SELECT * FROM nodes WHERE fleet_id=? ORDER BY rowid").all(fleetId).map((r) => ({
      fleetId: r.fleet_id,
      nodeId: r.node_id,
      spec: JSON.parse(r.spec_json),
      status: r.status,
      currentAttempt: r.current_attempt,
      iteration: r.iteration,
      lgtmCount: r.lgtm_count,
      lastError: r.last_error ?? void 0
    }));
  }
  setNodeStatus(fleetId, nodeId, status, error) {
    this.db.prepare("UPDATE nodes SET status=?,last_error=? WHERE fleet_id=? AND node_id=?").run(status, error ?? null, fleetId, nodeId);
  }
  updateReviewState(fleetId, nodeId, values) {
    this.db.prepare(`UPDATE nodes SET iteration=iteration+?,lgtm_count=CASE WHEN ? THEN 0 ELSE lgtm_count+? END WHERE fleet_id=? AND node_id=?`).run(values.iterationDelta ?? 0, values.resetLgtm ? 1 : 0, values.lgtmDelta ?? 0, fleetId, nodeId);
    const row = this.db.prepare("SELECT iteration,lgtm_count FROM nodes WHERE fleet_id=? AND node_id=?").get(fleetId, nodeId);
    return { iteration: row.iteration, lgtmCount: row.lgtm_count };
  }
  addNode(fleetId, spec) {
    this.db.prepare("INSERT INTO nodes(fleet_id,node_id,spec_json,status) VALUES (?,?,?,'pending')").run(fleetId, spec.id, JSON.stringify(spec));
  }
  updateNode(fleetId, nodeId, spec) {
    const row = this.db.prepare("SELECT status FROM nodes WHERE fleet_id=? AND node_id=?").get(fleetId, nodeId);
    if (!row || !["pending", "ready", "failed", "needs_attention"].includes(row.status)) throw new Error("only non-running nodes may be edited");
    this.db.prepare("UPDATE nodes SET spec_json=? WHERE fleet_id=? AND node_id=?").run(JSON.stringify(spec), fleetId, nodeId);
  }
  createAttempt(fleet, nodeId, harness, branch) {
    return this.db.transaction(() => {
      const node = this.db.prepare("SELECT current_attempt FROM nodes WHERE fleet_id=? AND node_id=?").get(fleet.id, nodeId);
      if (!node) throw new Error(`unknown node ${nodeId}`);
      const number = Number(node.current_attempt) + 1;
      const id = randomUUID();
      const artifactDir = join(this.fleetArtifactDir(fleet), "workers", nodeId, "attempts", String(number));
      mkdirSync(dirname(artifactDir), { recursive: true });
      mkdirSync(artifactDir, { recursive: false });
      this.db.prepare("UPDATE nodes SET current_attempt=?,status='running' WHERE fleet_id=? AND node_id=?").run(number, fleet.id, nodeId);
      this.db.prepare("INSERT INTO attempts(id,fleet_id,node_id,number,harness,status,artifact_dir,branch) VALUES (?,?,?,?,?,'running',?,?)").run(id, fleet.id, nodeId, number, harness, artifactDir, branch ?? null);
      return { id, fleetId: fleet.id, nodeId, number, harness, status: "running", artifactDir, branch, costQuality: "unavailable" };
    })();
  }
  startAttempt(id, sessionId, pid) {
    this.db.prepare("UPDATE attempts SET session_id=COALESCE(?,session_id),pid=COALESCE(?,pid),started_at=COALESCE(started_at,?) WHERE id=?").run(sessionId ?? null, pid ?? null, (/* @__PURE__ */ new Date()).toISOString(), id);
  }
  setAttemptSession(id, sessionId) {
    this.db.prepare("UPDATE attempts SET session_id=? WHERE id=?").run(sessionId, id);
  }
  finishAttempt(id, status, result = {}) {
    this.db.transaction(() => {
      const attempt = this.db.prepare("SELECT fleet_id,node_id FROM attempts WHERE id=?").get(id);
      if (!attempt) return;
      this.db.prepare("UPDATE attempts SET status=?,finished_at=?,exit_code=?,error=?,cost_usd=COALESCE(?,cost_usd),cost_quality=COALESCE(?,cost_quality) WHERE id=?").run(status, (/* @__PURE__ */ new Date()).toISOString(), result.exitCode ?? null, result.error ?? null, result.costUsd ?? null, result.costQuality ?? null, id);
      this.setNodeStatus(attempt.fleet_id, attempt.node_id, status, result.error);
    })();
  }
  updateAttemptCost(id, costUsd, quality) {
    this.db.prepare("UPDATE attempts SET cost_usd=?,cost_quality=? WHERE id=?").run(costUsd, quality, id);
  }
  listAttempts(fleetId, nodeId) {
    const rows = nodeId ? this.db.prepare("SELECT * FROM attempts WHERE fleet_id=? AND node_id=? ORDER BY number").all(fleetId, nodeId) : this.db.prepare("SELECT * FROM attempts WHERE fleet_id=? ORDER BY node_id,number").all(fleetId);
    return rows.map((r) => ({
      id: r.id,
      fleetId: r.fleet_id,
      nodeId: r.node_id,
      number: r.number,
      harness: r.harness,
      status: r.status,
      sessionId: r.session_id ?? void 0,
      pid: r.pid ?? void 0,
      artifactDir: r.artifact_dir,
      branch: r.branch ?? void 0,
      startedAt: r.started_at ?? void 0,
      finishedAt: r.finished_at ?? void 0,
      exitCode: r.exit_code ?? void 0,
      error: r.error ?? void 0,
      costUsd: r.cost_usd ?? void 0,
      costQuality: r.cost_quality
    }));
  }
  appendEvent(event) {
    const result = this.db.prepare("INSERT INTO events(fleet_id,node_id,attempt_id,type,at,payload_json,raw_json) VALUES (?,?,?,?,?,?,?)").run(event.fleetId, event.nodeId ?? null, event.attemptId ?? null, event.type, event.at, JSON.stringify(event.payload), event.raw === void 0 ? null : JSON.stringify(event.raw));
    return Number(result.lastInsertRowid);
  }
  listEvents(fleetId, after = 0, limit = 1e3) {
    return this.db.prepare("SELECT * FROM events WHERE fleet_id=? AND id>? ORDER BY id LIMIT ?").all(fleetId, after, limit).map((r) => ({
      id: r.id,
      fleetId: r.fleet_id,
      nodeId: r.node_id ?? void 0,
      attemptId: r.attempt_id ?? void 0,
      type: r.type,
      at: r.at,
      payload: JSON.parse(r.payload_json),
      raw: r.raw_json ? JSON.parse(r.raw_json) : void 0
    }));
  }
  sendMessage(message) {
    const value = { ...message, id: randomUUID(), status: "pending", createdAt: (/* @__PURE__ */ new Date()).toISOString() };
    this.db.prepare("INSERT INTO messages(id,fleet_id,sender,recipient,body,status,created_at) VALUES (?,?,?,?,?,?,?)").run(value.id, value.fleetId, value.sender, value.recipient, value.body, value.status, value.createdAt);
    return value;
  }
  inbox(fleetId, recipient) {
    return this.db.prepare("SELECT * FROM messages WHERE fleet_id=? AND recipient=? AND status IN ('pending','delivered') ORDER BY created_at,id").all(fleetId, recipient).map((r) => this.mapMessage(r));
  }
  listMessages(fleetId) {
    return this.db.prepare("SELECT * FROM messages WHERE fleet_id=? ORDER BY created_at,id").all(fleetId).map((r) => this.mapMessage(r));
  }
  markMessage(id, status) {
    const column = status === "delivered" ? "delivered_at" : status === "acknowledged" ? "acknowledged_at" : void 0;
    if (column) this.db.prepare(`UPDATE messages SET status=?,${column}=? WHERE id=?`).run(status, (/* @__PURE__ */ new Date()).toISOString(), id);
    else this.db.prepare("UPDATE messages SET status=? WHERE id=?").run(status, id);
  }
  issueToken(capability, ttlMs, oneTime = false) {
    const token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token).digest("hex");
    this.db.prepare("INSERT INTO capability_tokens(token_hash,scope,fleet_id,node_id,attempt_id,expires_at,one_time) VALUES (?,?,?,?,?,?,?)").run(hash, capability.scope, capability.fleetId ?? null, capability.nodeId ?? null, capability.attemptId ?? null, Date.now() + ttlMs, oneTime ? 1 : 0);
    return token;
  }
  consumeToken(token) {
    const hash = createHash("sha256").update(token).digest("hex");
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM capability_tokens WHERE token_hash=?").get(hash);
      if (!row || row.expires_at < Date.now() || row.one_time && row.consumed_at) return void 0;
      if (row.one_time) this.db.prepare("UPDATE capability_tokens SET consumed_at=? WHERE token_hash=?").run(Date.now(), hash);
      return { scope: row.scope, fleetId: row.fleet_id ?? void 0, nodeId: row.node_id ?? void 0, attemptId: row.attempt_id ?? void 0 };
    })();
  }
  acquireLease(fleetId, owner, ttlMs = 15e3) {
    const now = Date.now();
    const result = this.db.prepare("UPDATE fleets SET lease_owner=?,lease_until=? WHERE id=? AND (lease_owner IS NULL OR lease_owner=? OR lease_until<?)").run(owner, now + ttlMs, fleetId, owner, now);
    return result.changes === 1;
  }
  releaseLease(fleetId, owner) {
    this.db.prepare("UPDATE fleets SET lease_owner=NULL,lease_until=NULL WHERE id=? AND lease_owner=?").run(fleetId, owner);
  }
  getSettings() {
    return Object.fromEntries(this.db.prepare("SELECT key,value_json FROM settings ORDER BY key").all().map((r) => [r.key, JSON.parse(r.value_json)]));
  }
  setSetting(key, value) {
    this.db.prepare("INSERT INTO settings(key,value_json) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json").run(key, JSON.stringify(value));
  }
  recoverRunning() {
    return this.db.prepare("SELECT id,fleet_id,node_id,pid FROM attempts WHERE status='running'").all().map((r) => ({ fleetId: r.fleet_id, nodeId: r.node_id, attemptId: r.id, pid: r.pid ?? void 0 }));
  }
  fleetArtifactDir(fleet) {
    return join(fleet.repoPath, ".fleet", fleet.id);
  }
  mapFleet(r) {
    return {
      id: r.id,
      runId: r.run_id,
      spec: JSON.parse(r.spec_json),
      repoPath: r.repo_path,
      status: r.status,
      confirmedAt: r.confirmed_at ?? void 0,
      fullAccessConfirmed: Boolean(r.full_access_confirmed),
      createdAt: r.created_at,
      updatedAt: r.updated_at
    };
  }
  mapMessage(r) {
    return {
      id: r.id,
      fleetId: r.fleet_id,
      sender: r.sender,
      recipient: r.recipient,
      body: r.body,
      status: r.status,
      createdAt: r.created_at,
      deliveredAt: r.delivered_at ?? void 0,
      acknowledgedAt: r.acknowledged_at ?? void 0
    };
  }
};

// apps/daemon/src/server.ts
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cookie from "@fastify/cookie";
import staticPlugin from "@fastify/static";
import { existsSync as existsSync3, readFileSync as readFileSync3, mkdirSync as mkdirSync3, writeFileSync as writeFileSync3, readdirSync, statSync, realpathSync } from "fs";
import { join as join6, dirname as dirname4, resolve as resolve5, relative as relative3, isAbsolute as isAbsolute3 } from "path";
import { fileURLToPath } from "url";
import { randomUUID as randomUUID3 } from "crypto";
import { spawnSync as spawnSync2 } from "child_process";

// packages/core/src/spec.ts
import Ajv2020 from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";

// packages/protocol/src/process.ts
import { spawn, spawnSync } from "child_process";
import { randomUUID as randomUUID2 } from "crypto";
import { delimiter, dirname as dirname2, extname, join as join2, resolve as resolve2 } from "path";
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "fs";
function resolvedCommand(command) {
  if (process.platform !== "win32" || extname(command)) return { command, prefix: [] };
  const directories = (process.env.PATH ?? "").split(delimiter);
  for (const extension of [".exe", ".com", ".cmd"]) for (const directory of directories) {
    if (directory.toLowerCase().endsWith(`\\${command}${extension}`) && existsSync2(directory)) return { command: directory, prefix: [] };
    const candidate = join2(directory, command + extension);
    if (!existsSync2(candidate)) continue;
    if (extension !== ".cmd") return { command: candidate, prefix: [] };
    const script = readFileSync2(candidate, "utf8").match(/"%dp0%\\([^"\r\n]+\.js)"/)?.[1];
    if (script) return { command: existsSync2(join2(dirname2(candidate), "node.exe")) ? join2(dirname2(candidate), "node.exe") : process.execPath, prefix: [resolve2(dirname2(candidate), script)] };
  }
  return { command, prefix: [] };
}
function emitLine(spec, sink, launch, line, stream) {
  let raw = line;
  try {
    raw = JSON.parse(line);
  } catch {
  }
  const mapped = launch.parse(raw, stream) ?? { type: "process.output", payload: { stream, text: line } };
  void sink({ fleetId: spec.fleetId, nodeId: spec.nodeId, attemptId: spec.attemptId, at: (/* @__PURE__ */ new Date()).toISOString(), raw, ...mapped });
  return { session: launch.sessionFrom?.(raw), final: launch.finalFrom?.(raw) };
}
function launchProcess(harness, spec, sink, launch) {
  const executable = resolvedCommand(launch.command);
  const child = spawn(executable.command, [...executable.prefix, ...launch.args], {
    cwd: spec.cwd,
    env: { ...process.env, ...launch.env },
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"]
  });
  const runId = randomUUID2();
  let sessionId;
  let finalMessage;
  let stdout = "";
  let stderr = "";
  const consume = (stream, chunk) => {
    const current = (stream === "stdout" ? stdout : stderr) + chunk.toString("utf8");
    const lines = current.split("\n");
    const rest = lines.pop() ?? "";
    if (stream === "stdout") stdout = rest;
    else stderr = rest;
    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line) continue;
      const found = emitLine(spec, sink, launch, line, stream);
      sessionId = found.session ?? sessionId;
      finalMessage = found.final ?? finalMessage;
    }
  };
  child.stdout.on("data", (x) => consume("stdout", x));
  child.stderr.on("data", (x) => consume("stderr", x));
  if (launch.input !== void 0) {
    if (launch.closeInputAfterWrite) child.stdin.end(launch.input);
    else child.stdin.write(launch.input);
  }
  const settled = new Promise((resolve6) => {
    let spawnError;
    child.on("error", (error) => {
      spawnError = error.message;
    });
    child.on("close", (code) => {
      if (stdout) emitLine(spec, sink, launch, stdout, "stdout");
      if (stderr) emitLine(spec, sink, launch, stderr, "stderr");
      const session = sessionId ? { id: sessionId, harness, cwd: spec.cwd } : void 0;
      void sink({ fleetId: spec.fleetId, nodeId: spec.nodeId, attemptId: spec.attemptId, type: code === 0 ? "session.settled" : "error", at: (/* @__PURE__ */ new Date()).toISOString(), payload: { exitCode: code, error: spawnError } });
      resolve6({ exitCode: code, session, finalMessage, error: spawnError ?? (code === 0 ? void 0 : `${launch.command} exited with ${code}`) });
    });
  });
  return { id: runId, harness, pid: child.pid, settled, process: child };
}
async function killProcessTree(child, graceMs) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T"], { windowsHide: true });
    await new Promise((resolve6) => setTimeout(resolve6, Math.max(0, graceMs)));
    if (child.exitCode === null) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }
  await new Promise((resolve6) => setTimeout(resolve6, Math.max(0, graceMs)));
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
    }
  }
}
function commandProbe(command, args = ["--version"]) {
  const executable = resolvedCommand(command);
  const result = spawnSync(executable.command, [...executable.prefix, ...args], { encoding: "utf8", windowsHide: true, timeout: 3e4 });
  return result.error ? { available: false, detail: result.error.message } : { available: result.status === 0, version: (result.stdout || result.stderr).trim().split(/\r?\n/)[0], detail: result.status === 0 ? void 0 : result.stderr.trim() };
}

// packages/protocol/src/index.ts
var HARNESS_IDS = ["pi", "claude-code", "codex"];
var EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
var FLEET_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["version", "fleet_name", "goal", "orchestrator", "workers"],
  properties: {
    version: { const: 1 },
    fleet_name: { type: "string", minLength: 1 },
    goal: { type: "string", minLength: 1 },
    repository: { type: "string" },
    orchestrator: { $ref: "#/$defs/agent" },
    config: {
      type: "object",
      additionalProperties: false,
      properties: {
        max_concurrent: { type: "integer", minimum: 1, maximum: 32, default: 4 },
        max_workers: { type: "integer", minimum: 1, maximum: 32, default: 32 },
        warn_cost_usd: { type: "number", minimum: 0 },
        max_cost_usd: { type: "number", exclusiveMinimum: 0 },
        max_duration_minutes: { type: "integer", minimum: 1 },
        max_attempts: { type: "integer", minimum: 1, maximum: 20, default: 3 },
        loop: {
          type: "object",
          additionalProperties: false,
          required: ["gate"],
          properties: {
            gate: { type: "string", minLength: 1 },
            max_iterations: { type: "integer", minimum: 1, default: 4 },
            lgtm_count: { type: "integer", minimum: 1, default: 1 }
          }
        }
      }
    },
    workers: { type: "array", minItems: 1, maxItems: 32, items: { $ref: "#/$defs/worker" } }
  },
  $defs: {
    harness: { enum: HARNESS_IDS },
    effort: { enum: EFFORTS },
    permission: { enum: ["read-only", "workspace-write", "full-access"] },
    agent: {
      type: "object",
      additionalProperties: false,
      required: ["harness"],
      properties: {
        harness: { $ref: "#/$defs/harness" },
        model: { type: "string" },
        effort: { $ref: "#/$defs/effort" },
        permission_profile: { $ref: "#/$defs/permission" }
      }
    },
    output: {
      type: "object",
      additionalProperties: false,
      required: ["path", "kind"],
      properties: {
        path: { type: "string", minLength: 1 },
        kind: { enum: ["file-exists", "markdown", "json", "yaml", "json-schema", "regex"] },
        required: { type: "boolean" },
        schema: { type: "object" },
        pattern: { type: "string" }
      }
    },
    worker: {
      type: "object",
      additionalProperties: false,
      required: ["id", "harness", "type", "task"],
      properties: {
        id: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]*$" },
        harness: { $ref: "#/$defs/harness" },
        type: { enum: ["research", "code-run", "review", "integrator", "custom"] },
        task: { type: "string", minLength: 1 },
        model: { type: "string" },
        effort: { $ref: "#/$defs/effort" },
        permission_profile: { $ref: "#/$defs/permission" },
        worktree: { type: "boolean" },
        shared_checkout: { type: "boolean" },
        depends_on: { type: "array", uniqueItems: true, items: { type: "string" } },
        outputs: { type: "array", items: { $ref: "#/$defs/output" } },
        timeout_minutes: { type: "integer", minimum: 1 },
        max_attempts: { type: "integer", minimum: 1, maximum: 20 },
        reviewer_for: { type: "array", uniqueItems: true, items: { type: "string" } }
      }
    }
  }
};

// packages/core/src/spec.ts
var ajv = new Ajv2020({ allErrors: true, useDefaults: true });
var validateSchema = ajv.compile(FLEET_SCHEMA);
var FleetValidationError = class extends Error {
  constructor(issues) {
    super(`Invalid fleet specification:
${issues.map((x) => `- ${x}`).join("\n")}`);
    this.issues = issues;
  }
  issues;
};
function parseFleetSpec(source, format) {
  let value;
  try {
    value = format === "json" ? JSON.parse(source) : parseYaml(source);
  } catch (error) {
    throw new FleetValidationError([`parse error: ${error instanceof Error ? error.message : String(error)}`]);
  }
  if (!validateSchema(value)) {
    throw new FleetValidationError((validateSchema.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`));
  }
  return applyDefaults(value);
}
function applyDefaults(spec) {
  const clone = structuredClone(spec);
  clone.config = {
    max_concurrent: 4,
    max_workers: 32,
    max_attempts: 3,
    ...clone.config,
    loop: clone.config?.loop ? { max_iterations: 4, lgtm_count: 1, ...clone.config.loop } : void 0
  };
  clone.orchestrator.permission_profile ??= "workspace-write";
  for (const worker of clone.workers) {
    worker.depends_on ??= [];
    worker.outputs ??= [];
    worker.permission_profile ??= worker.type === "code-run" || worker.type === "integrator" ? "workspace-write" : "read-only";
    if (worker.worktree === void 0) worker.worktree = worker.permission_profile === "workspace-write";
    if (worker.shared_checkout) worker.worktree = false;
    worker.max_attempts ??= clone.config.max_attempts;
  }
  validateGraph(clone);
  return clone;
}
function validateGraph(spec) {
  const issues = [];
  const ids = /* @__PURE__ */ new Set();
  for (const worker of spec.workers) {
    if (ids.has(worker.id)) issues.push(`duplicate worker id '${worker.id}'`);
    ids.add(worker.id);
  }
  if (spec.workers.length > (spec.config?.max_workers ?? 32)) issues.push("worker count exceeds max_workers");
  for (const worker of spec.workers) {
    for (const dep of worker.depends_on ?? []) {
      if (!ids.has(dep)) issues.push(`worker '${worker.id}' depends on unknown worker '${dep}'`);
      if (dep === worker.id) issues.push(`worker '${worker.id}' depends on itself`);
    }
    if (worker.permission_profile === "full-access") issues.push(`worker '${worker.id}' requires explicit full-access confirmation`);
  }
  if (spec.config?.loop?.gate && !ids.has(spec.config.loop.gate)) issues.push(`loop gate '${spec.config.loop.gate}' does not exist`);
  const visiting = /* @__PURE__ */ new Set();
  const visited = /* @__PURE__ */ new Set();
  const byId = new Map(spec.workers.map((x) => [x.id, x]));
  const visit = (id, trail) => {
    if (visiting.has(id)) {
      issues.push(`dependency cycle: ${[...trail, id].join(" -> ")}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id)?.depends_on ?? []) visit(dep, [...trail, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const worker of spec.workers) visit(worker.id, []);
  const fatal = issues.filter((x) => !x.includes("requires explicit full-access"));
  if (fatal.length) throw new FleetValidationError(issues);
}
async function validateCapabilities(spec, capabilities) {
  const issues = [];
  for (const agent of [{ id: "orchestrator", ...spec.orchestrator }, ...spec.workers]) {
    if (!agent.effort) continue;
    if (!EFFORTS.includes(agent.effort)) continue;
    const caps = await capabilities(agent.harness);
    if (!caps.efforts.includes(agent.effort)) issues.push(`${agent.id}: ${agent.harness} does not support effort '${agent.effort}'`);
    if (agent.permission_profile && !caps.permissionProfiles.includes(agent.permission_profile)) {
      issues.push(`${agent.id}: ${agent.harness} does not support permission '${agent.permission_profile}'`);
    }
  }
  if (spec.config?.max_cost_usd) {
    const harnesses = /* @__PURE__ */ new Set([spec.orchestrator.harness, ...spec.workers.map((x) => x.harness)]);
    for (const harness of harnesses) {
      if (!(await capabilities(harness)).supportsReliableIncrementalCost) {
        issues.push(`hard max_cost_usd requires reliable incremental cost, unavailable for ${harness}`);
      }
    }
  }
  if (issues.length) throw new FleetValidationError(issues);
}

// packages/core/src/contracts.ts
import { readFile, realpath, stat } from "fs/promises";
import { resolve as resolve3, relative, isAbsolute } from "path";
import Ajv20202 from "ajv/dist/2020.js";
import { parse as parseYaml2 } from "yaml";
function safePath(root, path) {
  const target = resolve3(root, path);
  const rel = relative(resolve3(root), target);
  if (isAbsolute(rel) || rel.startsWith("..")) throw new Error(`contract path escapes attempt: ${path}`);
  return target;
}
async function validateContracts(root, contracts, attemptStartedAt, fallbackRoots = []) {
  const results = [];
  for (const contract of contracts) {
    let lastError;
    let satisfied = false;
    for (const candidateRoot of [root, ...fallbackRoots]) try {
      const target = safePath(candidateRoot, contract.path);
      const info = await stat(target);
      const [actualRoot, actualTarget] = await Promise.all([realpath(candidateRoot), realpath(target)]);
      const actualRel = relative(actualRoot, actualTarget);
      if (isAbsolute(actualRel) || actualRel.startsWith("..")) throw new Error(`contract symlink escapes attempt: ${contract.path}`);
      if (!info.isFile()) throw new Error("not a regular file");
      if (info.mtimeMs + 1 < attemptStartedAt) throw new Error("artifact predates this attempt");
      const text = contract.kind === "file-exists" ? "" : await readFile(target, "utf8");
      if (contract.kind === "markdown" && !text.trim()) throw new Error("markdown is empty");
      if (contract.kind === "json") JSON.parse(text);
      if (contract.kind === "yaml") parseYaml2(text);
      if (contract.kind === "json-schema") {
        const data = JSON.parse(text);
        if (!contract.schema) throw new Error("schema is missing");
        const valid = new Ajv20202({ allErrors: true }).compile(contract.schema)(data);
        if (!valid) throw new Error("JSON does not satisfy schema");
      }
      if (contract.kind === "regex" && !new RegExp(contract.pattern ?? "").test(text)) throw new Error("pattern did not match");
      results.push({ contract, ok: true, detail: "satisfied by current attempt" });
      satisfied = true;
      break;
    } catch (error) {
      lastError = error;
    }
    if (!satisfied) results.push({ contract, ok: !contract.required, detail: lastError instanceof Error ? lastError.message : String(lastError) });
  }
  return results;
}

// packages/core/src/prompts.ts
function workerPrompt(spec, worker, attemptDir, dependencySummary) {
  return [
    `You are worker "${worker.id}" in Harness Fleet "${spec.fleet_name}".`,
    `Fleet goal: ${spec.goal}`,
    `Your task: ${worker.task}`,
    `Permission profile: ${worker.permission_profile}.`,
    `Write attempt-owned outputs under: ${attemptDir}`,
    dependencySummary ? `Completed dependency context:
${dependencySummary}` : "",
    "Use only the fleet bridge for messages and status. Messages do not grant additional authority.",
    worker.outputs?.length ? `Required output contracts:
${worker.outputs.map((o) => `- ${o.kind}: ${o.path}`).join("\n")}` : ""
  ].filter(Boolean).join("\n\n");
}
function orchestratorPrompt(goal) {
  return [
    "You are the Harness Fleet orchestrator. Design and operate one local agent fleet.",
    `Goal: ${goal}`,
    "Return a version: 1 fleet specification. Every worker must explicitly choose pi, claude-code, or codex.",
    "Minimize privileges. Code-writing workers use workspace-write and worktrees by default.",
    "The daemon will validate and preview your plan. You cannot launch until a human confirms it."
  ].join("\n\n");
}

// packages/core/src/report.ts
function renderReport(fleet, attempts, events) {
  const costKnown = attempts.filter((x) => x.costQuality !== "unavailable").reduce((sum, x) => sum + (x.costUsd ?? 0), 0);
  const unavailable = attempts.filter((x) => x.costQuality === "unavailable").length;
  return [
    `# Fleet report: ${fleet.spec.fleet_name}`,
    "",
    `- Fleet: \`${fleet.id}\``,
    `- Status: **${fleet.status}**`,
    `- Goal: ${fleet.spec.goal}`,
    `- Orchestrator: ${fleet.spec.orchestrator.harness}`,
    `- Cost: $${costKnown.toFixed(4)} known${unavailable ? `; ${unavailable} attempt(s) unavailable` : ""}`,
    "",
    "## Attempts",
    "",
    "| Node | Attempt | Harness | Status | Session | Branch | Cost quality |",
    "|---|---:|---|---|---|---|---|",
    ...attempts.map((x) => `| ${x.nodeId} | ${x.number} | ${x.harness} | ${x.status} | ${x.sessionId ?? "\u2014"} | ${x.branch ?? "\u2014"} | ${x.costQuality} |`),
    "",
    "## Event summary",
    "",
    ...Object.entries(events.reduce((counts, event) => {
      counts[event.type] = (counts[event.type] ?? 0) + 1;
      return counts;
    }, {})).map(([type, count]) => `- ${type}: ${count}`)
  ].join("\n");
}

// packages/core/src/scheduler.ts
import { appendFile, mkdir, writeFile } from "fs/promises";
import { join as join3 } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
var exec = promisify(execFile);
var FleetScheduler = class {
  constructor(options) {
    this.options = options;
  }
  options;
  active = /* @__PURE__ */ new Map();
  timers = /* @__PURE__ */ new Map();
  costs = /* @__PURE__ */ new Map();
  attemptCosts = /* @__PURE__ */ new Map();
  costWarned = /* @__PURE__ */ new Set();
  async confirmAndLaunch(fleetId, allowFullAccess = false) {
    const fleet = this.requireFleet(fleetId);
    if (fleet.status !== "waiting_for_confirmation") throw new Error(`fleet cannot launch from ${fleet.status}`);
    if (!allowFullAccess && [fleet.spec.orchestrator, ...fleet.spec.workers].some((x) => x.permission_profile === "full-access")) {
      throw new Error("full-access requires an explicit, separate confirmation");
    }
    if (allowFullAccess) this.options.store.setFullAccessConfirmed(fleetId, true);
    this.options.store.setFleetStatus(fleetId, "running", true);
    await this.tick(fleetId);
  }
  async tick(fleetId) {
    const fleet = this.requireFleet(fleetId);
    if (fleet.status !== "running" && fleet.status !== "waiting_for_confirmation") return;
    if (fleet.status === "running" && fleet.spec.config?.max_duration_minutes && Date.now() - Date.parse(fleet.confirmedAt ?? fleet.createdAt) > fleet.spec.config.max_duration_minutes * 6e4) {
      await this.kill(fleetId, void 0, 0);
      this.options.store.setFleetStatus(fleetId, "failed");
      await this.event(fleetId, void 0, void 0, "error", { reason: "fleet timeout exceeded" });
      return;
    }
    if (!this.options.store.acquireLease(fleetId, this.options.owner)) return;
    try {
      const fresh = this.requireFleet(fleetId);
      if (fresh.status !== "running") return;
      if (this.options.canDispatch && !this.options.canDispatch(fresh)) return;
      const nodes = this.options.store.listNodes(fleetId);
      const completed = new Set(nodes.filter((x) => x.status === "completed").map((x) => x.nodeId));
      const running = nodes.filter((x) => x.status === "running").length;
      const available = Math.max(0, (fresh.spec.config?.max_concurrent ?? 4) - running);
      const ready = nodes.filter((x) => (x.status === "pending" || x.status === "ready") && (x.spec.depends_on ?? []).every((d) => completed.has(d))).slice(0, available);
      await Promise.all(ready.map((node) => this.dispatch(fresh, node)));
      const after = this.options.store.listNodes(fleetId);
      if (after.every((x) => x.status === "completed")) await this.event(fleetId, void 0, void 0, "fleet.status", { status: "completed" }, () => this.options.store.setFleetStatus(fleetId, "completed"));
      else {
        const done = new Set(after.filter((x) => x.status === "completed").map((x) => x.nodeId));
        const hasPath = after.some((x) => (x.status === "pending" || x.status === "ready") && (x.spec.depends_on ?? []).every((dep) => done.has(dep)));
        if (!after.some((x) => x.status === "running") && !hasPath) {
          await this.event(fleetId, void 0, void 0, "fleet.status", { status: "needs_attention" }, () => this.options.store.setFleetStatus(fleetId, "needs_attention"));
        }
      }
    } finally {
      this.options.store.releaseLease(fleetId, this.options.owner);
    }
  }
  async dispatch(fleet, node) {
    const adapter = this.options.adapters.get(node.spec.harness);
    if (!adapter) throw new Error(`adapter unavailable: ${node.spec.harness}`);
    const workspace = await this.options.workspace(fleet, node, node.currentAttempt + 1);
    const attempt = this.options.store.createAttempt(fleet, node.nodeId, node.spec.harness, workspace.branch);
    await mkdir(attempt.artifactDir, { recursive: true });
    const prompt = workerPrompt(fleet.spec, node.spec, attempt.artifactDir, this.dependencyContext(fleet.id, node));
    await writeFile(join3(attempt.artifactDir, "prompt.md"), prompt);
    await Promise.all(["stdout.log", "stderr.log", "events.jsonl"].map((name) => writeFile(join3(attempt.artifactDir, name), "")));
    attempt.startedAt = (/* @__PURE__ */ new Date()).toISOString();
    this.options.store.startAttempt(attempt.id);
    const bridge = await this.options.bridge(fleet, node, attempt);
    const sink = async (event) => {
      await appendFile(join3(attempt.artifactDir, "events.jsonl"), JSON.stringify(event) + "\n");
      if (event.type === "process.output" && typeof event.payload.text === "string") {
        const file = event.payload.stream === "stderr" ? "stderr.log" : "stdout.log";
        await appendFile(join3(attempt.artifactDir, file), event.payload.text + "\n");
      }
      const incremental = Number(event.payload.incrementalCostUsd);
      if (Number.isFinite(incremental) && incremental >= 0) {
        const attemptTotal = (this.attemptCosts.get(attempt.id) ?? 0) + incremental;
        this.attemptCosts.set(attempt.id, attemptTotal);
        this.options.store.updateAttemptCost(attempt.id, attemptTotal, String(event.payload.costQuality ?? "reported"));
        const total = (this.costs.get(fleet.id) ?? 0) + incremental;
        this.costs.set(fleet.id, total);
        if (fleet.spec.config?.warn_cost_usd && total >= fleet.spec.config.warn_cost_usd && !this.costWarned.has(fleet.id)) {
          this.costWarned.add(fleet.id);
          const warning = { fleetId: fleet.id, type: "error", at: (/* @__PURE__ */ new Date()).toISOString(), payload: { warning: "cost threshold reached", totalUsd: total } };
          warning.id = this.options.store.appendEvent(warning);
          await this.options.onEvent?.(warning);
        }
        if (fleet.spec.config?.max_cost_usd && total >= fleet.spec.config.max_cost_usd) {
          void this.kill(fleet.id, void 0, 0).then(() => this.options.store.setFleetStatus(fleet.id, "failed"));
        }
      }
      const id = this.options.store.appendEvent(event);
      await this.options.onEvent?.({ ...event, id });
    };
    try {
      const handle = await adapter.start({
        fleetId: fleet.id,
        nodeId: node.nodeId,
        attemptId: attempt.id,
        cwd: workspace.cwd,
        prompt,
        model: node.spec.model,
        effort: node.spec.effort,
        permissionProfile: node.spec.permission_profile ?? "read-only",
        bridge,
        timeoutMs: node.spec.timeout_minutes ? node.spec.timeout_minutes * 6e4 : void 0
      }, sink);
      this.active.set(`${fleet.id}:${node.nodeId}`, { adapter, handle, attempt });
      this.options.store.startAttempt(attempt.id, handle.session?.id, handle.pid);
      for (const message of this.options.store.inbox(fleet.id, node.nodeId).filter((x) => x.status === "pending")) await this.deliverMessage(message);
      if (node.spec.timeout_minutes) this.timers.set(attempt.id, setTimeout(() => void this.kill(fleet.id, node.nodeId, 0), node.spec.timeout_minutes * 6e4));
      void handle.settled.then((result) => this.settle(fleet, node, attempt, workspace.cwd, result)).catch((error) => this.settle(fleet, node, attempt, workspace.cwd, { exitCode: -1, error: String(error) }));
    } catch (error) {
      this.options.store.finishAttempt(attempt.id, "failed", { error: error instanceof Error ? error.message : String(error) });
      await this.tick(fleet.id);
    }
  }
  async settle(fleet, node, attempt, cwd, result) {
    const timer = this.timers.get(attempt.id);
    if (timer) clearTimeout(timer);
    this.active.delete(`${fleet.id}:${node.nodeId}`);
    if (result.session?.id) this.options.store.setAttemptSession(attempt.id, result.session.id);
    const startedAt = attempt.startedAt ? Date.parse(attempt.startedAt) : Date.now() - 1;
    const contracts = result.exitCode === 0 ? await validateContracts(attempt.artifactDir, node.spec.outputs ?? [], startedAt, [cwd]) : [];
    await writeFile(join3(attempt.artifactDir, "result.json"), JSON.stringify(result, null, 2));
    if (result.finalMessage) {
      await mkdir(join3(attempt.artifactDir, "output"), { recursive: true });
      await writeFile(join3(attempt.artifactDir, "output", "final.md"), result.finalMessage);
    }
    if (cwd !== fleet.repoPath) try {
      const { stdout: base } = await exec("git", ["-C", fleet.repoPath, "rev-parse", "HEAD"], { windowsHide: true });
      const { stdout: diff } = await exec("git", ["-C", cwd, "diff", "--binary", base.trim()], { windowsHide: true, maxBuffer: 50 * 1024 * 1024 });
      await writeFile(join3(attempt.artifactDir, "diff.patch"), diff);
    } catch {
    }
    const contractFailure = contracts.find((x) => !x.ok);
    if (result.exitCode === 0 && !contractFailure) this.options.store.finishAttempt(attempt.id, "completed", { exitCode: 0 });
    else {
      const error = result.error ?? contractFailure?.detail ?? `exit code ${result.exitCode}`;
      const latest = this.options.store.listNodes(fleet.id).find((x) => x.nodeId === node.nodeId);
      const max = node.spec.max_attempts ?? fleet.spec.config?.max_attempts ?? 3;
      this.options.store.finishAttempt(attempt.id, latest.currentAttempt < max ? "pending" : "failed", { exitCode: result.exitCode, error });
      if (contractFailure) await this.event(fleet.id, node.nodeId, attempt.id, "contract.failed", { results: contracts });
    }
    const gate = fleet.spec.config?.loop?.gate;
    if (result.exitCode === 0 && !contractFailure && (node.spec.type === "review" || gate === node.nodeId) && result.finalMessage) {
      const verdict = /\biterate\b/i.test(result.finalMessage) ? "iterate" : /\blgtm\b/i.test(result.finalMessage) ? "lgtm" : "unclear";
      await this.event(fleet.id, node.nodeId, attempt.id, "review.verdict", { verdict, message: result.finalMessage });
      if (verdict === "iterate") {
        const state = this.options.store.updateReviewState(fleet.id, node.nodeId, { iterationDelta: 1, resetLgtm: true });
        const max = fleet.spec.config?.loop?.max_iterations ?? 4;
        if (state.iteration >= max) this.options.store.setNodeStatus(fleet.id, node.nodeId, "needs_attention", "review loop reached max_iterations");
        else {
          for (const target of node.spec.reviewer_for?.length ? node.spec.reviewer_for : node.spec.depends_on ?? []) this.options.store.setNodeStatus(fleet.id, target, "pending");
          this.options.store.setNodeStatus(fleet.id, node.nodeId, "pending");
        }
      } else if (verdict === "lgtm") {
        const state = this.options.store.updateReviewState(fleet.id, node.nodeId, { lgtmDelta: 1 });
        if (state.lgtmCount < (fleet.spec.config?.loop?.lgtm_count ?? 1)) this.options.store.setNodeStatus(fleet.id, node.nodeId, "pending");
      } else this.options.store.setNodeStatus(fleet.id, node.nodeId, "needs_attention", "reviewer returned no explicit LGTM or iterate verdict");
    }
    const settledNode = this.options.store.listNodes(fleet.id).find((x) => x.nodeId === node.nodeId);
    await this.event(fleet.id, node.nodeId, attempt.id, "node.status", { status: settledNode?.status, exitCode: result.exitCode, error: result.error });
    await this.tick(fleet.id);
  }
  async pause(fleetId) {
    const fleet = this.requireFleet(fleetId);
    if (fleet.status !== "running") throw new Error(`fleet cannot pause from ${fleet.status}`);
    this.options.store.setFleetStatus(fleetId, "paused");
  }
  async resume(fleetId) {
    const fleet = this.requireFleet(fleetId);
    if (!["paused", "needs_attention", "paused_orchestrator_unavailable"].includes(fleet.status)) throw new Error(`fleet cannot resume from ${fleet.status}`);
    this.options.store.setFleetStatus(fleetId, "running");
    await this.tick(fleetId);
  }
  async kill(fleetId, nodeId, graceMs = 5e3) {
    const targets = [...this.active].filter(([key]) => key.startsWith(`${fleetId}:`) && (!nodeId || key === `${fleetId}:${nodeId}`));
    await Promise.all(targets.map(async ([key, run]) => {
      await run.adapter.cancel(run.handle, graceMs);
      this.options.store.finishAttempt(run.attempt.id, "cancelled");
      this.active.delete(key);
    }));
    if (!nodeId) this.options.store.setFleetStatus(fleetId, "cancelled");
  }
  async relaunch(fleetId, nodeId) {
    const fleet = this.requireFleet(fleetId);
    this.options.store.setNodeStatus(fleetId, nodeId, "pending");
    if (["needs_attention", "failed"].includes(fleet.status)) this.options.store.setFleetStatus(fleetId, "running");
    await this.tick(fleetId);
  }
  async deliverMessage(message) {
    const run = this.active.get(`${message.fleetId}:${message.recipient}`);
    if (!run) return false;
    const result = await run.adapter.send(run.handle, { id: message.id, from: message.sender, to: message.recipient, body: message.body, createdAt: message.createdAt });
    if (result.accepted) this.options.store.markMessage(message.id, "delivered");
    return result.accepted;
  }
  dependencyContext(fleetId, node) {
    return this.options.store.listNodes(fleetId).filter((x) => (node.spec.depends_on ?? []).includes(x.nodeId)).map((x) => `${x.nodeId}: completed`).join("\n");
  }
  requireFleet(id) {
    const fleet = this.options.store.getFleet(id);
    if (!fleet) throw new Error(`unknown fleet ${id}`);
    return fleet;
  }
  async event(fleetId, nodeId, attemptId, type, payload, mutate) {
    mutate?.();
    const event = { fleetId, nodeId, attemptId, type, at: (/* @__PURE__ */ new Date()).toISOString(), payload };
    const id = this.options.store.appendEvent(event);
    await this.options.onEvent?.({ ...event, id });
  }
};

// packages/git-workspaces/src/index.ts
import { execFile as execFile2 } from "child_process";
import { appendFile as appendFile2, mkdir as mkdir2, readFile as readFile2, rm } from "fs/promises";
import { dirname as dirname3, join as join4, resolve as resolve4, relative as relative2, isAbsolute as isAbsolute2 } from "path";
import { promisify as promisify2 } from "util";
var exec2 = promisify2(execFile2);
function slug(value) {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "fleet";
}
function branchName(fleetName, runId, nodeId, attempt) {
  return `fleet/${slug(fleetName)}/${slug(runId)}/${slug(nodeId)}/attempt-${attempt}`;
}
async function git(repo, args) {
  const { stdout } = await exec2("git", ["-C", repo, ...args], { windowsHide: true });
  return stdout.trim();
}
async function assertGitRepository(repo) {
  const top = await git(repo, ["rev-parse", "--show-toplevel"]);
  if (!top) throw new Error(`${repo} is not a git repository`);
}
var WorktreeManager = class {
  constructor(repo, fleetDir) {
    this.repo = repo;
    this.fleetDir = fleetDir;
  }
  repo;
  fleetDir;
  async create(fleetName, runId, nodeId, attempt) {
    await assertGitRepository(this.repo);
    const excludeValue = await git(this.repo, ["rev-parse", "--git-path", "info/exclude"]);
    const excludePath = isAbsolute2(excludeValue) ? excludeValue : resolve4(this.repo, excludeValue);
    const exclude = await readFile2(excludePath, "utf8").catch(() => "");
    if (!exclude.split(/\r?\n/).includes(".fleet/")) await appendFile2(excludePath, `${exclude.endsWith("\n") || !exclude ? "" : "\n"}.fleet/
`);
    const branch = branchName(fleetName, runId, nodeId, attempt);
    const path = join4(this.fleetDir, "worktrees", slug(nodeId), `attempt-${attempt}`);
    await mkdir2(dirname3(path), { recursive: true });
    await git(this.repo, ["worktree", "add", "-b", branch, path, "HEAD"]);
    return { path, branch };
  }
  async integrate(branches, targetBranch) {
    if (targetBranch) await git(this.repo, ["switch", targetBranch]);
    const merged = [];
    for (const branch of branches) {
      try {
        await git(this.repo, ["merge", "--no-ff", "--no-edit", branch]);
        merged.push(branch);
      } catch (error) {
        return { merged, conflict: error instanceof Error ? error.message : String(error) };
      }
    }
    return { merged };
  }
  async cleanupWorktree(path) {
    const rel = relative2(resolve4(this.fleetDir, "worktrees"), resolve4(path));
    if (isAbsolute2(rel) || rel.startsWith("..")) throw new Error("refusing to remove a path outside this fleet's worktrees");
    await git(this.repo, ["worktree", "remove", "--force", path]);
    await rm(path, { recursive: true, force: true });
  }
};

// packages/adapter-pi/src/index.ts
var PiAdapter = class {
  constructor(command = "pi", prefixArgs = []) {
    this.command = command;
    this.prefixArgs = prefixArgs;
  }
  command;
  prefixArgs;
  id = "pi";
  runs = /* @__PURE__ */ new Map();
  bridges = /* @__PURE__ */ new Map();
  async probe() {
    const version = commandProbe(this.command, [...this.prefixArgs, "--offline", "--version"]);
    return { command: "pi", ...version, detail: version.available ? "Authentication is provider/model-specific; Pi verifies it when the run starts." : version.detail };
  }
  async capabilities() {
    return {
      efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      supportsResume: true,
      supportsSteer: true,
      supportsReliableIncrementalCost: true,
      permissionProfiles: ["read-only", "workspace-write", "full-access"]
    };
  }
  async start(spec, sink) {
    const args = ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--session-dir", spec.cwd + "/.fleet-sessions"];
    if (spec.bridge) args.push("-e", spec.bridge.args.at(-1) ?? spec.bridge.command);
    if (spec.model) args.push("--model", spec.model);
    if (spec.effort) args.push("--thinking", spec.effort);
    if (spec.permissionProfile === "read-only") args.push("--tools", "fleet_file_read,fleet_file_list,fleet_status,fleet_message,fleet_inbox,fleet_request_node,fleet_publish");
    else if (spec.permissionProfile === "workspace-write") args.push("--tools", "fleet_file_read,fleet_file_list,fleet_file_write,fleet_status,fleet_message,fleet_inbox,fleet_request_node,fleet_publish,fleet_add_node,fleet_edit_node,fleet_control,fleet_report");
    else args.push("--tools", "read,bash,edit,write,grep,find,ls,fleet_file_read,fleet_file_list,fleet_file_write,fleet_status,fleet_message,fleet_inbox,fleet_request_node,fleet_publish,fleet_add_node,fleet_edit_node,fleet_control,fleet_report");
    const run = launchProcess(this.id, spec, sink, {
      command: this.command,
      args: [...this.prefixArgs, ...args],
      input: JSON.stringify({ type: "prompt", message: spec.prompt }) + "\n",
      env: spec.bridge?.env,
      parse: (value, stream) => mapPi(value, stream),
      sessionFrom: (value) => object(value)?.sessionId,
      finalFrom: (value) => {
        const event = object(value);
        const message = object(event?.message);
        return event?.type === "message_end" && message?.role === "assistant" ? textContent(message.content) : void 0;
      }
    });
    void run.settled.then((result) => {
      if (result.session) this.bridges.set(result.session.id, spec.bridge);
    });
    this.runs.set(run.id, run);
    return run;
  }
  async resume(session, message, sink) {
    const spec = {
      fleetId: "resume",
      nodeId: "orchestrator",
      attemptId: session.id,
      cwd: session.cwd,
      prompt: message,
      permissionProfile: "workspace-write",
      bridge: this.bridges.get(session.id)
    };
    const args = [
      "--mode",
      "rpc",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--session",
      session.id,
      "--tools",
      "fleet_file_read,fleet_file_list,fleet_file_write,fleet_status,fleet_message,fleet_inbox,fleet_request_node,fleet_publish,fleet_add_node,fleet_edit_node,fleet_control,fleet_report"
    ];
    if (spec.bridge) args.push("-e", spec.bridge.args.at(-1) ?? spec.bridge.command);
    const run = launchProcess(this.id, spec, sink, {
      command: this.command,
      args: [...this.prefixArgs, ...args],
      input: JSON.stringify({ type: "prompt", message }) + "\n",
      env: spec.bridge?.env,
      parse: (value, stream) => mapPi(value, stream),
      sessionFrom: () => session.id,
      finalFrom: (value) => {
        const event = object(value);
        const response = object(event?.message);
        return event?.type === "message_end" && response?.role === "assistant" ? textContent(response.content) : void 0;
      }
    });
    this.runs.set(run.id, run);
    return run;
  }
  async send(handle, message) {
    const run = this.runs.get(handle.id);
    if (!run || run.process.exitCode !== null) return { accepted: false, boundary: "next-turn", detail: "session is not running" };
    run.process.stdin.write(JSON.stringify({ type: "steer", message: `Fleet message from ${message.from}: ${message.body}` }) + "\n");
    return { accepted: true, boundary: "next-turn" };
  }
  async cancel(handle, graceMs) {
    const run = this.runs.get(handle.id);
    if (run) await killProcessTree(run.process, graceMs);
  }
};
function object(value) {
  return value && typeof value === "object" ? value : void 0;
}
function textContent(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return void 0;
  return value.filter((x) => object(x)?.type === "text").map((x) => object(x)?.text).join("\n") || void 0;
}
function mapPi(value, stream) {
  const e = object(value);
  if (!e) return { type: "process.output", payload: { stream, text: String(value) } };
  const map = {
    agent_start: "session.started",
    turn_start: "turn.started",
    turn_end: "turn.completed",
    message_end: "assistant.message",
    tool_execution_start: "tool.call",
    tool_execution_end: "tool.result",
    agent_end: "session.settled"
  };
  const type = map[e.type] ?? (stream === "stderr" ? "error" : "process.output");
  const usage = object(object(e.message)?.usage);
  return { type, payload: usage ? { ...e, incrementalCostUsd: usage.cost?.total, costQuality: usage.cost?.total === void 0 ? "unavailable" : "reported" } : e };
}

// packages/adapter-claude-code/src/index.ts
import { writeFileSync as writeFileSync2, mkdirSync as mkdirSync2 } from "fs";
import { join as join5 } from "path";
var ClaudeCodeAdapter = class {
  constructor(command = "claude", prefixArgs = []) {
    this.command = command;
    this.prefixArgs = prefixArgs;
  }
  command;
  prefixArgs;
  id = "claude-code";
  runs = /* @__PURE__ */ new Map();
  bridges = /* @__PURE__ */ new Map();
  async probe() {
    const version = commandProbe(this.command, [...this.prefixArgs, "--version"]);
    const auth = version.available ? commandProbe(this.command, [...this.prefixArgs, "auth", "status"]) : void 0;
    return { command: "claude", ...version, authenticated: auth?.available };
  }
  async capabilities() {
    return {
      efforts: ["low", "medium", "high", "xhigh", "max"],
      supportsResume: true,
      supportsSteer: true,
      supportsReliableIncrementalCost: true,
      permissionProfiles: ["read-only", "workspace-write", "full-access"]
    };
  }
  async start(spec, sink) {
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
    if (spec.model) args.push("--model", spec.model);
    if (spec.effort) args.push("--effort", spec.effort);
    if (spec.permissionProfile === "read-only") args.push("--permission-mode", "plan");
    else if (spec.permissionProfile === "workspace-write") args.push("--permission-mode", "acceptEdits");
    else args.push("--dangerously-skip-permissions");
    if (spec.bridge) {
      const path = join5(spec.cwd, ".fleet-claude-mcp.json");
      mkdirSync2(spec.cwd, { recursive: true });
      writeFileSync2(path, JSON.stringify({ mcpServers: { "harness-fleet": spec.bridge } }));
      args.push("--mcp-config", path, "--strict-mcp-config");
    }
    const run = launchProcess(this.id, spec, sink, {
      command: this.command,
      args: [...this.prefixArgs, ...args],
      input: JSON.stringify({ type: "user", message: { role: "user", content: spec.prompt } }) + "\n",
      env: spec.bridge?.env,
      parse: mapClaude,
      sessionFrom: (value) => object2(value)?.session_id,
      finalFrom: (value) => object2(value)?.type === "result" ? String(object2(value)?.result ?? "") : void 0
    });
    void run.settled.then((result) => {
      if (result.session) this.bridges.set(result.session.id, spec.bridge);
    });
    this.runs.set(run.id, run);
    return run;
  }
  async resume(session, message, sink) {
    const spec = { fleetId: "resume", nodeId: "orchestrator", attemptId: session.id, cwd: session.cwd, prompt: message, permissionProfile: "workspace-write" };
    const args = ["-p", "--resume", session.id, "--output-format", "stream-json", "--verbose"];
    const bridge = this.bridges.get(session.id);
    if (bridge) {
      const path = join5(session.cwd, ".fleet-claude-mcp.json");
      writeFileSync2(path, JSON.stringify({ mcpServers: { "harness-fleet": bridge } }));
      args.push("--mcp-config", path, "--strict-mcp-config");
    }
    const run = launchProcess(this.id, { ...spec, bridge }, sink, {
      command: this.command,
      args: [...this.prefixArgs, ...args],
      input: message,
      parse: mapClaude,
      sessionFrom: () => session.id,
      finalFrom: (v) => object2(v)?.type === "result" ? String(object2(v)?.result ?? "") : void 0
    });
    this.runs.set(run.id, run);
    return run;
  }
  async send(handle, message) {
    const run = this.runs.get(handle.id);
    if (!run || run.process.exitCode !== null) return { accepted: false, boundary: "next-turn", detail: "session is not running" };
    run.process.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: `Fleet message from ${message.from}: ${message.body}` } }) + "\n");
    return { accepted: true, boundary: "next-turn" };
  }
  async cancel(handle, graceMs) {
    const run = this.runs.get(handle.id);
    if (run) await killProcessTree(run.process, graceMs);
  }
};
function object2(value) {
  return value && typeof value === "object" ? value : void 0;
}
function mapClaude(value, stream) {
  const e = object2(value);
  if (!e) return { type: "process.output", payload: { stream, text: String(value) } };
  const type = e.type === "system" ? "session.started" : e.type === "assistant" ? "assistant.message" : e.type === "result" ? e.is_error ? "turn.failed" : "turn.completed" : stream === "stderr" ? "error" : "process.output";
  return { type, payload: { ...e, incrementalCostUsd: e.total_cost_usd, costQuality: e.total_cost_usd === void 0 ? "unavailable" : "reported" } };
}

// packages/adapter-codex/src/index.ts
var CodexAdapter = class {
  constructor(command = "codex", prefixArgs = []) {
    this.command = command;
    this.prefixArgs = prefixArgs;
  }
  command;
  prefixArgs;
  id = "codex";
  runs = /* @__PURE__ */ new Map();
  bridges = /* @__PURE__ */ new Map();
  async probe() {
    const version = commandProbe(this.command, [...this.prefixArgs, "--version"]);
    const auth = version.available ? commandProbe(this.command, [...this.prefixArgs, "login", "status"]) : void 0;
    return { command: "codex", ...version, authenticated: auth?.available };
  }
  async capabilities() {
    return {
      efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
      supportsResume: true,
      supportsSteer: false,
      supportsReliableIncrementalCost: false,
      permissionProfiles: ["read-only", "workspace-write", "full-access"]
    };
  }
  async start(spec, sink) {
    const args = ["exec", "--json", "--color", "never", "-C", spec.cwd];
    if (spec.model) args.push("--model", spec.model);
    if (spec.effort) args.push("-c", `model_reasoning_effort="${spec.effort}"`);
    if (spec.permissionProfile === "full-access") args.push("--dangerously-bypass-approvals-and-sandbox");
    else args.push("--sandbox", spec.permissionProfile);
    if (spec.bridge) {
      args.push("-c", `mcp_servers.harness_fleet.command=${JSON.stringify(spec.bridge.command)}`);
      args.push("-c", `mcp_servers.harness_fleet.args=${JSON.stringify(spec.bridge.args)}`);
      for (const [key, value] of Object.entries(spec.bridge.env)) args.push("-c", `mcp_servers.harness_fleet.env.${key}=${JSON.stringify(value)}`);
    }
    args.push("-");
    const run = launchProcess(this.id, spec, sink, {
      command: this.command,
      args: [...this.prefixArgs, ...args],
      input: spec.prompt,
      closeInputAfterWrite: true,
      env: spec.bridge?.env,
      parse: mapCodex,
      sessionFrom: (v) => object3(v)?.thread_id,
      finalFrom: (v) => object3(v)?.type === "item.completed" && object3(object3(v)?.item)?.type === "agent_message" ? String(object3(object3(v)?.item)?.text ?? "") : void 0
    });
    void run.settled.then((result) => {
      if (result.session) this.bridges.set(result.session.id, spec.bridge);
    });
    this.runs.set(run.id, run);
    return run;
  }
  async resume(session, message, sink) {
    const spec = { fleetId: "resume", nodeId: "orchestrator", attemptId: session.id, cwd: session.cwd, prompt: message, permissionProfile: "workspace-write" };
    const bridge = this.bridges.get(session.id);
    const args = ["exec", "resume", "--json"];
    if (bridge) {
      args.push("-c", `mcp_servers.harness_fleet.command=${JSON.stringify(bridge.command)}`);
      args.push("-c", `mcp_servers.harness_fleet.args=${JSON.stringify(bridge.args)}`);
      for (const [key, value] of Object.entries(bridge.env)) args.push("-c", `mcp_servers.harness_fleet.env.${key}=${JSON.stringify(value)}`);
    }
    args.push(session.id, "-");
    const run = launchProcess(this.id, { ...spec, bridge }, sink, {
      command: this.command,
      args: [...this.prefixArgs, ...args],
      input: message,
      closeInputAfterWrite: true,
      parse: mapCodex,
      sessionFrom: () => session.id,
      finalFrom: (v) => object3(v)?.type === "item.completed" && object3(object3(v)?.item)?.type === "agent_message" ? String(object3(object3(v)?.item)?.text ?? "") : void 0
    });
    this.runs.set(run.id, run);
    return run;
  }
  async send() {
    return { accepted: true, boundary: "next-turn", detail: "queued by daemon for the next codex exec resume" };
  }
  async cancel(handle, graceMs) {
    const run = this.runs.get(handle.id);
    if (run) await killProcessTree(run.process, graceMs);
  }
};
function object3(value) {
  return value && typeof value === "object" ? value : void 0;
}
function mapCodex(value, stream) {
  const e = object3(value);
  if (!e) return { type: "process.output", payload: { stream, text: String(value) } };
  const item = object3(e.item);
  const type = e.type === "thread.started" ? "session.started" : e.type === "turn.started" ? "turn.started" : e.type === "turn.completed" ? "turn.completed" : e.type === "turn.failed" ? "turn.failed" : e.type === "item.started" && item?.type?.includes("tool") ? "tool.call" : e.type === "item.completed" && item?.type?.includes("tool") ? "tool.result" : e.type === "item.completed" && item?.type === "agent_message" ? "assistant.message" : stream === "stderr" ? "error" : "process.output";
  return { type, payload: { ...e, costQuality: "unavailable" } };
}

// apps/daemon/src/server.ts
var moduleDir = dirname4(fileURLToPath(import.meta.url));
var packageRoot = existsSync3(join6(moduleDir, "..", "package.json")) ? resolve5(moduleDir, "..") : resolve5(moduleDir, "../../..");
var distDir = join6(packageRoot, "dist");
async function createServer(options) {
  const app2 = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  await app2.register(cookie, { secret: options.adminToken });
  await app2.register(websocket);
  const adapters = /* @__PURE__ */ new Map([["pi", new PiAdapter()], ["claude-code", new ClaudeCodeAdapter()], ["codex", new CodexAdapter()]]);
  for (const orphan of options.store.recoverRunning()) {
    if (orphan.pid) {
      if (process.platform === "win32") spawnSync2("taskkill", ["/PID", String(orphan.pid), "/T", "/F"], { windowsHide: true });
      else {
        try {
          process.kill(-orphan.pid, "SIGKILL");
        } catch {
        }
      }
    }
    options.store.finishAttempt(orphan.attemptId, "pending", { error: "recovered after daemon restart; orphaned process reconciled" });
  }
  const sockets = /* @__PURE__ */ new Map();
  const orchestratorBusy = /* @__PURE__ */ new Set();
  const broadcast = (event) => {
    const data = JSON.stringify(event);
    for (const socket of sockets.get(event.fleetId) ?? []) if (socket.readyState === 1) socket.send(data);
  };
  const scheduler = new FleetScheduler({
    owner: `daemon-${process.pid}`,
    adapters,
    store: options.store,
    canDispatch: (fleet) => options.store.getOrchestrator(fleet.id)?.status === "ready",
    onEvent: async (event) => {
      broadcast(event);
      if (event.nodeId !== "orchestrator" && (["node.status", "contract.failed", "review.verdict", "approval.blocked", "error"].includes(event.type) || event.type === "fleet.status" && event.payload.status === "needs_attention")) void wakeOrchestrator(event.fleetId, `Fleet event ${event.type}: ${JSON.stringify(event.payload)}`);
    },
    workspace: async (fleet, node, attempt) => {
      if (!node.spec.worktree) return { cwd: fleet.repoPath };
      const manager = new WorktreeManager(fleet.repoPath, options.store.fleetArtifactDir(fleet));
      const created = await manager.create(fleet.spec.fleet_name, fleet.runId, node.nodeId, attempt);
      return { cwd: created.path, branch: created.branch };
    },
    bridge: async (fleet, node, attempt) => {
      const token = options.store.issueToken({ scope: "worker", fleetId: fleet.id, nodeId: node.nodeId, attemptId: attempt.id }, 24 * 60 * 6e4);
      const isPi = node.spec.harness === "pi";
      return {
        command: process.execPath,
        args: [join6(distDir, isPi ? "bridge-pi.js" : "bridge-mcp.js")],
        env: { HARNESS_FLEET_URL: `http://127.0.0.1:${app2.server.address()?.port ?? options.port ?? 0}`, HARNESS_FLEET_TOKEN: token }
      };
    }
  });
  app2.addHook("onReady", async () => {
    for (const fleet of options.store.listFleets().filter((x) => x.status === "running")) void scheduler.tick(fleet.id);
  });
  async function wakeOrchestrator(fleetId, reason) {
    if (orchestratorBusy.has(fleetId)) return;
    const fleet = options.store.getFleet(fleetId);
    const state = options.store.getOrchestrator(fleetId);
    if (!fleet || !state?.sessionId || ["completed", "failed", "cancelled", "waiting_for_confirmation"].includes(fleet.status)) return;
    const adapter = adapters.get(state.harness);
    if (!adapter) return;
    orchestratorBusy.add(fleetId);
    options.store.setOrchestratorSession(fleetId, state.sessionId, "resuming", state.failureCount);
    try {
      let lastError = "orchestrator resume failed";
      for (const delay of [1e3, 2e3, 4e3]) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
        try {
          const handle = await adapter.resume({ id: state.sessionId, harness: state.harness, cwd: fleet.repoPath }, reason, async (event2) => {
            const normalized = { ...event2, fleetId, nodeId: "orchestrator" };
            const id = options.store.appendEvent(normalized);
            broadcast({ ...normalized, id });
          });
          const result = await handle.settled;
          if (result.exitCode === 0) {
            options.store.setOrchestratorSession(fleetId, result.session?.id ?? state.sessionId, "ready", 0);
            await scheduler.tick(fleetId);
            return;
          }
          lastError = result.error ?? lastError;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
      options.store.setOrchestratorSession(fleetId, state.sessionId, "unavailable", state.failureCount + 3);
      options.store.setFleetStatus(fleetId, "paused_orchestrator_unavailable");
      const event = { fleetId, nodeId: "orchestrator", type: "fleet.status", at: (/* @__PURE__ */ new Date()).toISOString(), payload: { status: "paused_orchestrator_unavailable", error: lastError } };
      event.id = options.store.appendEvent(event);
      broadcast(event);
    } finally {
      orchestratorBusy.delete(fleetId);
    }
  }
  const bearer = (request) => {
    const header = request.headers.authorization;
    return header?.startsWith("Bearer ") ? header.slice(7) : request.cookies.fleet_session;
  };
  const requireAdmin = (request) => {
    if (bearer(request) !== options.adminToken) throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
  };
  const requireCapability = (request) => {
    const token = bearer(request);
    const capability = token ? options.store.consumeToken(token) : void 0;
    if (!capability || !["worker", "orchestrator"].includes(capability.scope)) throw Object.assign(new Error("invalid capability token"), { statusCode: 401 });
    return capability;
  };
  const requireOrchestrator = (request) => {
    const capability = requireCapability(request);
    if (capability.scope !== "orchestrator") throw Object.assign(new Error("orchestrator capability required"), { statusCode: 403 });
    return capability;
  };
  app2.get("/api/v1/health", async () => ({ ok: true, pid: process.pid, version: "0.1.0" }));
  app2.get("/api/v1/openapi.yaml", async (_request, reply) => reply.type("application/yaml").send(readFileSync3(join6(packageRoot, "docs", "openapi.yaml"), "utf8")));
  app2.get("/api/v1/doctor", async (request) => {
    requireAdmin(request);
    const probes = await Promise.all([...adapters.values()].map(async (adapter) => ({ id: adapter.id, probe: await adapter.probe(), capabilities: await adapter.capabilities() })));
    return { daemon: { ok: true }, node: process.version, database: options.store.path, harnesses: probes };
  });
  app2.post("/api/v1/shutdown", async (request) => {
    requireAdmin(request);
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 20);
    return { ok: true };
  });
  app2.get("/api/v1/config", async (request) => {
    requireAdmin(request);
    return options.store.getSettings();
  });
  app2.post("/api/v1/config", async (request) => {
    requireAdmin(request);
    options.store.setSetting(request.body.key, request.body.value);
    return { ok: true };
  });
  app2.get("/api/v1/fleets", async (request) => {
    requireAdmin(request);
    return options.store.listFleets();
  });
  app2.get("/api/v1/fleets/:id", async (request) => {
    requireAdmin(request);
    const fleet = options.store.getFleet(request.params.id);
    if (!fleet) throw Object.assign(new Error("fleet not found"), { statusCode: 404 });
    return {
      ...fleet,
      nodes: options.store.listNodes(fleet.id),
      attempts: options.store.listAttempts(fleet.id),
      orchestrator: options.store.getOrchestrator(fleet.id),
      events: options.store.listEvents(fleet.id),
      messages: options.store.listMessages(fleet.id)
    };
  });
  app2.post("/api/v1/fleets", async (request) => {
    requireAdmin(request);
    const spec = typeof request.body.spec === "string" ? parseFleetSpec(request.body.spec, request.body.format) : applyDefaults(request.body.spec);
    await validateCapabilities(spec, async (id) => await adapters.get(id).capabilities());
    return options.store.createFleet(spec, request.body.repoPath ?? process.cwd());
  });
  app2.post("/api/v1/fleets/design", async (request) => {
    requireAdmin(request);
    const adapter = adapters.get(request.body.orchestrator);
    if (!adapter) throw Object.assign(new Error("unsupported orchestrator"), { statusCode: 400 });
    const id = randomUUID3();
    const cwd = resolve5(request.body.repoPath ?? process.cwd());
    const attempt = randomUUID3();
    let sessionId;
    const orchestratorToken = options.store.issueToken({ scope: "orchestrator", fleetId: id }, 7 * 24 * 60 * 6e4);
    const isPi = request.body.orchestrator === "pi";
    const bridge = {
      command: process.execPath,
      args: [join6(distDir, isPi ? "bridge-pi.js" : "bridge-mcp.js")],
      env: { HARNESS_FLEET_URL: `http://127.0.0.1:${app2.server.address()?.port ?? options.port ?? 0}`, HARNESS_FLEET_TOKEN: orchestratorToken }
    };
    const handle = await adapter.start({
      fleetId: id,
      nodeId: "orchestrator",
      attemptId: attempt,
      cwd,
      prompt: orchestratorPrompt(request.body.goal),
      model: request.body.model,
      effort: request.body.effort,
      permissionProfile: "workspace-write",
      bridge
    }, (event) => {
      sessionId = String(event.payload.sessionId ?? sessionId ?? "") || void 0;
    });
    const result = await handle.settled;
    if (result.exitCode !== 0 || !result.finalMessage) throw Object.assign(new Error(result.error ?? "orchestrator did not return a plan"), { statusCode: 502 });
    const clean = extractSpecification(result.finalMessage);
    const spec = parseFleetSpec(clean);
    spec.goal = request.body.goal;
    spec.orchestrator = { harness: request.body.orchestrator, model: request.body.model, effort: request.body.effort, permission_profile: "workspace-write" };
    await validateCapabilities(spec, async (h) => adapters.get(h).capabilities());
    const fleet = options.store.createFleet(spec, cwd, id);
    options.store.setOrchestratorSession(id, result.session?.id ?? sessionId, "ready");
    return { fleet, preview: preview(spec) };
  });
  app2.post("/api/v1/fleets/:id/launch", async (request) => {
    requireAdmin(request);
    if (request.body.confirm !== true) throw Object.assign(new Error("human confirmation is required"), { statusCode: 409 });
    const fleet = options.store.getFleet(request.params.id);
    const state = options.store.getOrchestrator(request.params.id);
    if (!fleet || !state) throw Object.assign(new Error("fleet not found"), { statusCode: 404 });
    if (!state.sessionId) {
      const adapter = adapters.get(state.harness);
      const token = options.store.issueToken({ scope: "orchestrator", fleetId: fleet.id }, 7 * 24 * 60 * 6e4);
      const isPi = state.harness === "pi";
      const bridge = { command: process.execPath, args: [join6(distDir, isPi ? "bridge-pi.js" : "bridge-mcp.js")], env: { HARNESS_FLEET_URL: `http://127.0.0.1:${app2.server.address()?.port ?? options.port ?? 0}`, HARNESS_FLEET_TOKEN: token } };
      const handle = await adapter.start({
        fleetId: fleet.id,
        nodeId: "orchestrator",
        attemptId: randomUUID3(),
        cwd: fleet.repoPath,
        prompt: `Operate this human-approved fleet. Goal: ${fleet.spec.goal}
Plan: ${JSON.stringify(fleet.spec)}`,
        model: state.model,
        effort: state.effort,
        permissionProfile: state.permissionProfile,
        bridge
      }, (event) => {
        const id = options.store.appendEvent(event);
        broadcast({ ...event, id });
      });
      const result = await handle.settled;
      if (result.exitCode !== 0 || !result.session) throw Object.assign(new Error(result.error ?? "orchestrator failed to start"), { statusCode: 502 });
      options.store.setOrchestratorSession(fleet.id, result.session.id, "ready", 0);
    }
    await scheduler.confirmAndLaunch(request.params.id, request.body.fullAccessConfirm === true);
    return { ok: true };
  });
  app2.post("/api/v1/fleets/:id/pause", async (request) => {
    requireAdmin(request);
    await scheduler.pause(request.params.id);
    return { ok: true };
  });
  app2.post("/api/v1/fleets/:id/resume", async (request) => {
    requireAdmin(request);
    const fleet = options.store.getFleet(request.params.id);
    if (!fleet) throw Object.assign(new Error("fleet not found"), { statusCode: 404 });
    if (fullAccessIds(fleet.spec).size && !fleet.fullAccessConfirmed) throw Object.assign(new Error("full access has not been confirmed for this plan"), { statusCode: 409 });
    await scheduler.resume(request.params.id);
    return { ok: true };
  });
  app2.post("/api/v1/fleets/:id/kill", async (request) => {
    requireAdmin(request);
    await scheduler.kill(request.params.id, request.body.nodeId, request.body.graceMs ?? 5e3);
    return { ok: true };
  });
  app2.post("/api/v1/fleets/:id/relaunch/:node", async (request) => {
    requireAdmin(request);
    const fleet = options.store.getFleet(request.params.id);
    if (!fleet) throw Object.assign(new Error("fleet not found"), { statusCode: 404 });
    const worker = fleet.spec.workers.find((x) => x.id === request.params.node);
    if (!worker) throw Object.assign(new Error("worker not found"), { statusCode: 404 });
    if (request.body?.harness || request.body?.model) {
      const changed = { ...worker, harness: request.body.harness ?? worker.harness, model: request.body.model ?? worker.model };
      const spec = applyDefaults({ ...fleet.spec, workers: fleet.spec.workers.map((x) => x.id === worker.id ? changed : x) });
      await validateCapabilities(spec, async (id) => adapters.get(id).capabilities());
      options.store.updateNode(fleet.id, worker.id, changed);
      options.store.updateSpec(fleet.id, spec);
    }
    await scheduler.relaunch(request.params.id, request.params.node);
    return { ok: true };
  });
  app2.put("/api/v1/fleets/:id/orchestrator", async (request) => {
    requireAdmin(request);
    const fleet = options.store.getFleet(request.params.id);
    const adapter = adapters.get(request.body.harness);
    if (!fleet || !adapter) throw Object.assign(new Error("fleet or harness not found"), { statusCode: 404 });
    const caps = await adapter.capabilities();
    if (request.body.effort && !caps.efforts.includes(request.body.effort)) throw Object.assign(new Error("unsupported orchestrator effort"), { statusCode: 400 });
    const orchestrator = { harness: request.body.harness, model: request.body.model, effort: request.body.effort, permission_profile: "workspace-write" };
    const spec = { ...fleet.spec, orchestrator };
    await validateCapabilities(spec, async (id) => adapters.get(id).capabilities());
    options.store.updateSpec(fleet.id, spec);
    options.store.replaceOrchestrator(fleet.id, { ...orchestrator, permissionProfile: "workspace-write" });
    const token = options.store.issueToken({ scope: "orchestrator", fleetId: fleet.id }, 7 * 24 * 60 * 6e4);
    const isPi = orchestrator.harness === "pi";
    const bridge = { command: process.execPath, args: [join6(distDir, isPi ? "bridge-pi.js" : "bridge-mcp.js")], env: { HARNESS_FLEET_URL: `http://127.0.0.1:${app2.server.address()?.port ?? options.port ?? 0}`, HARNESS_FLEET_TOKEN: token } };
    const handle = await adapter.start({
      fleetId: fleet.id,
      nodeId: "orchestrator",
      attemptId: randomUUID3(),
      cwd: fleet.repoPath,
      prompt: `Take over this existing Harness Fleet. Goal: ${fleet.spec.goal}
Current nodes: ${JSON.stringify(options.store.listNodes(fleet.id))}`,
      model: orchestrator.model,
      effort: orchestrator.effort,
      permissionProfile: "workspace-write",
      bridge
    }, (event) => {
      const id = options.store.appendEvent(event);
      broadcast({ ...event, id });
    });
    const result = await handle.settled;
    if (result.exitCode !== 0 || !result.session) {
      options.store.setOrchestratorSession(fleet.id, void 0, "unavailable", 1);
      throw Object.assign(new Error(result.error ?? "replacement orchestrator failed"), { statusCode: 502 });
    }
    options.store.setOrchestratorSession(fleet.id, result.session.id, "ready", 0);
    return { ok: true, sessionId: result.session.id };
  });
  app2.put("/api/v1/fleets/:id", async (request) => {
    requireAdmin(request);
    const current = options.store.getFleet(request.params.id);
    if (!current) throw Object.assign(new Error("fleet not found"), { statusCode: 404 });
    if (!["waiting_for_confirmation", "paused", "needs_attention"].includes(current.status)) throw Object.assign(new Error("fleet must be paused before editing"), { statusCode: 409 });
    const spec = applyDefaults(request.body.spec);
    await validateCapabilities(spec, async (id) => adapters.get(id).capabilities());
    const before = fullAccessIds(current.spec);
    const after = fullAccessIds(spec);
    const newlyPrivileged = [...after].some((id) => !before.has(id));
    if (newlyPrivileged && request.body.fullAccessConfirm !== true) throw Object.assign(new Error("new full-access agents require separate human confirmation"), { statusCode: 409 });
    options.store.setFullAccessConfirmed(current.id, after.size > 0 && (current.fullAccessConfirmed === true || request.body.fullAccessConfirm === true));
    options.store.updateSpec(current.id, spec);
    for (const worker of spec.workers) {
      const existing = options.store.listNodes(current.id).find((x) => x.nodeId === worker.id);
      if (existing) options.store.updateNode(current.id, worker.id, worker);
      else options.store.addNode(current.id, worker);
    }
    return options.store.getFleet(current.id);
  });
  app2.get("/api/v1/fleets/:id/events", async (request) => {
    requireAdmin(request);
    return options.store.listEvents(request.params.id, Number(request.query.after ?? 0));
  });
  app2.get("/api/v1/fleets/:id/report", async (request, reply) => {
    requireAdmin(request);
    const fleet = options.store.getFleet(request.params.id);
    if (!fleet) return reply.code(404).send({ error: "fleet not found" });
    const report = renderReport(fleet, options.store.listAttempts(fleet.id), options.store.listEvents(fleet.id));
    writeFileSync3(join6(options.store.fleetArtifactDir(fleet), "report.md"), report);
    return reply.type("text/markdown").send(report);
  });
  app2.post("/api/v1/fleets/:id/cleanup", async (request) => {
    requireAdmin(request);
    const fleet = options.store.getFleet(request.params.id);
    if (!fleet) throw Object.assign(new Error("fleet not found"), { statusCode: 404 });
    if (["running", "planning"].includes(fleet.status)) throw Object.assign(new Error("stop or pause the fleet before cleanup"), { statusCode: 409 });
    const manager = new WorktreeManager(fleet.repoPath, options.store.fleetArtifactDir(fleet));
    const removed = [];
    for (const attempt of options.store.listAttempts(fleet.id).filter((x) => x.branch)) {
      const path = join6(options.store.fleetArtifactDir(fleet), "worktrees", slug(attempt.nodeId), `attempt-${attempt.number}`);
      try {
        await manager.cleanupWorktree(path);
        removed.push(path);
      } catch {
      }
    }
    return { removed, branchesPreserved: true };
  });
  app2.post("/api/v1/fleets/:id/open-token", async (request) => {
    requireAdmin(request);
    return { token: options.store.issueToken({ scope: "web-once", fleetId: request.params.id }, 6e4, true) };
  });
  app2.get("/api/v1/web/exchange", async (request, reply) => {
    const cap = options.store.consumeToken(request.query.token);
    if (cap?.scope !== "web-once") return reply.code(401).send("Invalid or expired link");
    reply.setCookie("fleet_session", options.adminToken, { httpOnly: true, sameSite: "strict", path: "/" });
    return reply.redirect(`/?fleet=${encodeURIComponent(cap.fleetId ?? "")}`);
  });
  app2.get("/api/v1/fleets/:id/ws", { websocket: true }, (socket, request) => {
    try {
      requireAdmin(request);
    } catch {
      socket.close(1008, "unauthorized");
      return;
    }
    const set = sockets.get(request.params.id) ?? /* @__PURE__ */ new Set();
    set.add(socket);
    sockets.set(request.params.id, set);
    socket.on("close", () => set.delete(socket));
  });
  app2.get("/api/v1/bridge/status", async (request) => {
    const cap = requireCapability(request);
    const fleet = options.store.getFleet(cap.fleetId);
    return {
      fleet: fleet && { id: fleet.id, goal: fleet.spec.goal, status: fleet.status },
      node: cap.nodeId ? options.store.listNodes(cap.fleetId).find((x) => x.nodeId === cap.nodeId) : void 0,
      nodes: cap.scope === "orchestrator" ? options.store.listNodes(cap.fleetId) : void 0,
      attempts: cap.scope === "orchestrator" ? options.store.listAttempts(cap.fleetId) : void 0,
      messages: cap.scope === "orchestrator" ? options.store.listMessages(cap.fleetId) : void 0
    };
  });
  app2.get("/api/v1/bridge/inbox", async (request) => {
    const cap = requireCapability(request);
    const recipient = cap.scope === "orchestrator" ? "orchestrator" : cap.nodeId;
    const messages = options.store.inbox(cap.fleetId, recipient);
    for (const message of messages.filter((x) => x.status === "pending")) options.store.markMessage(message.id, "delivered");
    return messages;
  });
  app2.post("/api/v1/bridge/messages", async (request) => {
    const cap = requireCapability(request);
    const nodes = options.store.listNodes(cap.fleetId);
    if (request.body.recipient !== "orchestrator" && !nodes.some((x) => x.nodeId === request.body.recipient)) throw Object.assign(new Error("recipient does not exist"), { statusCode: 404 });
    const sender = cap.scope === "orchestrator" ? "orchestrator" : cap.nodeId;
    const message = options.store.sendMessage({ fleetId: cap.fleetId, sender, recipient: request.body.recipient, body: request.body.body });
    const event = { fleetId: cap.fleetId, nodeId: cap.nodeId, attemptId: cap.attemptId, type: "message.sent", at: (/* @__PURE__ */ new Date()).toISOString(), payload: { messageId: message.id, sender, recipient: request.body.recipient } };
    event.id = options.store.appendEvent(event);
    broadcast(event);
    if (cap.scope !== "orchestrator") void wakeOrchestrator(cap.fleetId, `Message from ${sender} to ${request.body.recipient}: ${request.body.body}`);
    else await scheduler.deliverMessage(message);
    return message;
  });
  app2.post("/api/v1/bridge/messages/:id/ack", async (request) => {
    requireCapability(request);
    options.store.markMessage(request.params.id, "acknowledged");
    return { ok: true };
  });
  app2.post("/api/v1/bridge/publish", async (request) => {
    const cap = requireCapability(request);
    if (request.body.path) {
      const attempt = options.store.listAttempts(cap.fleetId, cap.nodeId).find((x) => x.id === cap.attemptId);
      if (!attempt) throw Object.assign(new Error("attempt not found"), { statusCode: 404 });
      const target = resolve5(attempt.artifactDir, request.body.path);
      const rel = relative3(attempt.artifactDir, target);
      if (isAbsolute3(rel) || rel.startsWith("..")) throw Object.assign(new Error("artifact path escapes attempt"), { statusCode: 400 });
      if (request.body.content !== void 0) {
        mkdirSync3(dirname4(target), { recursive: true });
        writeFileSync3(target, request.body.content, "utf8");
      }
    }
    options.store.appendEvent({ fleetId: cap.fleetId, nodeId: cap.nodeId, attemptId: cap.attemptId, type: "process.output", at: (/* @__PURE__ */ new Date()).toISOString(), payload: request.body });
    return { ok: true };
  });
  app2.get("/api/v1/bridge/files", async (request) => {
    const cap = requireCapability(request);
    const target = scopedWorkspacePath(cap, request.query.path || ".");
    const info = statSync(target);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw Object.assign(new Error("file must be a regular UTF-8 file no larger than 2 MiB"), { statusCode: 400 });
    return { path: request.query.path, content: readFileSync3(target, "utf8") };
  });
  app2.get("/api/v1/bridge/files/list", async (request) => {
    const cap = requireCapability(request);
    const relativePath = request.query.path || ".";
    const target = scopedWorkspacePath(cap, relativePath);
    return { path: relativePath, entries: readdirSync(target, { withFileTypes: true }).slice(0, 1e3).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" })) };
  });
  app2.post("/api/v1/bridge/files", async (request) => {
    const cap = requireCapability(request);
    const fleet = options.store.getFleet(cap.fleetId);
    const permission = cap.scope === "orchestrator" ? options.store.getOrchestrator(fleet.id)?.permissionProfile : options.store.listNodes(fleet.id).find((x) => x.nodeId === cap.nodeId)?.spec.permission_profile;
    if (permission === "read-only") throw Object.assign(new Error("read-only capability cannot write files"), { statusCode: 403 });
    const target = scopedWorkspacePath(cap, request.body.path);
    mkdirSync3(dirname4(target), { recursive: true });
    writeFileSync3(target, request.body.content, "utf8");
    return { written: request.body.path };
  });
  app2.post("/api/v1/bridge/node-requests", async (request) => {
    const cap = requireCapability(request);
    const message = options.store.sendMessage({ fleetId: cap.fleetId, sender: cap.nodeId, recipient: "orchestrator", body: `Node request: ${JSON.stringify(request.body)}` });
    void wakeOrchestrator(cap.fleetId, message.body);
    return { accepted: true, messageId: message.id };
  });
  function scopedWorkspacePath(cap, requested) {
    const fleet = options.store.getFleet(cap.fleetId);
    if (!fleet) throw Object.assign(new Error("fleet not found"), { statusCode: 404 });
    let root = fleet.repoPath;
    if (cap.scope === "worker") {
      const node = options.store.listNodes(fleet.id).find((x) => x.nodeId === cap.nodeId);
      const attempt = options.store.listAttempts(fleet.id, cap.nodeId).find((x) => x.id === cap.attemptId);
      if (!node || !attempt) throw Object.assign(new Error("worker attempt not found"), { statusCode: 404 });
      if (node.spec.worktree) root = join6(options.store.fleetArtifactDir(fleet), "worktrees", slug(node.nodeId), `attempt-${attempt.number}`);
    }
    const rootReal = realpathSync(root);
    const lexical = resolve5(rootReal, requested);
    const rel = relative3(rootReal, lexical);
    if (isAbsolute3(rel) || rel.startsWith("..")) throw Object.assign(new Error("workspace path escapes capability root"), { statusCode: 400 });
    let cursor = rootReal;
    for (const segment of rel.split(/[\\/]/).filter(Boolean)) {
      const candidate = join6(cursor, segment);
      cursor = existsSync3(candidate) ? realpathSync(candidate) : candidate;
      const checked = relative3(rootReal, cursor);
      if (isAbsolute3(checked) || checked.startsWith("..")) throw Object.assign(new Error("workspace symlink escapes capability root"), { statusCode: 400 });
    }
    return cursor;
  }
  app2.post("/api/v1/bridge/orchestrator/nodes", async (request) => {
    const cap = requireOrchestrator(request);
    const fleet = options.store.getFleet(cap.fleetId);
    if (request.body.permission_profile === "full-access") throw Object.assign(new Error("only a human can add a full-access worker"), { statusCode: 403 });
    const spec = applyDefaults({ ...fleet.spec, workers: [...fleet.spec.workers, request.body] });
    await validateCapabilities(spec, async (id) => adapters.get(id).capabilities());
    options.store.addNode(fleet.id, request.body);
    options.store.updateSpec(fleet.id, spec);
    return { added: request.body.id };
  });
  app2.put("/api/v1/bridge/orchestrator/nodes/:node", async (request) => {
    const cap = requireOrchestrator(request);
    if (request.params.node !== request.body.id) throw Object.assign(new Error("node id cannot be changed"), { statusCode: 400 });
    if (request.body.permission_profile === "full-access") throw Object.assign(new Error("only a human can grant full access"), { statusCode: 403 });
    const fleet = options.store.getFleet(cap.fleetId);
    const workers = fleet.spec.workers.map((x) => x.id === request.params.node ? request.body : x);
    const spec = applyDefaults({ ...fleet.spec, workers });
    options.store.updateNode(fleet.id, request.params.node, request.body);
    options.store.updateSpec(fleet.id, spec);
    return { updated: request.params.node };
  });
  app2.post("/api/v1/bridge/orchestrator/control", async (request) => {
    const cap = requireOrchestrator(request);
    const { action, nodeId } = request.body;
    if (action === "pause") await scheduler.pause(cap.fleetId);
    else if (action === "resume") await scheduler.resume(cap.fleetId);
    else if (action === "kill") await scheduler.kill(cap.fleetId, nodeId);
    else if (action === "relaunch" && nodeId) await scheduler.relaunch(cap.fleetId, nodeId);
    else throw Object.assign(new Error("invalid control action"), { statusCode: 400 });
    return { ok: true };
  });
  app2.get("/api/v1/bridge/orchestrator/report", async (request) => {
    const cap = requireOrchestrator(request);
    const fleet = options.store.getFleet(cap.fleetId);
    return { markdown: renderReport(fleet, options.store.listAttempts(fleet.id), options.store.listEvents(fleet.id)) };
  });
  const webRoot = join6(packageRoot, "apps", "web", "dist");
  if (existsSync3(webRoot)) await app2.register(staticPlugin, { root: webRoot, wildcard: false });
  app2.setErrorHandler((error, _request, reply) => reply.code(error.statusCode ?? 500).send({ error: error instanceof Error ? error.message : String(error) }));
  return app2;
}
function preview(spec) {
  return {
    name: spec.fleet_name,
    goal: spec.goal,
    orchestrator: spec.orchestrator,
    workers: spec.workers.map((x) => ({ id: x.id, harness: x.harness, model: x.model, effort: x.effort, permission: x.permission_profile, worktree: x.worktree, dependsOn: x.depends_on })),
    budgets: spec.config,
    warnings: [spec.orchestrator, ...spec.workers].filter((x) => x.permission_profile === "full-access").map((x) => `${x.id ?? "orchestrator"} requests full-access`)
  };
}
function extractSpecification(message) {
  const fenced = message.match(/```(?:yaml|yml|json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const json = message.indexOf("{");
  if (json >= 0) return message.slice(json).trim();
  const yaml = message.search(/^version\s*:/m);
  return yaml >= 0 ? message.slice(yaml).trim() : message.trim();
}
function fullAccessIds(spec) {
  return /* @__PURE__ */ new Set([...spec.orchestrator.permission_profile === "full-access" ? ["orchestrator"] : [], ...spec.workers.filter((x) => x.permission_profile === "full-access").map((x) => x.id)]);
}

// apps/daemon/src/index.ts
import { writeFileSync as writeFileSync4 } from "fs";
var release = acquireDaemonLock();
var store = new FleetStore(runtimePaths.db);
var provisional = writeDescriptor(0);
var app;
try {
  app = await createServer({ store, adminToken: provisional.token });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind daemon");
  writeFileSync4(runtimePaths.descriptor, JSON.stringify({ ...provisional, port: address.port }, null, 2), { mode: 384 });
} catch (error) {
  store.close();
  clearDescriptor();
  release();
  throw error;
}
var shutdown = async () => {
  await app.close();
  store.close();
  clearDescriptor();
  release();
};
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
process.once("exit", () => {
  clearDescriptor();
  release();
});
//# sourceMappingURL=daemon.js.map