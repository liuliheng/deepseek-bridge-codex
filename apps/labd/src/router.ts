import { resolve } from "node:path";
import type { AgentAdapter, AgentEvent, RuntimeCapabilities } from "../../../packages/adapters/src/index.ts";
import { registerArtifact } from "../../../packages/artifact-registry/src/index.ts";
import { LabStore } from "../../../packages/store/src/index.ts";
import { BridgeError, asBridgeError, isTerminal, parseSubmitTask } from "../../../packages/protocol/src/index.ts";
import type { ApprovalRecord, TaskRecord, TaskResult } from "../../../packages/protocol/src/index.ts";
import { validateTaskPolicy } from "../../../packages/policy/src/index.ts";
import { DEFAULT_MAX_CONCURRENT_PER_AGENT } from "./config.ts";
import type { ConcurrencyLimits } from "./config.ts";

interface ActiveRun { controller: AbortController; runId?: string; target: "codex" | "deepseek"; artifacts: Set<string> }
interface ApprovalWaiter { resolve: (approved: boolean) => void; timer: NodeJS.Timeout }
interface InputWaiter { resolve: (input: Record<string, unknown>) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout }

const clampLimit = (value: number): number => Math.max(1, Math.floor(value));
function resolveLimits(limit: number | Partial<ConcurrencyLimits> | undefined): ConcurrencyLimits {
  if (typeof limit === "number") return { codex: clampLimit(limit), deepseek: clampLimit(limit) };
  return {
    codex: clampLimit(limit?.codex ?? DEFAULT_MAX_CONCURRENT_PER_AGENT),
    deepseek: clampLimit(limit?.deepseek ?? DEFAULT_MAX_CONCURRENT_PER_AGENT),
  };
}

export class TaskRouter {
  private active = new Map<string, ActiveRun>(); private approvalWaiters = new Map<string, ApprovalWaiter>();
  private inputWaiters = new Map<string, InputWaiter>();
  private stopped = false; private probes = new Map<string, RuntimeCapabilities>();
  readonly store: LabStore; private readonly adapters: Record<"codex" | "deepseek", AgentAdapter>; private readonly maxConcurrent: ConcurrencyLimits;
  constructor(store: LabStore, adapters: Record<"codex" | "deepseek", AgentAdapter>, maxConcurrent: number | Partial<ConcurrencyLimits> = DEFAULT_MAX_CONCURRENT_PER_AGENT) { this.store = store; this.adapters = adapters; this.maxConcurrent = resolveLimits(maxConcurrent); }

  async initialize(): Promise<void> {
    this.store.markActiveLost();
    await Promise.all(Object.entries(this.adapters).map(async ([kind, adapter]) => this.probes.set(kind, await adapter.probe())));
    this.kick();
  }
  capabilities(): Record<string, RuntimeCapabilities & { active: number; maxConcurrent: number }> {
    return Object.fromEntries((["codex", "deepseek"] as const).map((kind) => [kind, { ...(this.probes.get(kind) ?? { available: false, runtime: "unknown", capabilities: [], reason: "尚未探测" }), active: [...this.active.values()].filter((run) => run.target === kind).length, maxConcurrent: this.maxConcurrent[kind] }]));
  }
  get acceptingTasks(): boolean { return !this.stopped; }
  submit(raw: unknown): { task: TaskRecord; idempotent: boolean } {
    if (this.stopped) throw new BridgeError("KILL_SWITCH_ACTIVE", "Bridge kill switch 已启用，不接收新任务", true);
    const task = parseSubmitTask(raw); const policy = validateTaskPolicy(task);
    const capability = this.probes.get(task.targetAgent);
    if (capability?.available) {
      const missing = task.capabilities.filter((item) => !capability.capabilities.includes(item));
      if (missing.length) throw new BridgeError("TARGET_CAPABILITY_MISSING", "目标 runtime 缺少任务所需能力", false, { missing, available: capability.capabilities });
    }
    const created = this.store.createTask(task, { objectiveHash: policy.objectiveHash });
    if (!created.idempotent) setTimeout(() => this.kick(), task.limits?.queueTimeoutMs ?? 60_000).unref();
    this.kick(); return created;
  }
  get(taskId: string): { task: TaskRecord; events: ReturnType<LabStore["events"]>; artifacts: ReturnType<LabStore["artifacts"]> } {
    const task = this.store.getTask(taskId); if (!task) throw new BridgeError("TASK_NOT_FOUND", "任务不存在");
    return { task, events: this.store.events(taskId), artifacts: this.store.artifacts(taskId) };
  }
  list(options: Parameters<LabStore["listTasks"]>[0] = {}): TaskRecord[] { return this.store.listTasks(options); }
  retry(taskId: string, sourceAgent: "codex" | "deepseek" | "user", idempotencyKey?: string): { task: TaskRecord; idempotent: boolean } {
    const original = this.store.getTask(taskId); if (!original) throw new BridgeError("TASK_NOT_FOUND", "原任务不存在");
    if (!["FAILED", "CANCELED", "TIMED_OUT", "LOST"].includes(original.status)) throw new BridgeError("TASK_NOT_RETRYABLE", "只有失败、取消、超时或丢失任务可显式重试", false, { status: original.status });
    if (sourceAgent !== "user" && original.request.sourceAgent !== sourceAgent) throw new BridgeError("AUTH_FAILED", "只有用户或原任务来源主体可以重试");
    return this.submit({ ...original.request, idempotencyKey: idempotencyKey ?? `${original.request.idempotencyKey}:retry:${Date.now()}`, retryOfTaskId: taskId });
  }
  events(taskId: string, afterSeq = 0): ReturnType<LabStore["events"]> { if (!this.store.getTask(taskId)) throw new BridgeError("TASK_NOT_FOUND", "任务不存在"); return this.store.events(taskId, afterSeq); }
  ack(consumerId: string, taskId: string, throughSeq: number): number { return this.store.ack(consumerId, taskId, throughSeq); }

