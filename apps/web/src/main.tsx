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
      id: runtime.nodeId, position: { x: d * 280, y: row * 145 }, data: { label: <div><strong>{runtime.nodeId}</strong><span>{runtime.spec.harness}</span><small>{runtime.status} · attempt {runtime.currentAttempt}</small></div> }, className: `node node--${runtime.status}`,
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
  return <div className="shell">
    <aside>
      <div className="brand"><i>HF</i><div><strong>Harness Fleet</strong><small>local control plane</small></div></div>
      <form onSubmit={design} className="new-fleet"><textarea placeholder="What should the fleet accomplish?" value={goal} onChange={(e) => setGoal(e.target.value)} required />
        <input placeholder="Repository path" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} />
        <select value={harness} onChange={(e) => setHarness(e.target.value)}><option value="codex">Codex orchestrator</option><option value="claude-code">Claude Code orchestrator</option><option value="pi">Pi orchestrator</option></select>
        <button disabled={designing}>{designing ? "Designing…" : "Design fleet"}</button></form>
      <p className="eyebrow">History</p>
      <nav>{fleets.map((x) => <button key={x.id} className={selected === x.id ? "active" : ""} onClick={() => setSelected(x.id)}><span>{x.spec.fleet_name}</span><small>{x.status}</small></button>)}</nav>
    </aside>
    <main>
      {error && <div className="error" onClick={() => setError("")}>{error}</div>}
      {!fleet ? <div className="empty"><h1>Orchestrate across harnesses.</h1><p>Design a fleet with Pi, Claude Code, and Codex without making any one of them the host.</p></div> :
      <><header><div><p className="eyebrow">{fleet.id}</p><h1>{fleet.spec.fleet_name}</h1><p>{fleet.spec.goal}</p></div><div className="actions">
        <button disabled={!!busy} onClick={() => void load(fleet.id)}>Refresh</button><button disabled={!!busy} onClick={showReport}>Report</button>
        {["waiting_for_confirmation", "paused", "needs_attention"].includes(fleet.status) && <><button disabled={!!busy} onClick={() => setEditor(JSON.stringify(fleet.spec, null, 2))}>Edit plan</button><button disabled={!!busy} onClick={addWorker}>Add worker</button></>}
        {["waiting_for_confirmation", "paused", "needs_attention", "paused_orchestrator_unavailable"].includes(fleet.status) && <button disabled={!!busy} onClick={changeOrchestrator}>Change orchestrator</button>}
        {fleet.status === "waiting_for_confirmation" && <button disabled={!!busy} className="launch" onClick={() => { const asksFull = [fleet.spec.orchestrator, ...fleet.spec.workers].some((x: any) => x.permission_profile === "full-access"); const fullAccessConfirm = asksFull ? window.confirm("This plan requests full access. Authorize unsandboxed execution?") : false; if (!asksFull || fullAccessConfirm) void control("launch", { confirm: true, fullAccessConfirm }); }}>Confirm & launch</button>}
        {fleet.status === "running" && <button disabled={!!busy} onClick={() => control("pause")}>Pause</button>}{["paused", "needs_attention", "paused_orchestrator_unavailable"].includes(fleet.status) && <button disabled={!!busy} onClick={() => control("resume")}>Resume</button>}
        {!['running', 'planning'].includes(fleet.status) && <button disabled={!!busy} onClick={() => { if (window.confirm("Remove worktrees for this fleet? Branches will be preserved.")) void control("cleanup"); }}>Cleanup</button>}
        <button disabled={!!busy} className="danger" onClick={() => { if (window.confirm("Kill every active worker in this fleet?")) void control("kill", {}); }}>Kill all</button></div></header>
        <section className="metrics"><div><span>Status</span><strong>{fleet.status}</strong></div><div><span>Orchestrator</span><strong>{fleet.orchestrator?.harness}</strong></div><div><span>Workers</span><strong>{fleet.nodes.length}</strong></div><div><span>Cost telemetry</span><strong>{fleet.attempts.some((x: any) => x.costQuality === "unavailable") ? "partial" : "reported"}</strong></div></section>
        <section className="canvas"><ReactFlow nodes={graph.nodes} edges={graph.edges} fitView onNodeClick={(_, node) => setDrawer(fleet.nodes.find((x: any) => x.nodeId === node.id))}><Background color="#253147" gap={24}/><Controls/></ReactFlow></section>
      </>}
    </main>
    {drawer && <div className="drawer"><button className="close" onClick={() => setDrawer(undefined)}>×</button><p className="eyebrow">Worker</p><h2>{drawer.nodeId}</h2>
      <dl><dt>Harness</dt><dd>{drawer.spec.harness}</dd><dt>Status</dt><dd>{drawer.status}</dd><dt>Permissions</dt><dd>{drawer.spec.permission_profile}</dd><dt>Worktree</dt><dd>{drawer.spec.worktree ? "isolated" : "shared checkout"}</dd></dl>
      <h3>Task</h3><p>{drawer.spec.task}</p><h3>Dependencies</h3><p>{drawer.spec.depends_on?.join(", ") || "None"}</p>
      <h3>Attempts</h3>{fleet?.attempts.filter((x: any) => x.nodeId === drawer.nodeId).map((x: any) => <article key={x.id}><strong>#{x.number} · {x.status}</strong><small>{x.branch ?? "no branch"} · cost {x.costQuality}</small></article>)}
      <h3>Contracts & outputs</h3>{drawer.spec.outputs?.length ? drawer.spec.outputs.map((x: any) => <article key={x.path}><strong>{x.kind}</strong><small>{x.path} · {x.required ? "required" : "optional"}</small></article>) : <p>None declared.</p>}
      <h3>Recent events</h3>{fleet?.events.filter((x: any) => x.nodeId === drawer.nodeId).slice(-8).map((x: any) => <article key={x.id}><strong>{x.type}</strong><small>{new Date(x.at).toLocaleTimeString()}</small></article>)}
      <h3>Messages</h3>{fleet?.messages.filter((x: any) => x.sender === drawer.nodeId || x.recipient === drawer.nodeId).slice(-8).map((x: any) => <article key={x.id}><strong>{x.sender} → {x.recipient}</strong><small>{x.body} · {x.status}</small></article>)}
      <div className="drawer-actions"><button disabled={!!busy} onClick={() => relaunchNode(drawer)}>Relaunch / reassign</button><button disabled={!!busy} className="danger" onClick={() => { if (window.confirm(`Kill worker ${drawer.nodeId}?`)) void control("kill", { nodeId: drawer.nodeId }); }}>Kill</button></div>
    </div>}
    {editor && <div className="modal"><div><p className="eyebrow">Editable launch preview</p><h2>Fleet specification</h2><textarea value={editor} onChange={(e) => setEditor(e.target.value)} /><footer><button onClick={() => setEditor("")}>Cancel</button><button className="launch" onClick={async () => { try { const spec = JSON.parse(editor); const asksFull = [spec.orchestrator, ...spec.workers].some((x: any) => x.permission_profile === "full-access"); const fullAccessConfirm = asksFull ? window.confirm("Authorize full access in this edited plan?") : false; if (asksFull && !fullAccessConfirm) return; await api(`/fleets/${fleet.id}`, { method: "PUT", body: JSON.stringify({ spec, fullAccessConfirm }) }); setEditor(""); await load(fleet.id); } catch (e) { setError((e as Error).message); } }}>Validate & save</button></footer></div></div>}
    {report && <div className="modal"><div className="report-modal"><p className="eyebrow">Fleet report</p><h2>{fleet?.spec.fleet_name}</h2><pre>{report}</pre><footer><button onClick={() => setReport("")}>Close</button></footer></div></div>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
