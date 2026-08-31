export const HARNESS_IDS = ["pi", "claude-code", "codex"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
export type PermissionProfile = "read-only" | "workspace-write" | "full-access";
export type CostQuality = "reported" | "estimated" | "unavailable";
export type NodeType = "research" | "code-run" | "review" | "integrator" | "custom";

export interface OutputContract {
  path: string;
  kind: "file-exists" | "markdown" | "json" | "yaml" | "json-schema" | "regex";
  required?: boolean;
  schema?: Record<string, unknown>;
  pattern?: string;
}

export interface WorkerSpec {
  id: string;
  harness: HarnessId;
  type: NodeType;
  task: string;
  model?: string;
  effort?: Effort;
  permission_profile?: PermissionProfile;
  worktree?: boolean;
  shared_checkout?: boolean;
  depends_on?: string[];
  outputs?: OutputContract[];
  timeout_minutes?: number;
  max_attempts?: number;
  reviewer_for?: string[];
}

export interface FleetSpec {
  version: 1;
  fleet_name: string;
  goal: string;
  repository?: string;
  orchestrator: {
    harness: HarnessId;
    model?: string;
    effort?: Effort;
    permission_profile?: PermissionProfile;
  };
  config?: {
    max_concurrent?: number;
    max_workers?: number;
    warn_cost_usd?: number;
    max_cost_usd?: number;
    max_duration_minutes?: number;
    max_attempts?: number;
    loop?: { gate: string; max_iterations?: number; lgtm_count?: number };
  };
  workers: WorkerSpec[];
}

export type FleetStatus =
  | "planning"
  | "waiting_for_confirmation"
  | "running"
  | "paused"
  | "paused_orchestrator_unavailable"
  | "needs_attention"
  | "completed"
  | "failed"
  | "cancelled";

export type NodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "needs_attention";

export interface FleetRecord {
  id: string;
  runId: string;
  spec: FleetSpec;
  repoPath: string;
  status: FleetStatus;
  confirmedAt?: string;
  fullAccessConfirmed?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AttemptRecord {
  id: string;
  fleetId: string;
  nodeId: string;
  number: number;
  harness: HarnessId;
  status: NodeStatus;
  sessionId?: string;
  pid?: number;
  artifactDir: string;
  branch?: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  error?: string;
  costUsd?: number;
  costQuality: CostQuality;
}

export type FleetEventType =
  | "session.started"
  | "session.resumed"
  | "session.settled"
  | "turn.started"
  | "turn.completed"
  | "turn.failed"
  | "assistant.message"
  | "tool.call"
  | "tool.result"
  | "usage"
  | "process.output"
  | "approval.blocked"
  | "contract.failed"
  | "review.verdict"
  | "message.sent"
  | "message.acknowledged"
  | "node.status"
  | "fleet.status"
  | "error";

export interface FleetEvent {
  id?: number;
  fleetId: string;
  nodeId?: string;
  attemptId?: string;
  type: FleetEventType;
  at: string;
  payload: Record<string, unknown>;
  raw?: unknown;
}

export type EventSink = (event: FleetEvent) => void | Promise<void>;

export interface HarnessProbe {
  available: boolean;
  command: string;
  version?: string;
  authenticated?: boolean;
  detail?: string;
}

export interface HarnessCapabilities {
  efforts: Effort[];
  supportsResume: boolean;
  supportsSteer: boolean;
  supportsReliableIncrementalCost: boolean;
  permissionProfiles: PermissionProfile[];
}

export interface SessionRef { id: string; harness: HarnessId; cwd: string }
export interface RunHandle { id: string; harness: HarnessId; pid?: number; session?: SessionRef; settled: Promise<RunResult> }
export interface RunResult { exitCode: number | null; session?: SessionRef; finalMessage?: string; error?: string }
export interface RoutedMessage { id: string; from: string; to: string; body: string; createdAt: string }
export interface DeliveryResult { accepted: boolean; boundary: "immediate" | "next-turn"; detail?: string }

export interface HarnessRunSpec {
  fleetId: string;
  nodeId: string;
  attemptId: string;
  cwd: string;
  prompt: string;
  model?: string;
  effort?: Effort;
  permissionProfile: PermissionProfile;
  bridge?: { command: string; args: string[]; env: Record<string, string> };
  timeoutMs?: number;
}

export interface HarnessAdapter {
  readonly id: HarnessId;
  probe(): Promise<HarnessProbe>;
  capabilities(): Promise<HarnessCapabilities>;
  start(spec: HarnessRunSpec, sink: EventSink): Promise<RunHandle>;
  resume(session: SessionRef, message: string, sink: EventSink): Promise<RunHandle>;
  send(handle: RunHandle, message: RoutedMessage): Promise<DeliveryResult>;
  cancel(handle: RunHandle, graceMs: number): Promise<void>;
}

export interface FleetMessage {
  id: string;
  fleetId: string;
  sender: string;
  recipient: string;
  body: string;
  status: "pending" | "delivered" | "acknowledged" | "rejected";
  createdAt: string;
  deliveredAt?: string;
  acknowledgedAt?: string;
}

export interface ContractResult {
  contract: OutputContract;
  ok: boolean;
  detail: string;
}

export const FLEET_SCHEMA: Record<string, unknown> = {
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
      type: "object", additionalProperties: false,
      properties: {
        max_concurrent: { type: "integer", minimum: 1, maximum: 32, default: 4 },
        max_workers: { type: "integer", minimum: 1, maximum: 32, default: 32 },
        warn_cost_usd: { type: "number", minimum: 0 },
        max_cost_usd: { type: "number", exclusiveMinimum: 0 },
        max_duration_minutes: { type: "integer", minimum: 1 },
        max_attempts: { type: "integer", minimum: 1, maximum: 20, default: 3 },
        loop: {
          type: "object", additionalProperties: false, required: ["gate"],
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
      type: "object", additionalProperties: false, required: ["harness"],
      properties: {
        harness: { $ref: "#/$defs/harness" }, model: { type: "string" },
        effort: { $ref: "#/$defs/effort" }, permission_profile: { $ref: "#/$defs/permission" }
      }
    },
    output: {
      type: "object", additionalProperties: false, required: ["path", "kind"],
      properties: {
        path: { type: "string", minLength: 1 },
        kind: { enum: ["file-exists", "markdown", "json", "yaml", "json-schema", "regex"] },
        required: { type: "boolean" }, schema: { type: "object" }, pattern: { type: "string" }
      }
    },
    worker: {
      type: "object", additionalProperties: false, required: ["id", "harness", "type", "task"],
      properties: {
        id: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]*$" },
        harness: { $ref: "#/$defs/harness" }, type: { enum: ["research", "code-run", "review", "integrator", "custom"] },
        task: { type: "string", minLength: 1 }, model: { type: "string" }, effort: { $ref: "#/$defs/effort" },
        permission_profile: { $ref: "#/$defs/permission" }, worktree: { type: "boolean" }, shared_checkout: { type: "boolean" },
        depends_on: { type: "array", uniqueItems: true, items: { type: "string" } },
        outputs: { type: "array", items: { $ref: "#/$defs/output" } },
        timeout_minutes: { type: "integer", minimum: 1 }, max_attempts: { type: "integer", minimum: 1, maximum: 20 },
        reviewer_for: { type: "array", uniqueItems: true, items: { type: "string" } }
      }
    }
  }
};

export * from "./process.js";
