import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BridgeError, assertTransition, newId, requestHash } from "../../protocol/src/index.ts";
import type { ApprovalRecord, ArtifactManifest, SubmitTaskInput, TaskEvent, TaskRecord, TaskResult, TaskStatus } from "../../protocol/src/index.ts";

type Row = Record<string, unknown>;
const iso = (value: unknown): string => new Date(Number(value)).toISOString();
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;

export class LabStore {
  readonly db: DatabaseSync;
  readonly path: string;
  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
        source_kind TEXT NOT NULL, target_kind TEXT NOT NULL, objective TEXT NOT NULL,
        status TEXT NOT NULL, workspace_root TEXT NOT NULL, request_json TEXT NOT NULL,
        result_json TEXT, origin_task_id TEXT, retry_of_task_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
        deadline_at INTEGER, UNIQUE(source_kind, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS task_events(
        task_id TEXT NOT NULL REFERENCES tasks(id), seq INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(task_id, seq)
      );
      CREATE TABLE IF NOT EXISTS runtime_bindings(
        task_id TEXT PRIMARY KEY REFERENCES tasks(id), runtime_kind TEXT NOT NULL, session_id TEXT,
        thread_id TEXT, turn_or_run_id TEXT, runtime_version TEXT, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals(
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), runtime_request_id TEXT,
        request_json TEXT NOT NULL, status TEXT NOT NULL, decision_json TEXT, expires_at INTEGER,
        created_at INTEGER NOT NULL, decided_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS artifacts(
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), absolute_path TEXT NOT NULL,
        mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
        creator TEXT NOT NULL, metadata_json TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS connections(
        node_id TEXT PRIMARY KEY, kind TEXT NOT NULL, adapter_version TEXT, runtime_version TEXT,
        capabilities_json TEXT NOT NULL, connected INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
        reconnect_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS consumer_offsets(
        consumer_id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), through_seq INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, PRIMARY KEY(consumer_id, task_id)
      );
      CREATE TABLE IF NOT EXISTS delegations(
        task_id TEXT PRIMARY KEY REFERENCES tasks(id), origin_task_id TEXT, parent_task_id TEXT,
        depth INTEGER NOT NULL, chain_json TEXT NOT NULL, objective_hash TEXT NOT NULL
      );
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, unixepoch('now') * 1000);
      CREATE INDEX IF NOT EXISTS task_events_task_seq ON task_events(task_id, seq);
      CREATE INDEX IF NOT EXISTS tasks_status_created ON tasks(status, created_at);
      CREATE INDEX IF NOT EXISTS approvals_status ON approvals(status, created_at);
    `);
  }

  transaction<T>(callback: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = callback(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  createTask(request: SubmitTaskInput, delegation: { objectiveHash: string }): { task: TaskRecord; idempotent: boolean } {
    const hash = requestHash(request);
    const existing = this.db.prepare("SELECT * FROM tasks WHERE source_kind=? AND idempotency_key=?").get(request.sourceAgent, request.idempotencyKey) as Row | undefined;
    if (existing) {
      if (existing.request_hash !== hash) throw new BridgeError("IDEMPOTENCY_CONFLICT", "同一 idempotencyKey 对应了不同任务内容", false, { taskId: existing.id });
      return { task: this.rowToTask(existing), idempotent: true };
    }
    const id = newId("task"); const now = Date.now();
    const deadline = now + (request.limits?.queueTimeoutMs ?? 60_000);
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO tasks(id,idempotency_key,request_hash,source_kind,target_kind,objective,status,workspace_root,request_json,origin_task_id,retry_of_task_id,created_at,updated_at,deadline_at)
        VALUES(?,?,?,?,?,?, 'QUEUED', ?,?,?,?,?,?,?)`).run(
        id, request.idempotencyKey, hash, request.sourceAgent, request.targetAgent, request.objective,
        request.workspaceRoot, JSON.stringify(request), request.originTaskId ?? id, request.retryOfTaskId ?? null,
        now, now, deadline,
      );
      this.db.prepare("INSERT INTO delegations(task_id,origin_task_id,parent_task_id,depth,chain_json,objective_hash) VALUES(?,?,?,?,?,?)").run(
        id, request.originTaskId ?? id, request.parentTaskId ?? null, request.delegationDepth ?? 0,
        JSON.stringify(request.delegationChain ?? []), delegation.objectiveHash,
      );
      this.appendEventRaw(id, "task.queued", { status: "QUEUED" }, now);
      return { task: this.getTask(id)!, idempotent: false };
    });
  }

  private appendEventRaw(taskId: string, eventType: string, data: unknown, now = Date.now()): TaskEvent {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM task_events WHERE task_id=?").get(taskId) as Row;
    const event: TaskEvent = { taskId, eventId: newId("evt"), seq: Number(row.seq), eventType, createdAt: new Date(now).toISOString(), data };
    this.db.prepare("INSERT INTO task_events(task_id,seq,event_id,event_type,payload_json,created_at) VALUES(?,?,?,?,?,?)").run(taskId, event.seq, event.eventId, eventType, JSON.stringify(data ?? null), now);
    return event;
  }

  appendEvent(taskId: string, eventType: string, data: unknown): TaskEvent {
    return this.transaction(() => this.appendEventRaw(taskId, eventType, data));
  }

  transition(taskId: string, to: TaskStatus, eventType: string, data: unknown = {}, result?: TaskResult): TaskEvent {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT status FROM tasks WHERE id=?").get(taskId) as Row | undefined;
      if (!row) throw new BridgeError("TASK_NOT_FOUND", "任务不存在");
      const from = String(row.status) as TaskStatus; assertTransition(from, to);
      const now = Date.now(); const terminal = ["SUCCEEDED", "FAILED", "CANCELED", "TIMED_OUT"].includes(to);
      this.db.prepare(`UPDATE tasks SET status=?, result_json=COALESCE(?,result_json), updated_at=?,
        started_at=CASE WHEN ?='RUNNING' THEN COALESCE(started_at,?) ELSE started_at END,
        finished_at=CASE WHEN ? THEN ? ELSE finished_at END WHERE id=?`).run(
        to, result ? JSON.stringify(result) : null, now, to, now, terminal ? 1 : 0, now, taskId,
      );
      return this.appendEventRaw(taskId, eventType, { ...(data && typeof data === "object" ? data as object : { value: data }), status: to }, now);
    });
  }

  getTask(id: string): TaskRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as Row | undefined;
    return row ? this.rowToTask(row) : undefined;
  }
  listTasks(options: { status?: TaskStatus; limit?: number } = {}): TaskRecord[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
    const rows = options.status
      ? this.db.prepare("SELECT * FROM tasks WHERE status=? ORDER BY created_at DESC LIMIT ?").all(options.status, limit)
      : this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?").all(limit);
    return (rows as Row[]).map((row) => this.rowToTask(row));
  }
  events(taskId: string, afterSeq = 0, limit = 1000): TaskEvent[] {
    return (this.db.prepare("SELECT * FROM task_events WHERE task_id=? AND seq>? ORDER BY seq LIMIT ?").all(taskId, afterSeq, Math.min(limit, 10_000)) as Row[]).map((row) => ({
      taskId: String(row.task_id), eventId: String(row.event_id), seq: Number(row.seq), eventType: String(row.event_type), createdAt: iso(row.created_at), data: parse(row.payload_json),
    }));
  }
  ack(consumerId: string, taskId: string, throughSeq: number): number {
    if (!Number.isInteger(throughSeq) || throughSeq < 0) throw new BridgeError("INVALID_REQUEST", "throughSeq 无效");
    const max = Number((this.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM task_events WHERE task_id=?").get(taskId) as Row).seq);
    if (throughSeq > max) throw new BridgeError("INVALID_REQUEST", "不能确认尚不存在的事件序号", false, { maxSeq: max });
    this.db.prepare(`INSERT INTO consumer_offsets(consumer_id,task_id,through_seq,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(consumer_id,task_id) DO UPDATE SET through_seq=MAX(through_seq,excluded.through_seq),updated_at=excluded.updated_at`).run(consumerId, taskId, throughSeq, Date.now());
    return Number((this.db.prepare("SELECT through_seq FROM consumer_offsets WHERE consumer_id=? AND task_id=?").get(consumerId, taskId) as Row).through_seq);
  }

  upsertConnection(input: { nodeId: string; kind: string; adapterVersion?: string; runtimeVersion?: string; capabilities?: unknown }): void {
    const prior = this.db.prepare("SELECT connected FROM connections WHERE node_id=?").get(input.nodeId) as Row | undefined;
    this.db.prepare(`INSERT INTO connections(node_id,kind,adapter_version,runtime_version,capabilities_json,connected,last_seen_at,reconnect_count) VALUES(?,?,?,?,?,1,?,0)
      ON CONFLICT(node_id) DO UPDATE SET kind=excluded.kind,adapter_version=excluded.adapter_version,runtime_version=excluded.runtime_version,capabilities_json=excluded.capabilities_json,connected=1,last_seen_at=excluded.last_seen_at,reconnect_count=reconnect_count+CASE WHEN connected=0 THEN 1 ELSE 0 END`).run(
      input.nodeId, input.kind, input.adapterVersion ?? null, input.runtimeVersion ?? null, JSON.stringify(input.capabilities ?? []), Date.now(),
    );
    void prior;
  }
  touchConnection(nodeId: string): void { this.db.prepare("UPDATE connections SET last_seen_at=? WHERE node_id=?").run(Date.now(), nodeId); }
  disconnect(nodeId: string): void { this.db.prepare("UPDATE connections SET connected=0,last_seen_at=? WHERE node_id=?").run(Date.now(), nodeId); }
  connections(): unknown[] { return this.db.prepare("SELECT node_id,kind,adapter_version,runtime_version,capabilities_json,connected,last_seen_at,reconnect_count FROM connections ORDER BY node_id").all(); }
  metrics(): Record<string, unknown> {
    const byStatus = this.db.prepare("SELECT status,COUNT(*) AS count FROM tasks GROUP BY status").all() as Row[];
    const durations = this.db.prepare("SELECT AVG(started_at-created_at) AS avg_queue_ms,AVG(finished_at-started_at) AS avg_run_ms FROM tasks WHERE started_at IS NOT NULL").get() as Row;
    const approvals = this.db.prepare("SELECT AVG(decided_at-created_at) AS avg_approval_wait_ms FROM approvals WHERE decided_at IS NOT NULL").get() as Row;
    return { tasksByStatus: Object.fromEntries(byStatus.map((row) => [String(row.status), Number(row.count)])), averageQueueMs: Number(durations.avg_queue_ms ?? 0), averageRunMs: Number(durations.avg_run_ms ?? 0), averageApprovalWaitMs: Number(approvals.avg_approval_wait_ms ?? 0) };
  }

  createApproval(taskId: string, request: Record<string, unknown>, timeoutMs = 300_000): ApprovalRecord {
    const id = newId("approval"), now = Date.now(), expires = now + timeoutMs;
    this.db.prepare("INSERT INTO approvals(id,task_id,request_json,status,expires_at,created_at) VALUES(?,?,?,'PENDING',?,?)").run(id, taskId, JSON.stringify(request), expires, now);
    return this.getApproval(id)!;
  }
  getApproval(id: string): ApprovalRecord | undefined {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id=?").get(id) as Row | undefined;
    return row ? this.rowToApproval(row) : undefined;
  }
  listApprovals(status?: string): ApprovalRecord[] {
    const rows = status ? this.db.prepare("SELECT * FROM approvals WHERE status=? ORDER BY created_at DESC").all(status) : this.db.prepare("SELECT * FROM approvals ORDER BY created_at DESC").all();
    return (rows as Row[]).map((row) => this.rowToApproval(row));
  }
  decideApproval(id: string, approved: boolean, actor: string, reason?: string): ApprovalRecord {
    return this.transaction(() => {
      const current = this.getApproval(id);
      if (!current) throw new BridgeError("APPROVAL_NOT_FOUND", "审批不存在");
      if (current.status !== "PENDING") throw new BridgeError("APPROVAL_ALREADY_DECIDED", "审批已处理");
      const now = Date.now(); const status = approved ? "APPROVED" : "DENIED";
      this.db.prepare("UPDATE approvals SET status=?,decision_json=?,decided_at=? WHERE id=?").run(status, JSON.stringify({ approved, actor, reason }), now, id);
      return this.getApproval(id)!;
    });
  }

  addArtifact(manifest: ArtifactManifest): void {
    this.db.prepare("INSERT INTO artifacts(id,task_id,absolute_path,mime_type,size_bytes,sha256,creator,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(
      manifest.id, manifest.taskId, manifest.absolutePath, manifest.mimeType, manifest.sizeBytes, manifest.sha256,
      manifest.creator, JSON.stringify(manifest.metadata ?? {}), new Date(manifest.createdAt).getTime(),
    );
  }
  artifacts(taskId: string): ArtifactManifest[] {
    return (this.db.prepare("SELECT * FROM artifacts WHERE task_id=? ORDER BY created_at").all(taskId) as Row[]).map((row) => ({
      id: String(row.id), taskId: String(row.task_id), absolutePath: String(row.absolute_path), mimeType: String(row.mime_type), sizeBytes: Number(row.size_bytes), sha256: String(row.sha256), creator: String(row.creator) as ArtifactManifest["creator"], createdAt: iso(row.created_at), metadata: parse(row.metadata_json),
    }));
  }

  saveBinding(taskId: string, runtimeKind: string, binding: { sessionId?: string; threadId?: string; runId?: string; runtimeVersion?: string }): void {
    this.db.prepare(`INSERT INTO runtime_bindings(task_id,runtime_kind,session_id,thread_id,turn_or_run_id,runtime_version,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(task_id) DO UPDATE SET session_id=excluded.session_id,thread_id=excluded.thread_id,turn_or_run_id=excluded.turn_or_run_id,runtime_version=excluded.runtime_version,updated_at=excluded.updated_at`).run(
      taskId, runtimeKind, binding.sessionId ?? null, binding.threadId ?? null, binding.runId ?? null, binding.runtimeVersion ?? null, Date.now(),
    );
  }
  markActiveLost(): number {
    const active = this.listTasks({ limit: 500 }).filter((task) => ["DISPATCHING", "RUNNING", "WAITING_INPUT", "WAITING_APPROVAL"].includes(task.status));
    for (const task of active) this.transition(task.id, "LOST", "task.lost", { reason: "Bridge 在任务非终态时重启；禁止自动重复执行" });
    return active.length;
  }
  close(): void { this.db.close(); }

  private rowToTask(row: Row): TaskRecord {
    return {
      id: String(row.id), request: parse(row.request_json), status: String(row.status) as TaskStatus,
      ...(row.result_json ? { result: parse<TaskResult>(row.result_json) } : {}), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
      ...(row.started_at ? { startedAt: iso(row.started_at) } : {}), ...(row.finished_at ? { finishedAt: iso(row.finished_at) } : {}),
    };
  }
  private rowToApproval(row: Row): ApprovalRecord {
    return { id: String(row.id), taskId: String(row.task_id), status: String(row.status) as ApprovalRecord["status"], request: parse(row.request_json),
      ...(row.decision_json ? { decision: parse<Record<string, unknown>>(row.decision_json) } : {}), ...(row.expires_at ? { expiresAt: iso(row.expires_at) } : {}),
      createdAt: iso(row.created_at), ...(row.decided_at ? { decidedAt: iso(row.decided_at) } : {}) };
  }
}
