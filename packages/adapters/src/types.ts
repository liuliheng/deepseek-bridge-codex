import type { Capability, SubmitTaskInput } from "../../protocol/src/index.ts";

export interface RuntimeCapabilities {
  available: boolean; runtime: string; version?: string; capabilities: Capability[]; reason?: string;
}
export type AgentEvent =
  | { type: "started"; sessionId?: string; runId?: string }
  | { type: "progress"; message: string }
  | { type: "tool.started"; tool: string; input?: unknown }
  | { type: "tool.completed"; tool: string; output?: unknown }
  | { type: "approval.requested"; request: Record<string, unknown>; timeoutMs?: number }
  | { type: "artifact"; path: string }
  | { type: "completed"; summary: string; output?: unknown; artifactPaths?: string[] };
export interface RunContext {
  signal: AbortSignal;
  approval: (request: Record<string, unknown>, timeoutMs?: number) => Promise<boolean>;
  input: (request: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>;
}
export interface AgentAdapter {
  readonly kind: "codex" | "deepseek";
  probe(): Promise<RuntimeCapabilities>;
  startRun(task: SubmitTaskInput, context: RunContext): AsyncIterable<AgentEvent>;
  steer?(runId: string, input: unknown): Promise<void>;
  cancel?(runId: string, reason?: string): Promise<void>;
  reconcile?(runId: string): Promise<"running" | "completed" | "lost">;
  close?(): Promise<void>;
}
