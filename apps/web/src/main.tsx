import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Background, Controls, MarkerType, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./styles.css";

async function api(path: string, init?: RequestInit) {
  const response = await fetch(`/api/v1${path}`, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const text = await response.text(); let value: any; try { value = JSON.parse(text); } catch { value = text; }
  if (!response.ok) throw new Error(value.error ?? text); return value;
}
const post = (value: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(value) });
const statusText: Record<string, string> = {
  waiting_for_confirmation: "Ready to review", planning: "Creating the plan", pending: "Waiting", dispatching: "Starting",
  running: "Working", paused: "Paused", completed: "Completed", failed: "Needs attention", cancelled: "Stopped",
  needs_attention: "Needs attention", paused_orchestrator_unavailable: "Lead agent unavailable",
};
const friendlyStatus = (value?: string) => statusText[value ?? ""] ?? (value ?? "Unknown").replaceAll("_", " ");
const eventText = (event: any) => {
  if (event.type === "session.started") return "Agent session started";
  if (event.type === "turn.started") return "Agent started working";
  if (event.type === "assistant.message") return event.payload?.item?.text ?? "Agent shared an update";
  if (event.type === "tool.call") return "Agent used a tool";
  if (event.type === "tool.result") return "Tool finished";
  if (event.type === "node.status") return `Agent is ${friendlyStatus(event.payload?.status).toLowerCase()}`;
  if (event.type === "contract.failed") return "An expected output is missing";
  if (event.type === "session.settled") return "Agent session finished";
  if (event.type === "error") return "Something went wrong";
  return undefined;
};

