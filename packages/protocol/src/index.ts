import { createHash, randomUUID } from "node:crypto";

export const PROTOCOL_VERSION = "1.0";
export const TERMINAL_STATUSES = ["SUCCEEDED", "FAILED", "CANCELED", "TIMED_OUT"] as const;
export const TASK_STATUSES = [
  "QUEUED", "DISPATCHING", "RUNNING", "WAITING_INPUT", "WAITING_APPROVAL",
  "SUCCEEDED", "FAILED", "CANCELED", "TIMED_OUT", "LOST",
] as const;
export const CAPABILITIES = [
  "read_files", "write_files", "shell", "network", "image_generate", "delegate",
] as const;

export type AgentKind = "codex" | "deepseek" | "user";
export type TaskStatus = typeof TASK_STATUSES[number];
export type Capability = typeof CAPABILITIES[number];
export type SessionPolicy = "new" | "resume" | "fork";
export type OverwritePolicy = "fail_if_exists" | "rename" | "overwrite";

export interface Principal { kind: AgentKind; nodeId: string }
export interface TaskInput { type: "text" | "file" | "json"; text?: string; path?: string; value?: unknown }
export interface ExpectedArtifact {
  kind: "file" | "image";
  directory: string;
  suggestedName: string;
  overwrite?: OverwritePolicy;
}
export interface DelegationHop { source: AgentKind; target: AgentKind; objectiveHash: string }
export interface SubmitTaskInput {
  idempotencyKey: string;
  sourceAgent: AgentKind;
  targetAgent: Exclude<AgentKind, "user">;
  objective: string;
  sessionPolicy: SessionPolicy;
  sessionId?: string;
  workspaceRoot: string;
  allowedWriteRoots: string[];
  capabilities: Capability[];
  inputs: TaskInput[];
  artifacts?: { expected: ExpectedArtifact[] };
  limits?: { queueTimeoutMs?: number; runTimeoutMs?: number; maxDelegationDepth?: number };
  acceptanceCriteria: string[];
  originTaskId?: string;
  parentTaskId?: string;
  retryOfTaskId?: string;
  delegationDepth?: number;
  delegationChain?: DelegationHop[];
}

export interface TaskRecord {
  id: string;
  request: SubmitTaskInput;
  status: TaskStatus;
  result?: TaskResult;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}
export interface TaskResult { summary: string; output?: unknown; error?: BridgeErrorData; artifactIds?: string[] }
export interface TaskEvent<T = unknown> {
  taskId: string; eventId: string; seq: number; eventType: string; createdAt: string; data: T;
}
export interface ArtifactManifest {
  id: string; taskId: string; absolutePath: string; mimeType: string; sizeBytes: number;
  sha256: string; creator: AgentKind; createdAt: string; metadata?: Record<string, unknown>;
}
export interface ApprovalRecord {
  id: string; taskId: string; status: "PENDING" | "APPROVED" | "DENIED" | "EXPIRED";
  request: Record<string, unknown>; decision?: Record<string, unknown>; expiresAt?: string;
  createdAt: string; decidedAt?: string;
}

export interface BridgeErrorData {
  code: string; message: string; retryable: boolean; details?: Record<string, unknown>;
}
export class BridgeError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, retryable = false, details?: Record<string, unknown>) {
    super(message); this.name = "BridgeError"; this.code = code; this.retryable = retryable; this.details = details;
  }
  toJSON(): BridgeErrorData { return { code: this.code, message: this.message, retryable: this.retryable, ...(this.details ? { details: this.details } : {}) }; }
}

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  QUEUED: ["DISPATCHING", "CANCELED", "TIMED_OUT"],
  DISPATCHING: ["RUNNING", "FAILED", "CANCELED", "TIMED_OUT", "LOST"],
  RUNNING: ["WAITING_INPUT", "WAITING_APPROVAL", "SUCCEEDED", "FAILED", "CANCELED", "TIMED_OUT", "LOST"],
  WAITING_INPUT: ["RUNNING", "FAILED", "CANCELED", "TIMED_OUT", "LOST"],
  WAITING_APPROVAL: ["RUNNING", "FAILED", "CANCELED", "TIMED_OUT", "LOST"],
  LOST: ["DISPATCHING", "CANCELED"],
  SUCCEEDED: [], FAILED: [], CANCELED: [], TIMED_OUT: [],
};

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!transitions[from]?.includes(to)) throw new BridgeError("INVALID_STATE_TRANSITION", `任务状态不能从 ${from} 变为 ${to}`, false, { from, to });
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BridgeError("INVALID_REQUEST", `${name} 必须是对象`);
  return value as Record<string, unknown>;
}
function string(value: unknown, name: string, max = 65536): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max || value.includes("\0")) throw new BridgeError("INVALID_REQUEST", `${name} 无效`);
  return value;
}
function stringArray(value: unknown, name: string, max = 64): string[] {
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string")) throw new BridgeError("INVALID_REQUEST", `${name} 必须是字符串数组`);
  return value as string[];
}

