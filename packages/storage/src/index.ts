import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AttemptRecord, FleetEvent, FleetMessage, FleetRecord, FleetSpec, FleetStatus, NodeStatus } from "@harness-fleet/protocol";

const MIGRATIONS = [
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
  `ALTER TABLE fleets ADD COLUMN full_access_confirmed INTEGER NOT NULL DEFAULT 0;`,
];

export interface NodeRow {
  fleetId: string; nodeId: string; spec: FleetSpec["workers"][number]; status: NodeStatus;
  currentAttempt: number; iteration: number; lgtmCount: number; lastError?: string;
}

export type CapabilityScope = "admin" | "orchestrator" | "worker" | "web-once";
export interface Capability { scope: CapabilityScope; fleetId?: string; nodeId?: string; attemptId?: string }

export class FleetStore {
  readonly db: Database.Database;
  constructor(public readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const applied = new Set<number>(this.db.prepare("SELECT version FROM schema_migrations").all().map((x: any) => x.version));
    MIGRATIONS.forEach((sql, index) => {
      const version = index + 1;
      if (applied.has(version)) return;
      this.db.transaction(() => {
        this.db.exec(sql);
        this.db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)").run(version, new Date().toISOString());
      })();
    });
  }

  close(): void { this.db.close(); }

  createFleet(spec: FleetSpec, repoPath: string, id = randomUUID()): FleetRecord {
    const now = new Date().toISOString(); const runId = randomUUID().slice(0, 8);
    const record: FleetRecord = { id, runId, spec, repoPath: resolve(repoPath), status: "waiting_for_confirmation", createdAt: now, updatedAt: now };
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO fleets(id,run_id,spec_json,repo_path,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
        .run(id, runId, JSON.stringify(spec), record.repoPath, record.status, now, now);
      const insert = this.db.prepare("INSERT INTO nodes(fleet_id,node_id,spec_json,status) VALUES (?,?,?,'pending')");
      for (const worker of spec.workers) insert.run(id, worker.id, JSON.stringify(worker));
      this.db.prepare("INSERT INTO orchestrators(fleet_id,harness,model,effort,permission_profile,status,updated_at) VALUES (?,?,?,?,?,'ready',?)")
        .run(id, spec.orchestrator.harness, spec.orchestrator.model ?? null, spec.orchestrator.effort ?? null, spec.orchestrator.permission_profile ?? "workspace-write", now);
    })();
    mkdirSync(this.fleetArtifactDir(record), { recursive: true });
    writeFileSync(join(this.fleetArtifactDir(record), "fleet.json"), JSON.stringify(spec, null, 2));
    return record;
  }

  getFleet(id: string): FleetRecord | undefined {
    const row = this.db.prepare("SELECT * FROM fleets WHERE id=?").get(id) as any;
    return row ? this.mapFleet(row) : undefined;
  }

  listFleets(): FleetRecord[] {
    return (this.db.prepare("SELECT * FROM fleets ORDER BY created_at DESC").all() as any[]).map((x) => this.mapFleet(x));
  }

  setFleetStatus(id: string, status: FleetStatus, confirm = false): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE fleets SET status=?, confirmed_at=CASE WHEN ? THEN ? ELSE confirmed_at END, updated_at=? WHERE id=?")
      .run(status, confirm ? 1 : 0, now, now, id);
  }

  setFullAccessConfirmed(id: string, confirmed: boolean): void {
    this.db.prepare("UPDATE fleets SET full_access_confirmed=?,updated_at=? WHERE id=?").run(confirmed ? 1 : 0, new Date().toISOString(), id);
  }

  updateSpec(id: string, spec: FleetSpec): void {
    this.db.prepare("UPDATE fleets SET spec_json=?,updated_at=? WHERE id=?").run(JSON.stringify(spec), new Date().toISOString(), id);
  }

  setOrchestratorSession(fleetId: string, sessionId: string | undefined, status: string, failureCount = 0): void {
    this.db.prepare("UPDATE orchestrators SET session_id=?,status=?,failure_count=?,updated_at=? WHERE fleet_id=?")
      .run(sessionId ?? null, status, failureCount, new Date().toISOString(), fleetId);
  }

  replaceOrchestrator(fleetId: string, value: { harness: AttemptRecord["harness"]; model?: string; effort?: string; permissionProfile: string }): void {
    this.db.prepare("UPDATE orchestrators SET harness=?,model=?,effort=?,permission_profile=?,session_id=NULL,status='starting',failure_count=0,updated_at=? WHERE fleet_id=?")
      .run(value.harness, value.model ?? null, value.effort ?? null, value.permissionProfile, new Date().toISOString(), fleetId);
  }

  getOrchestrator(fleetId: string): { harness: AttemptRecord["harness"]; model?: string; effort?: string; permissionProfile: string; sessionId?: string; status: string; failureCount: number } | undefined {
    const r = this.db.prepare("SELECT * FROM orchestrators WHERE fleet_id=?").get(fleetId) as any;
    return r ? { harness: r.harness, model: r.model ?? undefined, effort: r.effort ?? undefined, permissionProfile: r.permission_profile,
      sessionId: r.session_id ?? undefined, status: r.status, failureCount: r.failure_count } : undefined;
  }

  listNodes(fleetId: string): NodeRow[] {
    return (this.db.prepare("SELECT * FROM nodes WHERE fleet_id=? ORDER BY rowid").all(fleetId) as any[]).map((r) => ({
      fleetId: r.fleet_id, nodeId: r.node_id, spec: JSON.parse(r.spec_json), status: r.status,
      currentAttempt: r.current_attempt, iteration: r.iteration, lgtmCount: r.lgtm_count, lastError: r.last_error ?? undefined,
    }));
  }

  setNodeStatus(fleetId: string, nodeId: string, status: NodeStatus, error?: string): void {
    this.db.prepare("UPDATE nodes SET status=?,last_error=? WHERE fleet_id=? AND node_id=?").run(status, error ?? null, fleetId, nodeId);
  }

  updateReviewState(fleetId: string, nodeId: string, values: { iterationDelta?: number; lgtmDelta?: number; resetLgtm?: boolean }): { iteration: number; lgtmCount: number } {
    this.db.prepare(`UPDATE nodes SET iteration=iteration+?,lgtm_count=CASE WHEN ? THEN 0 ELSE lgtm_count+? END WHERE fleet_id=? AND node_id=?`)
      .run(values.iterationDelta ?? 0, values.resetLgtm ? 1 : 0, values.lgtmDelta ?? 0, fleetId, nodeId);
    const row = this.db.prepare("SELECT iteration,lgtm_count FROM nodes WHERE fleet_id=? AND node_id=?").get(fleetId, nodeId) as any;
    return { iteration: row.iteration, lgtmCount: row.lgtm_count };
  }

  addNode(fleetId: string, spec: FleetSpec["workers"][number]): void {
    this.db.prepare("INSERT INTO nodes(fleet_id,node_id,spec_json,status) VALUES (?,?,?,'pending')").run(fleetId, spec.id, JSON.stringify(spec));
  }

  updateNode(fleetId: string, nodeId: string, spec: FleetSpec["workers"][number]): void {
    const row = this.db.prepare("SELECT status FROM nodes WHERE fleet_id=? AND node_id=?").get(fleetId, nodeId) as any;
    if (!row || !["pending", "ready", "failed", "needs_attention"].includes(row.status)) throw new Error("only non-running nodes may be edited");
    this.db.prepare("UPDATE nodes SET spec_json=? WHERE fleet_id=? AND node_id=?").run(JSON.stringify(spec), fleetId, nodeId);
  }

  createAttempt(fleet: FleetRecord, nodeId: string, harness: AttemptRecord["harness"], branch?: string): AttemptRecord {
    return this.db.transaction(() => {
      const node = this.db.prepare("SELECT current_attempt FROM nodes WHERE fleet_id=? AND node_id=?").get(fleet.id, nodeId) as any;
      if (!node) throw new Error(`unknown node ${nodeId}`);
      const number = Number(node.current_attempt) + 1; const id = randomUUID();
      const artifactDir = join(this.fleetArtifactDir(fleet), "workers", nodeId, "attempts", String(number));
      mkdirSync(dirname(artifactDir), { recursive: true });
      mkdirSync(artifactDir, { recursive: false });
      this.db.prepare("UPDATE nodes SET current_attempt=?,status='running' WHERE fleet_id=? AND node_id=?").run(number, fleet.id, nodeId);
      this.db.prepare("INSERT INTO attempts(id,fleet_id,node_id,number,harness,status,artifact_dir,branch) VALUES (?,?,?,?,?,'running',?,?)")
        .run(id, fleet.id, nodeId, number, harness, artifactDir, branch ?? null);
      return { id, fleetId: fleet.id, nodeId, number, harness, status: "running" as const, artifactDir, branch, costQuality: "unavailable" as const };
    })();
  }

  startAttempt(id: string, sessionId?: string, pid?: number): void {
    this.db.prepare("UPDATE attempts SET session_id=COALESCE(?,session_id),pid=COALESCE(?,pid),started_at=COALESCE(started_at,?) WHERE id=?")
      .run(sessionId ?? null, pid ?? null, new Date().toISOString(), id);
  }

  setAttemptSession(id: string, sessionId: string): void {
    this.db.prepare("UPDATE attempts SET session_id=? WHERE id=?").run(sessionId, id);
  }

  finishAttempt(id: string, status: NodeStatus, result: { exitCode?: number | null; error?: string; costUsd?: number; costQuality?: string } = {}): void {
    this.db.transaction(() => {
      const attempt = this.db.prepare("SELECT fleet_id,node_id FROM attempts WHERE id=?").get(id) as any;
      if (!attempt) return;
      this.db.prepare("UPDATE attempts SET status=?,finished_at=?,exit_code=?,error=?,cost_usd=COALESCE(?,cost_usd),cost_quality=COALESCE(?,cost_quality) WHERE id=?")
        .run(status, new Date().toISOString(), result.exitCode ?? null, result.error ?? null, result.costUsd ?? null, result.costQuality ?? null, id);
      this.setNodeStatus(attempt.fleet_id, attempt.node_id, status, result.error);
    })();
  }

  updateAttemptCost(id: string, costUsd: number, quality: string): void {
    this.db.prepare("UPDATE attempts SET cost_usd=?,cost_quality=? WHERE id=?").run(costUsd, quality, id);
  }

  listAttempts(fleetId: string, nodeId?: string): AttemptRecord[] {
    const rows = nodeId
      ? this.db.prepare("SELECT * FROM attempts WHERE fleet_id=? AND node_id=? ORDER BY number").all(fleetId, nodeId)
      : this.db.prepare("SELECT * FROM attempts WHERE fleet_id=? ORDER BY node_id,number").all(fleetId);
    return (rows as any[]).map((r) => ({
      id: r.id, fleetId: r.fleet_id, nodeId: r.node_id, number: r.number, harness: r.harness, status: r.status,
      sessionId: r.session_id ?? undefined, pid: r.pid ?? undefined, artifactDir: r.artifact_dir, branch: r.branch ?? undefined,
      startedAt: r.started_at ?? undefined, finishedAt: r.finished_at ?? undefined, exitCode: r.exit_code ?? undefined,
      error: r.error ?? undefined, costUsd: r.cost_usd ?? undefined, costQuality: r.cost_quality,
    }));
  }

  appendEvent(event: FleetEvent): number {
    const result = this.db.prepare("INSERT INTO events(fleet_id,node_id,attempt_id,type,at,payload_json,raw_json) VALUES (?,?,?,?,?,?,?)")
      .run(event.fleetId, event.nodeId ?? null, event.attemptId ?? null, event.type, event.at, JSON.stringify(event.payload), event.raw === undefined ? null : JSON.stringify(event.raw));
    return Number(result.lastInsertRowid);
  }

  listEvents(fleetId: string, after = 0, limit = 1000): FleetEvent[] {
    return (this.db.prepare("SELECT * FROM events WHERE fleet_id=? AND id>? ORDER BY id LIMIT ?").all(fleetId, after, limit) as any[]).map((r) => ({
      id: r.id, fleetId: r.fleet_id, nodeId: r.node_id ?? undefined, attemptId: r.attempt_id ?? undefined,
      type: r.type, at: r.at, payload: JSON.parse(r.payload_json), raw: r.raw_json ? JSON.parse(r.raw_json) : undefined,
    }));
  }

  sendMessage(message: Omit<FleetMessage, "id" | "status" | "createdAt">): FleetMessage {
    const value: FleetMessage = { ...message, id: randomUUID(), status: "pending", createdAt: new Date().toISOString() };
    this.db.prepare("INSERT INTO messages(id,fleet_id,sender,recipient,body,status,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(value.id, value.fleetId, value.sender, value.recipient, value.body, value.status, value.createdAt);
    return value;
  }

  inbox(fleetId: string, recipient: string): FleetMessage[] {
    return (this.db.prepare("SELECT * FROM messages WHERE fleet_id=? AND recipient=? AND status IN ('pending','delivered') ORDER BY created_at,id").all(fleetId, recipient) as any[])
      .map((r) => this.mapMessage(r));
  }

  listMessages(fleetId: string): FleetMessage[] {
    return (this.db.prepare("SELECT * FROM messages WHERE fleet_id=? ORDER BY created_at,id").all(fleetId) as any[]).map((r) => this.mapMessage(r));
  }

  markMessage(id: string, status: "delivered" | "acknowledged" | "rejected"): void {
    const column = status === "delivered" ? "delivered_at" : status === "acknowledged" ? "acknowledged_at" : undefined;
    if (column) this.db.prepare(`UPDATE messages SET status=?,${column}=? WHERE id=?`).run(status, new Date().toISOString(), id);
    else this.db.prepare("UPDATE messages SET status=? WHERE id=?").run(status, id);
  }

  issueToken(capability: Capability, ttlMs: number, oneTime = false): string {
    const token = randomBytes(32).toString("base64url"); const hash = createHash("sha256").update(token).digest("hex");
    this.db.prepare("INSERT INTO capability_tokens(token_hash,scope,fleet_id,node_id,attempt_id,expires_at,one_time) VALUES (?,?,?,?,?,?,?)")
      .run(hash, capability.scope, capability.fleetId ?? null, capability.nodeId ?? null, capability.attemptId ?? null, Date.now() + ttlMs, oneTime ? 1 : 0);
    return token;
  }

  consumeToken(token: string): Capability | undefined {
    const hash = createHash("sha256").update(token).digest("hex");
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM capability_tokens WHERE token_hash=?").get(hash) as any;
      if (!row || row.expires_at < Date.now() || (row.one_time && row.consumed_at)) return undefined;
      if (row.one_time) this.db.prepare("UPDATE capability_tokens SET consumed_at=? WHERE token_hash=?").run(Date.now(), hash);
      return { scope: row.scope, fleetId: row.fleet_id ?? undefined, nodeId: row.node_id ?? undefined, attemptId: row.attempt_id ?? undefined };
    })();
  }

  acquireLease(fleetId: string, owner: string, ttlMs = 15_000): boolean {
    const now = Date.now();
    const result = this.db.prepare("UPDATE fleets SET lease_owner=?,lease_until=? WHERE id=? AND (lease_owner IS NULL OR lease_owner=? OR lease_until<?)")
      .run(owner, now + ttlMs, fleetId, owner, now);
    return result.changes === 1;
  }

  releaseLease(fleetId: string, owner: string): void {
    this.db.prepare("UPDATE fleets SET lease_owner=NULL,lease_until=NULL WHERE id=? AND lease_owner=?").run(fleetId, owner);
  }

  getSettings(): Record<string, unknown> {
    return Object.fromEntries((this.db.prepare("SELECT key,value_json FROM settings ORDER BY key").all() as any[]).map((r) => [r.key, JSON.parse(r.value_json)]));
  }

  setSetting(key: string, value: unknown): void {
    this.db.prepare("INSERT INTO settings(key,value_json) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json")
      .run(key, JSON.stringify(value));
  }

  recoverRunning(): Array<{ fleetId: string; nodeId: string; attemptId: string; pid?: number }> {
    return (this.db.prepare("SELECT id,fleet_id,node_id,pid FROM attempts WHERE status='running'").all() as any[])
      .map((r) => ({ fleetId: r.fleet_id, nodeId: r.node_id, attemptId: r.id, pid: r.pid ?? undefined }));
  }

  fleetArtifactDir(fleet: Pick<FleetRecord, "id" | "repoPath">): string { return join(fleet.repoPath, ".fleet", fleet.id); }

  private mapFleet(r: any): FleetRecord {
    return { id: r.id, runId: r.run_id, spec: JSON.parse(r.spec_json), repoPath: r.repo_path, status: r.status,
      confirmedAt: r.confirmed_at ?? undefined, fullAccessConfirmed: Boolean(r.full_access_confirmed), createdAt: r.created_at, updatedAt: r.updated_at };
  }
  private mapMessage(r: any): FleetMessage {
    return { id: r.id, fleetId: r.fleet_id, sender: r.sender, recipient: r.recipient, body: r.body, status: r.status,
      createdAt: r.created_at, deliveredAt: r.delivered_at ?? undefined, acknowledgedAt: r.acknowledged_at ?? undefined };
  }
}

export function ensureDaemonSecret(path: string): string {
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  mkdirSync(dirname(path), { recursive: true });
  const secret = randomBytes(32).toString("base64url"); writeFileSync(path, secret, { mode: 0o600 }); return secret;
}