function App() {
  const queryId = new URLSearchParams(location.search).get("fleet");
  const [fleets, setFleets] = useState<any[]>([]); const [selected, setSelected] = useState<string | null>(queryId);
  const [fleet, setFleet] = useState<any>(); const [drawer, setDrawer] = useState<any>(); const [error, setError] = useState("");
  const [report, setReport] = useState(""); const [busy, setBusy] = useState("");
  const [goal, setGoal] = useState(""); const [repoPath, setRepoPath] = useState("."); const [harness, setHarness] = useState("codex"); const [designing, setDesigning] = useState(false);
  const [editor, setEditor] = useState("");
  const loadList = () => api("/fleets").then(setFleets).catch((e) => setError(e.message));
  const load = (id: string) => api(`/fleets/${id}`).then((value) => { setFleet(value); setSelected(id); }).catch((e) => setError(e.message));
  useEffect(() => { void loadList(); }, []);
  useEffect(() => { if (!selected) return; void load(selected); const timer = setInterval(() => void load(selected), 2000); return () => clearInterval(timer); }, [selected]);
  useEffect(() => {
    if (!selected) return; const protocol = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${location.host}/api/v1/fleets/${selected}/ws`);
    socket.onmessage = () => void load(selected); return () => socket.close();
  }, [selected]);
  const graph = useMemo(() => {
    if (!fleet) return { nodes: [], edges: [] };
    const depth = new Map<string, number>(); const specs = fleet.spec.workers;
    const level = (id: string): number => { if (depth.has(id)) return depth.get(id)!; const worker = specs.find((x: any) => x.id === id); const value = worker?.depends_on?.length ? 1 + Math.max(...worker.depends_on.map(level)) : 0; depth.set(id, value); return value; };
    const counts = new Map<number, number>();
    const nodes: Node[] = fleet.nodes.map((runtime: any) => { const d = level(runtime.nodeId); const row = counts.get(d) ?? 0; counts.set(d, row + 1); return {
      id: runtime.nodeId, position: { x: d * 300, y: row * 165 }, draggable: false, data: { label: <div className="agent-card"><div className="agent-card__top"><strong>{runtime.nodeId}</strong><em>{friendlyStatus(runtime.status)}</em></div><span>{runtime.spec.harness}</span><p>{runtime.spec.task}</p><small>{runtime.currentAttempt ? `Attempt ${runtime.currentAttempt}` : "Not started"}</small></div> }, className: `node node--${runtime.status}`,
    }; });
    const edges: Edge[] = specs.flatMap((worker: any) => (worker.depends_on ?? []).map((dep: string) => ({ id: `${dep}-${worker.id}`, source: dep, target: worker.id, markerEnd: { type: MarkerType.ArrowClosed } })));
    return { nodes, edges };
  }, [fleet]);
  async function design(event: React.FormEvent) {
    event.preventDefault(); setDesigning(true); setError("");
    try { const value = await api("/fleets/design", post({ goal, orchestrator: harness, repoPath })); await loadList(); await load(value.fleet.id); } catch (e) { setError((e as Error).message); } finally { setDesigning(false); }
  }
  const control = async (action: string, body = {}) => {
    setBusy(action); setError("");
    try { await api(`/fleets/${fleet.id}/${action}`, post(body)); await Promise.all([load(fleet.id), loadList()]); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(""); }
  };
  const changeOrchestrator = async () => {
    const replacement = window.prompt("Replacement harness: pi, claude-code, or codex", fleet.orchestrator?.harness ?? "codex");
    if (!replacement) return;
    const model = window.prompt("Native model ID (leave blank for harness default)", fleet.spec.orchestrator.model ?? "") ?? "";
    setBusy("orchestrator"); setError("");
    try { await api(`/fleets/${fleet.id}/orchestrator`, { method: "PUT", body: JSON.stringify({ harness: replacement, model: model || undefined }) }); await load(fleet.id); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(""); }
  };
  const addWorker = () => {
    const id = window.prompt("Worker ID"); if (!id) return;
    const task = window.prompt("Worker task"); if (!task) return;
    const workerHarness = window.prompt("Harness: pi, claude-code, or codex", "codex"); if (!workerHarness) return;
    const spec = { ...fleet.spec, workers: [...fleet.spec.workers, { id, harness: workerHarness, type: "code-run", task, permission_profile: "workspace-write", worktree: true, depends_on: [], outputs: [] }] };
    setEditor(JSON.stringify(spec, null, 2));
  };
  const showReport = async () => {
    setBusy("report"); setError("");
    try { setReport(await api(`/fleets/${fleet.id}/report`)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(""); }
  };
  const relaunchNode = async (node: any) => {
    const nextHarness = window.prompt("Harness for the new attempt", node.spec.harness); if (!nextHarness) return;
    const nextModel = window.prompt("Native model ID (leave blank for current/default)", node.spec.model ?? ""); if (nextModel === null) return;
    await control(`relaunch/${node.nodeId}`, { harness: nextHarness, model: nextModel || undefined });
  };
  const completed = fleet?.nodes.filter((node: any) => node.status === "completed").length ?? 0;
  const recentActivity = (fleet?.events ?? []).map((event: any) => ({ ...event, label: eventText(event) })).filter((event: any) => event.label).slice(-6).reverse();
  const graphKey = fleet?.nodes.map((node: any) => `${node.nodeId}:${node.status}:${node.currentAttempt}`).join("|") ?? "empty";
  const guidance = fleet?.status === "waiting_for_confirmation" ? "Review the agents below. Nothing will run until you press Start fleet."
    : fleet?.status === "running" ? "Your agents are working. You can safely leave this page open or come back later."
    : fleet?.status === "completed" ? "All agents finished. Open an agent to inspect its work or view the final report."
    : fleet?.status === "paused" ? "The fleet is paused. Resume it whenever you are ready."
    : fleet?.status === "needs_attention" ? "One or more agents need your attention. Open the highlighted agent for details."
    : "Select an agent to see its task, attempts, outputs, and messages.";
  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><i>HF</i><div><strong>Harness Fleet</strong><small>Your local agent team</small></div></div>
      <form onSubmit={design} className="new-fleet"><h2>Create a fleet</h2><p>Describe the outcome. Your lead agent will turn it into a plan for you to approve.</p>
        <label><span>What do you want done?</span><textarea placeholder="For example: research the problem, implement a fix, and review it" value={goal} onChange={(e) => setGoal(e.target.value)} required /></label>
        <label><span>Project folder</span><input placeholder="C:\path\to\project" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} /></label>
        <label><span>Lead agent</span><select value={harness} onChange={(e) => setHarness(e.target.value)}><option value="codex">Codex</option><option value="claude-code">Claude Code</option><option value="pi">Pi</option></select></label>
        <button disabled={designing}>{designing ? "Creating your plan…" : "Create plan"}</button></form>
      <p className="eyebrow">Your fleets</p>
      <nav>{fleets.map((x) => <button key={x.id} className={selected === x.id ? "active" : ""} onClick={() => setSelected(x.id)}><span>{x.spec.fleet_name}</span><small><b className={`dot dot--${x.status}`}/>{friendlyStatus(x.status)}</small></button>)}</nav>
    </aside>
    <main>
      {error && <div className="error" onClick={() => setError("")}>{error}</div>}
      {!fleet ? <div className="empty"><span>Three harnesses. One clear workflow.</span><h1>Give your agent team a goal.</h1><p>Choose a lead agent, review the plan it creates, and stay in control while Pi, Claude Code, and Codex work together.</p></div> :
      <><header><div className="fleet-title"><div className={`status-pill status-pill--${fleet.status}`}><b/>{friendlyStatus(fleet.status)}</div><h1>{fleet.spec.fleet_name}</h1><p>{fleet.spec.goal}</p><small>Run {fleet.runId} · Lead agent: {fleet.orchestrator?.harness ?? fleet.spec.orchestrator.harness}</small></div><div className="actions">
        {fleet.status === "waiting_for_confirmation" && <button disabled={!!busy} className="launch primary-action" onClick={() => { const asksFull = [fleet.spec.orchestrator, ...fleet.spec.workers].some((x: any) => x.permission_profile === "full-access"); const fullAccessConfirm = asksFull ? window.confirm("This plan requests full access. Authorize unsandboxed execution?") : false; if (!asksFull || fullAccessConfirm) void control("launch", { confirm: true, fullAccessConfirm }); }}>Start fleet</button>}
        {fleet.status === "running" && <button disabled={!!busy} className="primary-action" onClick={() => control("pause")}>Pause work</button>}{["paused", "needs_attention", "paused_orchestrator_unavailable"].includes(fleet.status) && <button disabled={!!busy} className="launch primary-action" onClick={() => control("resume")}>Resume work</button>}
        <button disabled={!!busy} onClick={showReport}>View report</button><button disabled={!!busy} onClick={() => void load(fleet.id)}>Refresh</button>
      </div></header>
        <div className={`guidance guidance--${fleet.status}`}><strong>{friendlyStatus(fleet.status)}</strong><span>{guidance}</span></div>
        <section className="metrics"><div><span>Progress</span><strong>{completed} of {fleet.nodes.length} agents done</strong></div><div><span>Lead agent</span><strong>{fleet.orchestrator?.harness ?? fleet.spec.orchestrator.harness}</strong></div><div><span>Runs</span><strong>{fleet.attempts.length || "None yet"}</strong></div><div><span>Cost tracking</span><strong>{fleet.attempts.some((x: any) => x.costQuality === "unavailable") ? "Partial" : "Available"}</strong></div></section>
        <div className="workspace"><section className="plan-panel"><div className="section-heading"><div><span>Workflow</span><h2>Your agent plan</h2></div><p>Click an agent to inspect its task and output.</p></div><div className="canvas"><ReactFlow key={graphKey} nodes={graph.nodes} edges={graph.edges} fitView fitViewOptions={{ padding: 0.35 }} minZoom={0.35} maxZoom={1.5} nodesConnectable={false} onNodeClick={(_, node) => setDrawer(fleet.nodes.find((x: any) => x.nodeId === node.id))}><Background color="#253147" gap={24}/><Controls/></ReactFlow></div></section>
          <aside className="activity"><div className="section-heading"><div><span>Live</span><h2>Recent activity</h2></div></div>{recentActivity.length ? recentActivity.map((event: any) => <article key={event.id}><b className={`event-dot event-dot--${event.type.replaceAll(".", "-")}`}/><div><strong>{event.nodeId}</strong><p>{event.label}</p><small>{new Date(event.at).toLocaleTimeString()}</small></div></article>) : <div className="activity-empty">Activity will appear here when the fleet starts.</div>}
          <div className="manage"><h3>Manage fleet</h3>{["waiting_for_confirmation", "paused", "needs_attention"].includes(fleet.status) && <><button disabled={!!busy} onClick={addWorker}>＋ Add an agent</button><button disabled={!!busy} onClick={() => setEditor(JSON.stringify(fleet.spec, null, 2))}>Advanced plan editor</button></>}{["waiting_for_confirmation", "paused", "needs_attention", "paused_orchestrator_unavailable"].includes(fleet.status) && <button disabled={!!busy} onClick={changeOrchestrator}>Change lead agent</button>}{!['running', 'planning'].includes(fleet.status) && <button disabled={!!busy} onClick={() => { if (window.confirm("Remove worktrees for this fleet? Branches will be preserved.")) void control("cleanup"); }}>Clean up worktrees</button>}{fleet.status === "running" && <button disabled={!!busy} className="danger" onClick={() => { if (window.confirm("Stop every active agent in this fleet?")) void control("kill", {}); }}>Stop all agents</button>}</div></aside>
        </div>
      </>}
    </main>
    {drawer && <div className="drawer"><button aria-label="Close agent details" className="close" onClick={() => setDrawer(undefined)}>×</button><div className={`status-pill status-pill--${drawer.status}`}><b/>{friendlyStatus(drawer.status)}</div><h2>{drawer.nodeId}</h2><p className="drawer-intro">{drawer.spec.task}</p>
      <dl><dt>Runs with</dt><dd>{drawer.spec.harness}</dd><dt>Access</dt><dd>{drawer.spec.permission_profile === "workspace-write" ? "Can edit this workspace" : drawer.spec.permission_profile === "read-only" ? "Read only" : "Full computer access"}</dd><dt>Workspace</dt><dd>{drawer.spec.worktree ? "Separate worktree" : "Shared project folder"}</dd><dt>Depends on</dt><dd>{drawer.spec.depends_on?.join(", ") || "Nothing"}</dd></dl>
      <h3>Runs</h3>{fleet?.attempts.filter((x: any) => x.nodeId === drawer.nodeId).length ? fleet?.attempts.filter((x: any) => x.nodeId === drawer.nodeId).map((x: any) => <article key={x.id}><strong>Run {x.number} · {friendlyStatus(x.status)}</strong><small>{x.branch ?? "No branch"}</small></article>) : <p>This agent has not run yet.</p>}
      <h3>Expected output</h3>{drawer.spec.outputs?.length ? drawer.spec.outputs.map((x: any) => <article key={x.path}><strong>{x.path}</strong><small>{x.required ? "Required" : "Optional"} · {x.kind}</small></article>) : <p>No output requirement was declared.</p>}
      <h3>Latest updates</h3>{fleet?.events.filter((x: any) => x.nodeId === drawer.nodeId).map((event: any) => ({ ...event, label: eventText(event) })).filter((event: any) => event.label).slice(-8).reverse().map((x: any) => <article key={x.id}><strong>{x.label}</strong><small>{new Date(x.at).toLocaleTimeString()}</small></article>)}
      <h3>Messages</h3>{fleet?.messages.filter((x: any) => x.sender === drawer.nodeId || x.recipient === drawer.nodeId).slice(-8).map((x: any) => <article key={x.id}><strong>{x.sender} → {x.recipient}</strong><small>{x.body} · {friendlyStatus(x.status)}</small></article>)}
      <div className="drawer-actions"><button disabled={!!busy} onClick={() => relaunchNode(drawer)}>Run again or reassign</button>{drawer.status === "running" && <button disabled={!!busy} className="danger" onClick={() => { if (window.confirm(`Stop agent ${drawer.nodeId}?`)) void control("kill", { nodeId: drawer.nodeId }); }}>Stop agent</button>}</div>
    </div>}
    {editor && <div className="modal"><div><p className="eyebrow">Editable launch preview</p><h2>Fleet specification</h2><textarea value={editor} onChange={(e) => setEditor(e.target.value)} /><footer><button onClick={() => setEditor("")}>Cancel</button><button className="launch" onClick={async () => { try { const spec = JSON.parse(editor); const asksFull = [spec.orchestrator, ...spec.workers].some((x: any) => x.permission_profile === "full-access"); const fullAccessConfirm = asksFull ? window.confirm("Authorize full access in this edited plan?") : false; if (asksFull && !fullAccessConfirm) return; await api(`/fleets/${fleet.id}`, { method: "PUT", body: JSON.stringify({ spec, fullAccessConfirm }) }); setEditor(""); await load(fleet.id); } catch (e) { setError((e as Error).message); } }}>Validate & save</button></footer></div></div>}
    {report && <div className="modal"><div className="report-modal"><p className="eyebrow">Fleet report</p><h2>{fleet?.spec.fleet_name}</h2><pre>{report}</pre><footer><button onClick={() => setReport("")}>Close</button></footer></div></div>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