export function parseSubmitTask(value: unknown): SubmitTaskInput {
  const v = object(value, "payload");
  const sourceAgent = string(v.sourceAgent, "sourceAgent") as AgentKind;
  const targetAgent = string(v.targetAgent, "targetAgent") as "codex" | "deepseek";
  if (!["codex", "deepseek", "user"].includes(sourceAgent) || !["codex", "deepseek"].includes(targetAgent)) throw new BridgeError("INVALID_REQUEST", "agent 类型无效");
  const caps = stringArray(v.capabilities, "capabilities") as Capability[];
  if (caps.some((cap) => !CAPABILITIES.includes(cap))) throw new BridgeError("INVALID_REQUEST", "包含未知 capability");
  const sessionPolicy = (v.sessionPolicy ?? "new") as SessionPolicy;
  if (!["new", "resume", "fork"].includes(sessionPolicy)) throw new BridgeError("INVALID_REQUEST", "sessionPolicy 无效");
  if (sessionPolicy !== "new" && typeof v.sessionId !== "string") throw new BridgeError("INVALID_REQUEST", "resume/fork 必须提供 sessionId");
  const inputs = Array.isArray(v.inputs) ? v.inputs.map((raw, index) => {
    const input = object(raw, `inputs[${index}]`);
    if (!["text", "file", "json"].includes(String(input.type))) throw new BridgeError("INVALID_REQUEST", `inputs[${index}].type 无效`);
    return input as unknown as TaskInput;
  }) : [];
  const artifacts = v.artifacts === undefined ? undefined : (() => {
    const a = object(v.artifacts, "artifacts");
    if (!Array.isArray(a.expected)) throw new BridgeError("INVALID_REQUEST", "artifacts.expected 必须是数组");
    return { expected: a.expected.map((raw, index) => {
      const e = object(raw, `artifacts.expected[${index}]`);
      const kind = string(e.kind, "artifact.kind") as "file" | "image";
      if (!["file", "image"].includes(kind)) throw new BridgeError("INVALID_REQUEST", "artifact.kind 无效");
      return { kind, directory: string(e.directory, "artifact.directory"), suggestedName: string(e.suggestedName, "artifact.suggestedName", 255), overwrite: (e.overwrite ?? "fail_if_exists") as OverwritePolicy };
    }) };
  })();
  return {
    idempotencyKey: string(v.idempotencyKey, "idempotencyKey", 255), sourceAgent, targetAgent,
    objective: string(v.objective, "objective"), sessionPolicy,
    ...(typeof v.sessionId === "string" ? { sessionId: v.sessionId } : {}),
    workspaceRoot: string(v.workspaceRoot, "workspaceRoot"),
    allowedWriteRoots: stringArray(v.allowedWriteRoots ?? [], "allowedWriteRoots"), capabilities: caps,
    inputs, ...(artifacts ? { artifacts } : {}),
    limits: v.limits as SubmitTaskInput["limits"],
    acceptanceCriteria: stringArray(v.acceptanceCriteria ?? [], "acceptanceCriteria"),
    ...(typeof v.originTaskId === "string" ? { originTaskId: v.originTaskId } : {}),
    ...(typeof v.parentTaskId === "string" ? { parentTaskId: v.parentTaskId } : {}),
    ...(typeof v.retryOfTaskId === "string" ? { retryOfTaskId: v.retryOfTaskId } : {}),
    delegationDepth: Number.isInteger(v.delegationDepth) ? Number(v.delegationDepth) : 0,
    delegationChain: Array.isArray(v.delegationChain) ? v.delegationChain as DelegationHop[] : [],
  };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
export function requestHash(value: SubmitTaskInput): string { return sha256(canonicalJson(value)); }
export function objectiveHash(objective: string, inputs: TaskInput[]): string { return sha256(canonicalJson({ objective: objective.trim().replace(/\s+/g, " "), inputs })); }
export function newId(prefix: string): string { return `${prefix}_${randomUUID().replaceAll("-", "")}`; }
export function isTerminal(status: TaskStatus): boolean { return (TERMINAL_STATUSES as readonly string[]).includes(status); }
export function asBridgeError(error: unknown): BridgeError {
  return error instanceof BridgeError ? error : new BridgeError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
}
