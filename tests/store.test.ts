import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LabStore } from "../packages/store/src/index.ts";
import { BridgeError, parseSubmitTask } from "../packages/protocol/src/index.ts";
import { validateTaskPolicy } from "../packages/policy/src/index.ts";

test("SQLite 任务、事件、幂等和 ACK 在重开后仍存在", () => {
  const root = mkdtempSync(join(tmpdir(), "lab-store-")); const out = join(root, "out"); mkdirSync(out); const db = join(root, "lab.db");
  const input = parseSubmitTask({ idempotencyKey: "same-key", sourceAgent: "codex", targetAgent: "deepseek", objective: "摘要", sessionPolicy: "new", workspaceRoot: root, allowedWriteRoots: [out], capabilities: ["read_files", "write_files"], inputs: [], acceptanceCriteria: [] });
  const policy = validateTaskPolicy(input); let store = new LabStore(db); const created = store.createTask(input, { objectiveHash: policy.objectiveHash });
  assert.equal(created.idempotent, false); assert.equal(store.createTask(input, { objectiveHash: policy.objectiveHash }).task.id, created.task.id);
  assert.throws(() => store.createTask({ ...input, objective: "不同内容" }, { objectiveHash: "x" }), (error: unknown) => error instanceof BridgeError && error.code === "IDEMPOTENCY_CONFLICT");
  store.transition(created.task.id, "DISPATCHING", "task.dispatching"); store.transition(created.task.id, "RUNNING", "task.started");
  const event = store.appendEvent(created.task.id, "agent.message", { text: "working" }); assert.equal(store.ack("consumer", created.task.id, event.seq), event.seq); store.close();
  store = new LabStore(db); assert.equal(store.getTask(created.task.id)?.status, "RUNNING"); assert.equal(store.events(created.task.id).at(-1)?.eventType, "agent.message");
  assert.equal(store.markActiveLost(), 1); assert.equal(store.getTask(created.task.id)?.status, "LOST"); store.close();
});
