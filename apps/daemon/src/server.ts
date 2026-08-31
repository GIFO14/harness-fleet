import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import cookie from "@fastify/cookie";
import staticPlugin from "@fastify/static";
import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { Capability, FleetStore } from "@harness-fleet/storage";
import { parseFleetSpec, applyDefaults, renderReport, FleetScheduler, orchestratorPrompt, validateCapabilities } from "@harness-fleet/core";
import { WorktreeManager, slug } from "@harness-fleet/git-workspaces";
import { PiAdapter } from "@harness-fleet/adapter-pi";
import { ClaudeCodeAdapter } from "@harness-fleet/adapter-claude-code";
import { CodexAdapter } from "@harness-fleet/adapter-codex";
import type { FleetEvent, FleetSpec, HarnessAdapter, HarnessId, SessionRef } from "@harness-fleet/protocol";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = existsSync(join(moduleDir, "..", "package.json")) ? resolve(moduleDir, "..") : resolve(moduleDir, "../../..");
const distDir = join(packageRoot, "dist");

export interface ServerOptions { store: FleetStore; adminToken: string; host?: string; port?: number }

export async function createServer(options: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cookie, { secret: options.adminToken });
  await app.register(websocket);
  const adapters = new Map<HarnessId, HarnessAdapter>([["pi", new PiAdapter()], ["claude-code", new ClaudeCodeAdapter()], ["codex", new CodexAdapter()]]);
  for (const orphan of options.store.recoverRunning()) {
    if (orphan.pid) {
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(orphan.pid), "/T", "/F"], { windowsHide: true });
      else { try { process.kill(-orphan.pid, "SIGKILL"); } catch { /* process already ended */ } }
    }
    options.store.finishAttempt(orphan.attemptId, "pending", { error: "recovered after daemon restart; orphaned process reconciled" });
  }
  const sockets = new Map<string, Set<any>>();
  const orchestratorBusy = new Set<string>();
  const broadcast = (event: FleetEvent) => {
    const data = JSON.stringify(event); for (const socket of sockets.get(event.fleetId) ?? []) if (socket.readyState === 1) socket.send(data);
  };
  const scheduler = new FleetScheduler({
    owner: `daemon-${process.pid}`, adapters, store: options.store,
    canDispatch: (fleet) => options.store.getOrchestrator(fleet.id)?.status === "ready",
    onEvent: async (event) => {
      broadcast(event);
      if (event.nodeId !== "orchestrator" && (["node.status", "contract.failed", "review.verdict", "approval.blocked", "error"].includes(event.type) || (event.type === "fleet.status" && event.payload.status === "needs_attention"))) void wakeOrchestrator(event.fleetId, `Fleet event ${event.type}: ${JSON.stringify(event.payload)}`);
    },
    workspace: async (fleet, node, attempt) => {
      if (!node.spec.worktree) return { cwd: fleet.repoPath };
      const manager = new WorktreeManager(fleet.repoPath, options.store.fleetArtifactDir(fleet));
      const created = await manager.create(fleet.spec.fleet_name, fleet.runId, node.nodeId, attempt);
      return { cwd: created.path, branch: created.branch };
    },
    bridge: async (fleet, node, attempt) => {
      const token = options.store.issueToken({ scope: "worker", fleetId: fleet.id, nodeId: node.nodeId, attemptId: attempt.id }, 24 * 60 * 60_000);
      const isPi = node.spec.harness === "pi";
      return {
        command: process.execPath,
        args: [join(distDir, isPi ? "bridge-pi.js" : "bridge-mcp.js")],
        env: { HARNESS_FLEET_URL: `http://127.0.0.1:${(app.server.address() as any)?.port ?? options.port ?? 0}`, HARNESS_FLEET_TOKEN: token },
      };
    },
  });
  app.addHook("onReady", async () => {
    for (const fleet of options.store.listFleets().filter((x) => x.status === "running")) void scheduler.tick(fleet.id);
  });

  async function wakeOrchestrator(fleetId: string, reason: string): Promise<void> {
    if (orchestratorBusy.has(fleetId)) return;
    const fleet = options.store.getFleet(fleetId); const state = options.store.getOrchestrator(fleetId);
    if (!fleet || !state?.sessionId || ["completed", "failed", "cancelled", "waiting_for_confirmation"].includes(fleet.status)) return;
    const adapter = adapters.get(state.harness); if (!adapter) return;
    orchestratorBusy.add(fleetId); options.store.setOrchestratorSession(fleetId, state.sessionId, "resuming", state.failureCount);
    try {
      let lastError = "orchestrator resume failed";
      for (const delay of [1_000, 2_000, 4_000]) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
        try {
          const handle = await adapter.resume({ id: state.sessionId, harness: state.harness, cwd: fleet.repoPath } as SessionRef, reason, async (event) => {
            const normalized = { ...event, fleetId, nodeId: "orchestrator" }; const id = options.store.appendEvent(normalized); broadcast({ ...normalized, id });
          });
          const result = await handle.settled;
          if (result.exitCode === 0) { options.store.setOrchestratorSession(fleetId, result.session?.id ?? state.sessionId, "ready", 0); await scheduler.tick(fleetId); return; }
          lastError = result.error ?? lastError;
        } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
      }
      options.store.setOrchestratorSession(fleetId, state.sessionId, "unavailable", state.failureCount + 3);
      options.store.setFleetStatus(fleetId, "paused_orchestrator_unavailable");
      const event: FleetEvent = { fleetId, nodeId: "orchestrator", type: "fleet.status", at: new Date().toISOString(), payload: { status: "paused_orchestrator_unavailable", error: lastError } };
      event.id = options.store.appendEvent(event); broadcast(event);
    } finally { orchestratorBusy.delete(fleetId); }
  }

  const bearer = (request: FastifyRequest): string | undefined => {
    const header = request.headers.authorization; return header?.startsWith("Bearer ") ? header.slice(7) : request.cookies.fleet_session;
  };
  const requireAdmin = (request: FastifyRequest): void => { if (bearer(request) !== options.adminToken) throw Object.assign(new Error("unauthorized"), { statusCode: 401 }); };
  const requireCapability = (request: FastifyRequest): Capability => {
    const token = bearer(request); const capability = token ? options.store.consumeToken(token) : undefined;
    if (!capability || !["worker", "orchestrator"].includes(capability.scope)) throw Object.assign(new Error("invalid capability token"), { statusCode: 401 });
    return capability;
  };
  const requireOrchestrator = (request: FastifyRequest): Capability => {
    const capability = requireCapability(request); if (capability.scope !== "orchestrator") throw Object.assign(new Error("orchestrator capability required"), { statusCode: 403 }); return capability;
  };

  app.get("/api/v1/health", async () => ({ ok: true, pid: process.pid, version: "0.1.0" }));
  app.get("/api/v1/openapi.yaml", async (_request, reply) => reply.type("application/yaml").send(readFileSync(join(packageRoot, "docs", "openapi.yaml"), "utf8")));
  app.get("/api/v1/doctor", async (request) => {
    requireAdmin(request);
    const probes = await Promise.all([...adapters.values()].map(async (adapter) => ({ id: adapter.id, probe: await adapter.probe(), capabilities: await adapter.capabilities() })));
    return { daemon: { ok: true }, node: process.version, database: options.store.path, harnesses: probes };
  });
  app.post("/api/v1/shutdown", async (request) => { requireAdmin(request); setTimeout(() => process.kill(process.pid, "SIGTERM"), 20); return { ok: true }; });
  app.get("/api/v1/config", async (request) => { requireAdmin(request); return options.store.getSettings(); });
  app.post<{ Body: { key: string; value: unknown } }>("/api/v1/config", async (request) => { requireAdmin(request); options.store.setSetting(request.body.key, request.body.value); return { ok: true }; });
  app.get("/api/v1/fleets", async (request) => { requireAdmin(request); return options.store.listFleets(); });
  app.get<{ Params: { id: string } }>("/api/v1/fleets/:id", async (request) => {
    requireAdmin(request); const fleet = options.store.getFleet(request.params.id); if (!fleet) throw Object.assign(new Error("fleet not found"), { statusCode: 404 });
    return { ...fleet, nodes: options.store.listNodes(fleet.id), attempts: options.store.listAttempts(fleet.id), orchestrator: options.store.getOrchestrator(fleet.id),
      events: options.store.listEvents(fleet.id), messages: options.store.listMessages(fleet.id) };
  });
  app.post<{ Body: { spec: FleetSpec | string; format?: "yaml" | "json"; repoPath?: string } }>("/api/v1/fleets", async (request) => {
    requireAdmin(request); const spec = typeof request.body.spec === "string" ? parseFleetSpec(request.body.spec, request.body.format) : applyDefaults(request.body.spec);
    await validateCapabilities(spec, async (id) => (await adapters.get(id)!.capabilities()));
    return options.store.createFleet(spec, request.body.repoPath ?? process.cwd());
  });
  app.post<{ Body: { goal: string; orchestrator: HarnessId; model?: string; effort?: any; repoPath?: string } }>("/api/v1/fleets/design", async (request) => {
    requireAdmin(request); const adapter = adapters.get(request.body.orchestrator); if (!adapter) throw Object.assign(new Error("unsupported orchestrator"), { statusCode: 400 });
    const id = randomUUID(); const cwd = resolve(request.body.repoPath ?? process.cwd()); const attempt = randomUUID();
    let sessionId: string | undefined;
    const orchestratorToken = options.store.issueToken({ scope: "orchestrator", fleetId: id }, 7 * 24 * 60 * 60_000);
    const isPi = request.body.orchestrator === "pi";
    const bridge = { command: process.execPath, args: [join(distDir, isPi ? "bridge-pi.js" : "bridge-mcp.js")],
      env: { HARNESS_FLEET_URL: `http://127.0.0.1:${(app.server.address() as any)?.port ?? options.port ?? 0}`, HARNESS_FLEET_TOKEN: orchestratorToken } };
    const handle = await adapter.start({ fleetId: id, nodeId: "orchestrator", attemptId: attempt, cwd, prompt: orchestratorPrompt(request.body.goal),
      model: request.body.model, effort: request.body.effort, permissionProfile: "workspace-write", bridge }, (event) => { sessionId = String(event.payload.sessionId ?? sessionId ?? "") || undefined; });
    const result = await handle.settled; if (result.exitCode !== 0 || !result.finalMessage) throw Object.assign(new Error(result.error ?? "orchestrator did not return a plan"), { statusCode: 502 });
    const clean = extractSpecification(result.finalMessage);
    const spec = parseFleetSpec(clean); spec.goal = request.body.goal; spec.orchestrator = { harness: request.body.orchestrator, model: request.body.model, effort: request.body.effort, permission_profile: "workspace-write" };
    await validateCapabilities(spec, async (h) => adapters.get(h)!.capabilities());
    const fleet = options.store.createFleet(spec, cwd, id); options.store.setOrchestratorSession(id, result.session?.id ?? sessionId, "ready");
    return { fleet, preview: preview(spec) };
  });
  app.post<{ Params: { id: string }; Body: { confirm: boolean; fullAccessConfirm?: boolean } }>("/api/v1/fleets/:id/launch", async (request) => {
    requireAdmin(request); if (request.body.confirm !== true) throw Object.assign(new Error("human confirmation is required"), { statusCode: 409 });
    const fleet = options.store.getFleet(request.params.id); const state = options.store.getOrchestrator(request.params.id);
    if (!fleet || !state) throw Object.assign(new Error("fleet not found"), { statusCode: 404 });
    if (!state.sessionId) {
      const adapter = adapters.get(state.harness)!; const token = options.store.issueToken({ scope: "orchestrator", fleetId: fleet.id }, 7 * 24 * 60 * 60_000); const isPi = state.harness === "pi";
      const bridge = { command: process.execPath, args: [join(distDir, isPi ? "bridge-pi.js" : "bridge-mcp.js")], env: { HARNESS_FLEET_URL: `http://127.0.0.1:${(app.server.address() as any)?.port ?? options.port ?? 0}`, HARNESS_FLEET_TOKEN: token } };
      const handle = await adapter.start({ fleetId: fleet.id, nodeId: "orchestrator", attemptId: randomUUID(), cwd: fleet.repoPath,
        prompt: `Operate this human-approved fleet. Goal: ${fleet.spec.goal}\nPlan: ${JSON.stringify(fleet.spec)}`, model: state.model, effort: state.effort as any,
        permissionProfile: state.permissionProfile as any, bridge }, (event) => { const id = options.store.appendEvent(event); broadcast({ ...event, id }); });
      const result = await handle.settled; if (result.exitCode !== 0 || !result.session) throw Object.assign(new Error(result.error ?? "orchestrator failed to start"), { statusCode: 502 });
      options.store.setOrchestratorSession(fleet.id, result.session.id, "ready", 0);
    }
    await scheduler.confirmAndLaunch(request.params.id, request.body.fullAccessConfirm === true); return { ok: true };
  });
  app.post<{ Params: { id: string } }>("/api/v1/fleets/:id/pause", async (request) => { requireAdmin(request); await scheduler.pause(request.params.id); return { ok: true }; });
  app.post<{ Params: { id: string } }>("/api/v1/fleets/:id/resume", async (request) => {
    requireAdmin(request); const fleet = options.store.getFleet(request.params.id); if (!fleet) throw Object.assign(new Error("fleet not found"), { statusCode: 404 });
    if (fullAccessIds(fleet.spec).size && !fleet.fullAccessConfirmed) throw Object.assign(new Error("full access has not been confirmed for this plan"), { statusCode: 409 });
    await scheduler.resume(request.params.id); return { ok: true };
  });
  app.post<{ Params: { id: string }; Body: { nodeId?: string; graceMs?: number } }>("/api/v1/fleets/:id/kill", async (request) => {
    requireAdmin(request); await scheduler.kill(request.params.id, request.body.nodeId, request.body.graceMs ?? 5_000); return { ok: true };
  });
  app.post<{ Params: { id: string; node: string }; Body: { harness?: HarnessId; model?: string } }>("/api/v1/fleets/:id/relaunch/:node", async (request) => {
    requireAdmin(request); const fleet = options.store.getFleet(request.params.id); if (!fleet) throw Object.assign(new Error("fleet not found"), { statusCode: 404 });
    const worker = fleet.spec.workers.find((x) => x.id === request.params.node); if (!worker) throw Object.assign(new Error("worker not found"), { statusCode: 404 });
    if (request.body?.harness || request.body?.model) {
      const changed = { ...worker, harness: request.body.harness ?? worker.harness, model: request.body.model ?? worker.model };
      const spec = applyDefaults({ ...fleet.spec, workers: fleet.spec.workers.map((x) => x.id === worker.id ? changed : x) });
      await validateCapabilities(spec, async (id) => adapters.get(id)!.capabilities()); options.store.updateNode(fleet.id, worker.id, changed); options.store.updateSpec(fleet.id, spec);
    }
    await scheduler.relaunch(request.params.id, request.params.node); return { ok: true };
  });
  app.put<{ Params: { id: string }; Body: { harness: HarnessId; model?: string; effort?: any } }>("/api/v1/fleets/:id/orchestrator", async (request) => {
    requireAdmin(request); const fleet = options.store.getFleet(request.params.id); const adapter = adapters.get(request.body.harness);
    if (!fleet || !adapter) throw Object.assign(new Error("fleet or harness not found"), { statusCode: 404 });
    const caps = await adapter.capabilities(); if (request.body.effort && !caps.efforts.includes(request.body.effort)) throw Object.assign(new Error("unsupported orchestrator effort"), { statusCode: 400 });
    const orchestrator = { harness: request.body.harness, model: request.body.model, effort: request.body.effort, permission_profile: "workspace-write" as const };
    const spec = { ...fleet.spec, orchestrator }; await validateCapabilities(spec, async (id) => adapters.get(id)!.capabilities());
    options.store.updateSpec(fleet.id, spec); options.store.replaceOrchestrator(fleet.id, { ...orchestrator, permissionProfile: "workspace-write" });
    const token = options.store.issueToken({ scope: "orchestrator", fleetId: fleet.id }, 7 * 24 * 60 * 60_000); const isPi = orchestrator.harness === "pi";
    const bridge = { command: process.execPath, args: [join(distDir, isPi ? "bridge-pi.js" : "bridge-mcp.js")], env: { HARNESS_FLEET_URL: `http://127.0.0.1:${(app.server.address() as any)?.port ?? options.port ?? 0}`, HARNESS_FLEET_TOKEN: token } };
    const handle = await adapter.start({ fleetId: fleet.id, nodeId: "orchestrator", attemptId: randomUUID(), cwd: fleet.repoPath,
      prompt: `Take over this existing Harness Fleet. Goal: ${fleet.spec.goal}\nCurrent nodes: ${JSON.stringify(options.store.listNodes(fleet.id))}`,
      model: orchestrator.model, effort: orchestrator.effort, permissionProfile: "workspace-write", bridge }, (event) => { const id = options.store.appendEvent(event); broadcast({ ...event, id }); });
    const result = await handle.settled; if (result.exitCode !== 0 || !result.session) { options.store.setOrchestratorSession(fleet.id, undefined, "unavailable", 1); throw Object.assign(new Error(result.error ?? "replacement orchestrator failed"), { statusCode: 502 }); }
    options.store.setOrchestratorSession(fleet.id, result.session.id, "ready", 0); return { ok: true, sessionId: result.session.id };
  });
  app.put<{ Params: { id: string }; Body: { spec: FleetSpec; fullAccessConfirm?: boolean } }>("/api/v1/fleets/:id", async (request) => {
    requireAdmin(request); const current = options.store.getFleet(request.params.id); if (!current) throw Object.assign(new Error("fleet not found"), { statusCode: 404 });
    if (!["waiting_for_confirmation", "paused", "needs_attention"].includes(current.status)) throw Object.assign(new Error("fleet must be paused before editing"), { statusCode: 409 });
    const spec = applyDefaults(request.body.spec); await validateCapabilities(spec, async (id) => adapters.get(id)!.capabilities());
    const before = fullAccessIds(current.spec); const after = fullAccessIds(spec); const newlyPrivileged = [...after].some((id) => !before.has(id));
    if (newlyPrivileged && request.body.fullAccessConfirm !== true) throw Object.assign(new Error("new full-access agents require separate human confirmation"), { statusCode: 409 });
    options.store.setFullAccessConfirmed(current.id, after.size > 0 && (current.fullAccessConfirmed === true || request.body.fullAccessConfirm === true));
    options.store.updateSpec(current.id, spec);
    for (const worker of spec.workers) {
      const existing = options.store.listNodes(current.id).find((x) => x.nodeId === worker.id);
      if (existing) options.store.updateNode(current.id, worker.id, worker); else options.store.addNode(current.id, worker);
    }
    return options.store.getFleet(current.id);
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/v1/fleets/:id/events", async (request) => {
    requireAdmin(request); return options.store.listEvents(request.params.id, Number(request.query.after ?? 0));
  });
  app.get<{ Params: { id: string } }>("/api/v1/fleets/:id/report", async (request, reply) => {
    requireAdmin(request); const fleet = options.store.getFleet(request.params.id); if (!fleet) return reply.code(404).send({ error: "fleet not found" });
    const report = renderReport(fleet, options.store.listAttempts(fleet.id), options.store.listEvents(fleet.id)); writeFileSync(join(options.store.fleetArtifactDir(fleet), "report.md"), report);
    return reply.type("text/markdown").send(report);
  });
  app.post<{ Params: { id: string } }>("/api/v1/fleets/:id/cleanup", async (request) => {
    requireAdmin(request); const fleet = options.store.getFleet(request.params.id); if (!fleet) throw Object.assign(new Error("fleet not found"), { statusCode: 404 });
    if (["running", "planning"].includes(fleet.status)) throw Object.assign(new Error("stop or pause the fleet before cleanup"), { statusCode: 409 });
    const manager = new WorktreeManager(fleet.repoPath, options.store.fleetArtifactDir(fleet)); const removed: string[] = [];
    for (const attempt of options.store.listAttempts(fleet.id).filter((x) => x.branch)) {
      const path = join(options.store.fleetArtifactDir(fleet), "worktrees", slug(attempt.nodeId), `attempt-${attempt.number}`);
      try { await manager.cleanupWorktree(path); removed.push(path); } catch { /* absent or already cleaned */ }
    }
    return { removed, branchesPreserved: true };
  });
  app.post<{ Params: { id: string } }>("/api/v1/fleets/:id/open-token", async (request) => {
    requireAdmin(request); return { token: options.store.issueToken({ scope: "web-once", fleetId: request.params.id }, 60_000, true) };
  });
  app.get<{ Querystring: { token: string } }>("/api/v1/web/exchange", async (request, reply) => {
    const cap = options.store.consumeToken(request.query.token); if (cap?.scope !== "web-once") return reply.code(401).send("Invalid or expired link");
    reply.setCookie("fleet_session", options.adminToken, { httpOnly: true, sameSite: "strict", path: "/" });
    return reply.redirect(`/?fleet=${encodeURIComponent(cap.fleetId ?? "")}`);
  });
  app.get<{ Params: { id: string } }>("/api/v1/fleets/:id/ws", { websocket: true }, (socket, request) => {
    try { requireAdmin(request); } catch { socket.close(1008, "unauthorized"); return; }
    const set = sockets.get(request.params.id) ?? new Set(); set.add(socket); sockets.set(request.params.id, set);
    socket.on("close", () => set.delete(socket));
  });

  app.get("/api/v1/bridge/status", async (request) => {
    const cap = requireCapability(request); const fleet = options.store.getFleet(cap.fleetId!);
    return { fleet: fleet && { id: fleet.id, goal: fleet.spec.goal, status: fleet.status },
      node: cap.nodeId ? options.store.listNodes(cap.fleetId!).find((x) => x.nodeId === cap.nodeId) : undefined,
      nodes: cap.scope === "orchestrator" ? options.store.listNodes(cap.fleetId!) : undefined,
      attempts: cap.scope === "orchestrator" ? options.store.listAttempts(cap.fleetId!) : undefined,
      messages: cap.scope === "orchestrator" ? options.store.listMessages(cap.fleetId!) : undefined };
  });
  app.get("/api/v1/bridge/inbox", async (request) => {
    const cap = requireCapability(request); const recipient = cap.scope === "orchestrator" ? "orchestrator" : cap.nodeId!;
    const messages = options.store.inbox(cap.fleetId!, recipient); for (const message of messages.filter((x) => x.status === "pending")) options.store.markMessage(message.id, "delivered");
    return messages;
  });
  app.post<{ Body: { recipient: string; body: string } }>("/api/v1/bridge/messages", async (request) => {
    const cap = requireCapability(request); const nodes = options.store.listNodes(cap.fleetId!);
    if (request.body.recipient !== "orchestrator" && !nodes.some((x) => x.nodeId === request.body.recipient)) throw Object.assign(new Error("recipient does not exist"), { statusCode: 404 });
    const sender = cap.scope === "orchestrator" ? "orchestrator" : cap.nodeId!;
    const message = options.store.sendMessage({ fleetId: cap.fleetId!, sender, recipient: request.body.recipient, body: request.body.body });
    const event: FleetEvent = { fleetId: cap.fleetId!, nodeId: cap.nodeId, attemptId: cap.attemptId, type: "message.sent", at: new Date().toISOString(), payload: { messageId: message.id, sender, recipient: request.body.recipient } };
    event.id = options.store.appendEvent(event); broadcast(event);
    if (cap.scope !== "orchestrator") void wakeOrchestrator(cap.fleetId!, `Message from ${sender} to ${request.body.recipient}: ${request.body.body}`);
    else await scheduler.deliverMessage(message);
    return message;
  });
  app.post<{ Params: { id: string } }>("/api/v1/bridge/messages/:id/ack", async (request) => { requireCapability(request); options.store.markMessage(request.params.id, "acknowledged"); return { ok: true }; });
  app.post<{ Body: { status?: string; path?: string; content?: string; note?: string } }>("/api/v1/bridge/publish", async (request) => {
    const cap = requireCapability(request);
    if (request.body.path) {
      const attempt = options.store.listAttempts(cap.fleetId!, cap.nodeId).find((x) => x.id === cap.attemptId); if (!attempt) throw Object.assign(new Error("attempt not found"), { statusCode: 404 });
      const target = resolve(attempt.artifactDir, request.body.path); const rel = relative(attempt.artifactDir, target);
      if (isAbsolute(rel) || rel.startsWith("..")) throw Object.assign(new Error("artifact path escapes attempt"), { statusCode: 400 });
      if (request.body.content !== undefined) { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, request.body.content, "utf8"); }
    }
    options.store.appendEvent({ fleetId: cap.fleetId!, nodeId: cap.nodeId, attemptId: cap.attemptId, type: "process.output", at: new Date().toISOString(), payload: request.body });
    return { ok: true };
  });
  app.get<{ Querystring: { path: string } }>("/api/v1/bridge/files", async (request) => {
    const cap = requireCapability(request); const target = scopedWorkspacePath(cap, request.query.path || "."); const info = statSync(target);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw Object.assign(new Error("file must be a regular UTF-8 file no larger than 2 MiB"), { statusCode: 400 });
    return { path: request.query.path, content: readFileSync(target, "utf8") };
  });
  app.get<{ Querystring: { path?: string } }>("/api/v1/bridge/files/list", async (request) => {
    const cap = requireCapability(request); const relativePath = request.query.path || "."; const target = scopedWorkspacePath(cap, relativePath);
    return { path: relativePath, entries: readdirSync(target, { withFileTypes: true }).slice(0, 1000).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" })) };
  });
  app.post<{ Body: { path: string; content: string } }>("/api/v1/bridge/files", async (request) => {
    const cap = requireCapability(request); const fleet = options.store.getFleet(cap.fleetId!)!;
    const permission = cap.scope === "orchestrator" ? options.store.getOrchestrator(fleet.id)?.permissionProfile : options.store.listNodes(fleet.id).find((x) => x.nodeId === cap.nodeId)?.spec.permission_profile;
    if (permission === "read-only") throw Object.assign(new Error("read-only capability cannot write files"), { statusCode: 403 });
    const target = scopedWorkspacePath(cap, request.body.path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, request.body.content, "utf8"); return { written: request.body.path };
  });
  app.post<{ Body: Record<string, unknown> }>("/api/v1/bridge/node-requests", async (request) => {
    const cap = requireCapability(request); const message = options.store.sendMessage({ fleetId: cap.fleetId!, sender: cap.nodeId!, recipient: "orchestrator", body: `Node request: ${JSON.stringify(request.body)}` });
    void wakeOrchestrator(cap.fleetId!, message.body);
    return { accepted: true, messageId: message.id };
  });

  function scopedWorkspacePath(cap: Capability, requested: string): string {
    const fleet = options.store.getFleet(cap.fleetId!); if (!fleet) throw Object.assign(new Error("fleet not found"), { statusCode: 404 });
    let root = fleet.repoPath;
    if (cap.scope === "worker") {
      const node = options.store.listNodes(fleet.id).find((x) => x.nodeId === cap.nodeId); const attempt = options.store.listAttempts(fleet.id, cap.nodeId).find((x) => x.id === cap.attemptId);
      if (!node || !attempt) throw Object.assign(new Error("worker attempt not found"), { statusCode: 404 });
      if (node.spec.worktree) root = join(options.store.fleetArtifactDir(fleet), "worktrees", slug(node.nodeId), `attempt-${attempt.number}`);
    }
    const rootReal = realpathSync(root); const lexical = resolve(rootReal, requested); const rel = relative(rootReal, lexical);
    if (isAbsolute(rel) || rel.startsWith("..")) throw Object.assign(new Error("workspace path escapes capability root"), { statusCode: 400 });
    let cursor = rootReal;
    for (const segment of rel.split(/[\\/]/).filter(Boolean)) {
      const candidate = join(cursor, segment); cursor = existsSync(candidate) ? realpathSync(candidate) : candidate;
      const checked = relative(rootReal, cursor); if (isAbsolute(checked) || checked.startsWith("..")) throw Object.assign(new Error("workspace symlink escapes capability root"), { statusCode: 400 });
    }
    return cursor;
  }
  app.post<{ Body: FleetSpec["workers"][number] }>("/api/v1/bridge/orchestrator/nodes", async (request) => {
    const cap = requireOrchestrator(request); const fleet = options.store.getFleet(cap.fleetId!)!;
    if (request.body.permission_profile === "full-access") throw Object.assign(new Error("only a human can add a full-access worker"), { statusCode: 403 });
    const spec = applyDefaults({ ...fleet.spec, workers: [...fleet.spec.workers, request.body] });
    await validateCapabilities(spec, async (id) => adapters.get(id)!.capabilities()); options.store.addNode(fleet.id, request.body); options.store.updateSpec(fleet.id, spec);
    return { added: request.body.id };
  });
  app.put<{ Params: { node: string }; Body: FleetSpec["workers"][number] }>("/api/v1/bridge/orchestrator/nodes/:node", async (request) => {
    const cap = requireOrchestrator(request); if (request.params.node !== request.body.id) throw Object.assign(new Error("node id cannot be changed"), { statusCode: 400 });
    if (request.body.permission_profile === "full-access") throw Object.assign(new Error("only a human can grant full access"), { statusCode: 403 });
    const fleet = options.store.getFleet(cap.fleetId!)!; const workers = fleet.spec.workers.map((x) => x.id === request.params.node ? request.body : x);
    const spec = applyDefaults({ ...fleet.spec, workers }); options.store.updateNode(fleet.id, request.params.node, request.body); options.store.updateSpec(fleet.id, spec); return { updated: request.params.node };
  });
  app.post<{ Body: { action: "pause" | "resume" | "kill" | "relaunch"; nodeId?: string } }>("/api/v1/bridge/orchestrator/control", async (request) => {
    const cap = requireOrchestrator(request); const { action, nodeId } = request.body;
    if (action === "pause") await scheduler.pause(cap.fleetId!); else if (action === "resume") await scheduler.resume(cap.fleetId!);
    else if (action === "kill") await scheduler.kill(cap.fleetId!, nodeId); else if (action === "relaunch" && nodeId) await scheduler.relaunch(cap.fleetId!, nodeId);
    else throw Object.assign(new Error("invalid control action"), { statusCode: 400 }); return { ok: true };
  });
  app.get("/api/v1/bridge/orchestrator/report", async (request) => {
    const cap = requireOrchestrator(request); const fleet = options.store.getFleet(cap.fleetId!)!;
    return { markdown: renderReport(fleet, options.store.listAttempts(fleet.id), options.store.listEvents(fleet.id)) };
  });

  const webRoot = join(packageRoot, "apps", "web", "dist");
  if (existsSync(webRoot)) await app.register(staticPlugin, { root: webRoot, wildcard: false });
  app.setErrorHandler((error, _request, reply) => reply.code((error as any).statusCode ?? 500).send({ error: error instanceof Error ? error.message : String(error) }));
  return app;
}

function preview(spec: FleetSpec) {
  return {
    name: spec.fleet_name, goal: spec.goal, orchestrator: spec.orchestrator,
    workers: spec.workers.map((x) => ({ id: x.id, harness: x.harness, model: x.model, effort: x.effort, permission: x.permission_profile, worktree: x.worktree, dependsOn: x.depends_on })),
    budgets: spec.config,
    warnings: [spec.orchestrator, ...spec.workers].filter((x) => x.permission_profile === "full-access").map((x: any) => `${x.id ?? "orchestrator"} requests full-access`),
  };
}

function extractSpecification(message: string): string {
  const fenced = message.match(/```(?:yaml|yml|json)?\s*([\s\S]*?)```/i); if (fenced) return fenced[1].trim();
  const json = message.indexOf("{"); if (json >= 0) return message.slice(json).trim();
  const yaml = message.search(/^version\s*:/m); return yaml >= 0 ? message.slice(yaml).trim() : message.trim();
}

function fullAccessIds(spec: FleetSpec): Set<string> {
  return new Set([...(spec.orchestrator.permission_profile === "full-access" ? ["orchestrator"] : []), ...spec.workers.filter((x) => x.permission_profile === "full-access").map((x) => x.id)]);
}