  async cancel(taskId: string, actor: string, reason = "用户取消"): Promise<TaskRecord> {
    const task = this.store.getTask(taskId); if (!task) throw new BridgeError("TASK_NOT_FOUND", "任务不存在");
    if (isTerminal(task.status)) return task;
    this.active.get(taskId)?.controller.abort(reason);
    for (const [approvalId, waiter] of this.approvalWaiters) {
      const approval = this.store.getApproval(approvalId); if (approval?.taskId === taskId) { clearTimeout(waiter.timer); waiter.resolve(false); this.approvalWaiters.delete(approvalId); }
    }
    const inputWaiter = this.inputWaiters.get(taskId);
    if (inputWaiter) { clearTimeout(inputWaiter.timer); inputWaiter.reject(new BridgeError("TASK_CANCELED", reason)); this.inputWaiters.delete(taskId); }
    const current = this.store.getTask(taskId)!;
    if (!isTerminal(current.status)) this.store.transition(taskId, "CANCELED", "task.canceled", { actor, reason }, { summary: "任务已取消" });
    return this.store.getTask(taskId)!;
  }
  async decideApproval(approvalId: string, approved: boolean, actor: string, reason?: string): Promise<ApprovalRecord> {
    const record = this.store.decideApproval(approvalId, approved, actor, reason); const waiter = this.approvalWaiters.get(approvalId);
    if (waiter) { clearTimeout(waiter.timer); this.approvalWaiters.delete(approvalId); waiter.resolve(approved); }
    return record;
  }
  async sendInput(taskId: string, input: unknown): Promise<void> {
    const waiting = this.inputWaiters.get(taskId);
    if (waiting) {
      clearTimeout(waiting.timer); this.inputWaiters.delete(taskId);
      const value = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : { value: input };
      const task = this.store.getTask(taskId); if (task?.status === "WAITING_INPUT") this.store.transition(taskId, "RUNNING", "input.answered", { input: value });
      waiting.resolve(value); return;
    }
    const active = this.active.get(taskId); if (!active?.runId) throw new BridgeError("TASK_NOT_RUNNING", "任务当前不可追加指导");
    const adapter = this.adapters[active.target]; if (!adapter.steer) throw new BridgeError("TARGET_CAPABILITY_MISSING", "目标 runtime 不支持 steer");
    await adapter.steer(active.runId, input); this.store.appendEvent(taskId, "input.sent", { input });
  }
  async killSwitch(actor: string, reason = "手动停止"): Promise<void> {
    this.stopped = true; await Promise.all([...this.active.keys()].map((id) => this.cancel(id, actor, reason)));
  }
  resumeAccepting(): void { this.stopped = false; this.kick(); }

