import type { FleetSpec, FleetStatus, NodeStatus, WorkerSpec } from "@harness-fleet/protocol";

export interface NodeRuntime {
  spec: WorkerSpec;
  status: NodeStatus;
  attempt: number;
  iteration: number;
  lgtmCount: number;
  lastError?: string;
}

export interface FleetRuntime {
  id: string;
  status: FleetStatus;
  confirmed: boolean;
  startedAt?: number;
  nodes: Map<string, NodeRuntime>;
}

export function createRuntime(id: string, spec: FleetSpec): FleetRuntime {
  return {
    id,
    status: "waiting_for_confirmation",
    confirmed: false,
    nodes: new Map(spec.workers.map((worker) => [worker.id, {
      spec: worker, status: "pending", attempt: 0, iteration: 0, lgtmCount: 0,
    }])),
  };
}

export function dispatchable(runtime: FleetRuntime): NodeRuntime[] {
  if (!runtime.confirmed || runtime.status !== "running") return [];
  const completed = new Set([...runtime.nodes].filter(([, n]) => n.status === "completed").map(([id]) => id));
  return [...runtime.nodes.values()].filter((node) =>
    (node.status === "pending" || node.status === "ready")
    && (node.spec.depends_on ?? []).every((id) => completed.has(id)),
  );
}

const transitions: Record<NodeStatus, NodeStatus[]> = {
  pending: ["ready", "running", "cancelled"],
  ready: ["running", "cancelled"],
  running: ["waiting", "completed", "failed", "cancelled", "needs_attention"],
  waiting: ["running", "failed", "cancelled", "needs_attention"],
  completed: ["pending"],
  failed: ["pending", "cancelled", "needs_attention"],
  cancelled: ["pending"],
  needs_attention: ["pending", "cancelled"],
};

export function transitionNode(node: NodeRuntime, next: NodeStatus): void {
  if (!transitions[node.status].includes(next)) throw new Error(`invalid node transition ${node.status} -> ${next}`);
  node.status = next;
}

export function isTerminal(status: NodeStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