  private kick(): void { setImmediate(() => void this.dispatch()); }
  private async dispatch(): Promise<void> {
    if (this.stopped) return;
    for (const target of ["codex", "deepseek"] as const) {
      const running = [...this.active.values()].filter((item) => item.target === target).length;
      const slots = Math.max(0, this.maxConcurrent[target] - running); if (!slots) continue;
      const queued = this.store.listTasks({ status: "QUEUED", limit: 500 }).filter((task) => task.request.targetAgent === target).reverse();
      const ready: TaskRecord[] = [];
      for (const task of queued) {
        const queueTimeout = task.request.limits?.queueTimeoutMs ?? 60_000;
        if (Date.now() - new Date(task.createdAt).getTime() >= queueTimeout) {
          this.store.transition(task.id, "TIMED_OUT", "task.failed", { code: "TASK_TIMEOUT", phase: "queue" }, { summary: "任务排队超时", error: { code: "TASK_TIMEOUT", message: "任务排队超时", retryable: true } }); continue;
        }
        ready.push(task);
      }
      const probe = this.probes.get(target); if (!probe?.available) continue;
      for (const task of ready.slice(0, slots)) void this.run(task);
    }
  }
  private async run(task: TaskRecord): Promise<void> {
    const controller = new AbortController(); const active: ActiveRun = { controller, target: task.request.targetAgent, artifacts: new Set() };
    this.active.set(task.id, active); this.store.transition(task.id, "DISPATCHING", "task.dispatching", { target: active.target });
    const timeout = setTimeout(() => controller.abort("run timeout"), task.request.limits?.runTimeoutMs ?? 600_000);
    let completed: Extract<AgentEvent, { type: "completed" }> | undefined;
    try {
      const context = {
        signal: controller.signal,
        approval: (request: Record<string, unknown>, timeoutMs?: number) => this.requestApproval(task.id, request, timeoutMs),
        input: (request: Record<string, unknown>, timeoutMs?: number) => this.requestInput(task.id, request, timeoutMs),
      };
      for await (const event of this.adapters[active.target].startRun(task.request, context)) {
        if (controller.signal.aborted) throw new BridgeError("TASK_CANCELED", "任务已中断");
        if (event.type === "started") {
          active.runId = event.runId; this.store.saveBinding(task.id, active.target, { sessionId: event.sessionId, runId: event.runId, runtimeVersion: this.probes.get(active.target)?.version });
          this.store.transition(task.id, "RUNNING", "task.started", { sessionId: event.sessionId, runId: event.runId });
        } else if (event.type === "progress") this.store.appendEvent(task.id, "agent.message", { text: event.message });
        else if (event.type === "tool.started") this.store.appendEvent(task.id, "tool.started", event);
        else if (event.type === "tool.completed") this.store.appendEvent(task.id, "tool.completed", event);
        else if (event.type === "artifact") { active.artifacts.add(event.path); this.store.appendEvent(task.id, "file.changed", { path: event.path }); }
        else if (event.type === "completed") { completed = event; for (const path of event.artifactPaths ?? []) active.artifacts.add(path); }
      }
      if (!completed) throw new BridgeError("RUNTIME_PROTOCOL_ERROR", "适配器未返回 completed 事件");
      for (const expected of task.request.artifacts?.expected ?? []) active.artifacts.add(resolve(expected.directory, expected.suggestedName));
      const artifactIds: string[] = []; const registeredPaths = new Set<string>();
      for (const path of active.artifacts) {
        const expected = task.request.artifacts?.expected?.find((item) => resolve(item.directory, item.suggestedName) === resolve(path));
        const manifest = await registerArtifact({ taskId: task.id, path, workspaceRoot: task.request.workspaceRoot, allowedWriteRoots: task.request.allowedWriteRoots, creator: active.target, expectedKind: expected?.kind });
        if (registeredPaths.has(manifest.absolutePath)) continue;
        registeredPaths.add(manifest.absolutePath); this.store.addArtifact(manifest); artifactIds.push(manifest.id); this.store.appendEvent(task.id, "artifact.created", manifest);
      }
      const result: TaskResult = { summary: completed.summary, output: completed.output, artifactIds };
      this.store.transition(task.id, "SUCCEEDED", "task.completed", { summary: completed.summary, artifactIds }, result);
    } catch (error) {
      const bridgeError = controller.signal.aborted ? new BridgeError("TASK_CANCELED", String(controller.signal.reason ?? "任务已取消")) : asBridgeError(error);
      const current = this.store.getTask(task.id);
      if (current && !isTerminal(current.status)) {
        const status = bridgeError.code === "TASK_CANCELED" ? "CANCELED" : bridgeError.code === "TASK_TIMEOUT" ? "TIMED_OUT" : "FAILED";
        this.store.transition(task.id, status, status === "CANCELED" ? "task.canceled" : "task.failed", bridgeError.toJSON(), { summary: bridgeError.message, error: bridgeError.toJSON() });
      }
    } finally { clearTimeout(timeout); this.active.delete(task.id); this.kick(); }
  }
  private requestApproval(taskId: string, request: Record<string, unknown>, timeoutMs = 300_000): Promise<boolean> {
    const approval = this.store.createApproval(taskId, request, timeoutMs);
    this.store.transition(taskId, "WAITING_APPROVAL", "approval.requested", { approvalId: approval.id, request, expiresAt: approval.expiresAt });
    return new Promise<boolean>((resolvePromise) => {
      const timer = setTimeout(() => {
        this.approvalWaiters.delete(approval.id);
        try { this.store.decideApproval(approval.id, false, "system", "审批超时，默认拒绝"); } catch {}
        resolvePromise(false);
      }, timeoutMs);
      this.approvalWaiters.set(approval.id, { timer, resolve: (approved) => {
        const current = this.store.getTask(taskId);
        if (current?.status === "WAITING_APPROVAL") this.store.transition(taskId, "RUNNING", "approval.decided", { approvalId: approval.id, approved });
        resolvePromise(approved);
      } });
    });
  }
  private requestInput(taskId: string, request: Record<string, unknown>, timeoutMs = 300_000): Promise<Record<string, unknown>> {
    this.store.transition(taskId, "WAITING_INPUT", "input.requested", { request, timeoutMs });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.inputWaiters.delete(taskId); reject(new BridgeError("TASK_TIMEOUT", "等待补充输入超时")); }, timeoutMs);
      this.inputWaiters.set(taskId, { timer, resolve, reject });
    });
  }
  async close(): Promise<void> { this.stopped = true; for (const run of this.active.values()) run.controller.abort("Bridge closing"); await Promise.all(Object.values(this.adapters).map((adapter) => adapter.close?.())); }
}
