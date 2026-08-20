import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LabStore } from "../packages/store/src/index.ts";
import { MockAdapter } from "../packages/adapters/src/mock.ts";
import { TaskRouter } from "../apps/labd/src/router.ts";
import type { TaskRecord } from "../packages/protocol/src/index.ts";
import type { SubmitTaskInput } from "../packages/protocol/src/index.ts";
import type { AgentAdapter, AgentEvent, RunContext, RuntimeCapabilities } from "../packages/adapters/src/types.ts";

/** 记录并发峰值的测试适配器：startRun 进入即占槽，结束才释放 */
class ConcurrencyProbeAdapter implements AgentAdapter {
  readonly kind: "codex" | "deepseek";
  active = 0; maxActive = 0; started = 0;
  private readonly holdMs: number;
  constructor(kind: "codex" | "deepseek", holdMs: number) { this.kind = kind; this.holdMs = holdMs; }
  async probe(): Promise<RuntimeCapabilities> { return { available: true, runtime: "probe", capabilities: ["read_files", "write_files"] }; }
  async *startRun(_task: SubmitTaskInput, context: RunContext): AsyncIterable<AgentEvent> {
    this.active += 1; this.maxActive = Math.max(this.maxActive, this.active); this.started += 1;
    try {
      yield { type: "started", sessionId: `probe-${this.kind}`, runId: `probe-${Date.now()}-${this.started}` };
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, this.holdMs); context.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });
      yield { type: "completed", summary: "done" };
    } finally { this.active -= 1; }
  }
}

async function until(router: TaskRouter, taskId: string, predicate: (task: TaskRecord) => boolean, timeout = 3000): Promise<TaskRecord> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const task = router.get(taskId).task; if (predicate(task)) return task; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("等待任务状态超时");
}
function request(root: string, extra: Record<string, unknown> = {}) {
  const out = join(root, "out"); return { idempotencyKey: `router-${Date.now()}-${Math.random()}`, sourceAgent: "codex", targetAgent: "deepseek", objective: "创建验证文本", sessionPolicy: "new", workspaceRoot: root, allowedWriteRoots: [out], capabilities: ["read_files", "write_files"], inputs: [{ type: "text", text: "hello" }], artifacts: { expected: [{ kind: "file", directory: out, suggestedName: "result.txt", overwrite: "fail_if_exists" }] }, acceptanceCriteria: ["文件存在"], ...extra };
}
test("模拟双向适配器完成任务并登记产物", async () => {
  const root = mkdtempSync(join(tmpdir(), "lab-router-")); mkdirSync(join(root, "out")); const store = new LabStore(join(root, "lab.db")); const router = new TaskRouter(store, { codex: new MockAdapter("codex"), deepseek: new MockAdapter("deepseek") }); await router.initialize();
  const accepted = router.submit(request(root)); const done = await until(router, accepted.task.id, (task) => task.status === "SUCCEEDED");
  assert.equal(done.status, "SUCCEEDED"); const detail = router.get(done.id); assert.equal(detail.artifacts.length, 1); assert.equal(detail.events.at(-1)?.eventType, "task.completed");
  await router.close(); store.close();
});
test("审批拒绝后动作不执行且决定可审计", async () => {
  const root = mkdtempSync(join(tmpdir(), "lab-approval-")); mkdirSync(join(root, "out")); const store = new LabStore(join(root, "lab.db")); const router = new TaskRouter(store, { codex: new MockAdapter("codex"), deepseek: new MockAdapter("deepseek") }); await router.initialize();
  const accepted = router.submit(request(root, { artifacts: undefined, inputs: [{ type: "text", text: "[approval] 删除测试文件" }] }));
  await until(router, accepted.task.id, (task) => task.status === "WAITING_APPROVAL"); const approval = store.listApprovals("PENDING")[0]; assert.ok(approval); await router.decideApproval(approval.id, false, "tester", "不允许删除");
  const failed = await until(router, accepted.task.id, (task) => task.status === "FAILED"); assert.equal(failed.result?.error?.code, "APPROVAL_DENIED"); assert.equal(store.getApproval(approval.id)?.status, "DENIED");
  await router.close(); store.close();
});
test("WAITING_INPUT 可由 sendInput 恢复运行", async () => {
  const root = mkdtempSync(join(tmpdir(), "lab-input-")); mkdirSync(join(root, "out")); const store = new LabStore(join(root, "lab.db")); const router = new TaskRouter(store, { codex: new MockAdapter("codex"), deepseek: new MockAdapter("deepseek") }); await router.initialize();
  const accepted = router.submit(request(root, { artifacts: undefined, inputs: [{ type: "text", text: "[input] 请选择分析范围" }] }));
  await until(router, accepted.task.id, (task) => task.status === "WAITING_INPUT"); await router.sendInput(accepted.task.id, { scope: "packages" });
  const done = await until(router, accepted.task.id, (task) => task.status === "SUCCEEDED"); assert.equal(done.status, "SUCCEEDED"); assert.ok(router.get(done.id).events.some((event) => event.eventType === "input.answered"));
  await router.close(); store.close();
});
test("取消运行任务得到不可逆 CANCELED 终态", async () => {
  const root = mkdtempSync(join(tmpdir(), "lab-cancel-")); mkdirSync(join(root, "out")); const store = new LabStore(join(root, "lab.db")); const router = new TaskRouter(store, { codex: new MockAdapter("codex", 100), deepseek: new MockAdapter("deepseek", 100) }); await router.initialize();
  const accepted = router.submit(request(root, { artifacts: undefined })); await until(router, accepted.task.id, (task) => task.status === "RUNNING"); await router.cancel(accepted.task.id, "tester", "测试取消");
  const canceled = await until(router, accepted.task.id, (task) => task.status === "CANCELED"); assert.equal(canceled.status, "CANCELED");
  await router.close(); store.close();
});
test("目标离线时持久排队并按 queueTimeout 超时，不重复执行", async () => {
  const root = mkdtempSync(join(tmpdir(), "lab-offline-")); mkdirSync(join(root, "out")); const store = new LabStore(join(root, "lab.db"));
  const offline: AgentAdapter = { kind: "deepseek", async probe(): Promise<RuntimeCapabilities> { return { available: false, runtime: "offline", capabilities: [], reason: "test" }; }, async *startRun() { throw new Error("不应执行"); } };
  const router = new TaskRouter(store, { codex: new MockAdapter("codex"), deepseek: offline }); await router.initialize();
  const accepted = router.submit(request(root, { artifacts: undefined, allowedWriteRoots: [], capabilities: ["read_files"], limits: { queueTimeoutMs: 20 } })); assert.equal(accepted.task.status, "QUEUED");
  const timedOut = await until(router, accepted.task.id, (task) => task.status === "TIMED_OUT"); assert.equal(timedOut.result?.error?.code, "TASK_TIMEOUT");
  await router.close(); store.close();
});
test("同一 agent 可按配置并发执行多个任务（默认上限可提高）", async () => {
  const root = mkdtempSync(join(tmpdir(), "lab-concurrent-")); mkdirSync(join(root, "out")); const store = new LabStore(join(root, "lab.db"));
  const probe = new ConcurrencyProbeAdapter("deepseek", 150);
  const router = new TaskRouter(store, { codex: new MockAdapter("codex"), deepseek: probe }, 3); await router.initialize();
  const ids: string[] = [];
  for (let i = 0; i < 5; i += 1) ids.push(router.submit(request(root, { artifacts: undefined })).task.id);
  for (const id of ids) await until(router, id, (task) => task.status === "SUCCEEDED");
  assert.equal(probe.started, 5); assert.equal(probe.maxActive, 3);
  assert.equal((router.capabilities().deepseek as { maxConcurrent: number }).maxConcurrent, 3);
  await router.close(); store.close();
});
test("按 agent 分别设置并发上限互不影响", async () => {
  const root = mkdtempSync(join(tmpdir(), "lab-concurrent-per-agent-")); mkdirSync(join(root, "out")); const store = new LabStore(join(root, "lab.db"));
  const codexProbe = new ConcurrencyProbeAdapter("codex", 120); const deepseekProbe = new ConcurrencyProbeAdapter("deepseek", 120);
  const router = new TaskRouter(store, { codex: codexProbe, deepseek: deepseekProbe }, { codex: 1, deepseek: 2 }); await router.initialize();
  const ids: string[] = [];
  for (let i = 0; i < 3; i += 1) ids.push(router.submit(request(root, { artifacts: undefined, targetAgent: "codex" })).task.id);
  for (let i = 0; i < 4; i += 1) ids.push(router.submit(request(root, { artifacts: undefined, targetAgent: "deepseek" })).task.id);
  for (const id of ids) await until(router, id, (task) => task.status === "SUCCEEDED");
  assert.equal(codexProbe.maxActive, 1); assert.equal(deepseekProbe.maxActive, 2);
  const capabilities = router.capabilities();
  assert.equal((capabilities.codex as { maxConcurrent: number }).maxConcurrent, 1);
  assert.equal((capabilities.deepseek as { maxConcurrent: number }).maxConcurrent, 2);
  await router.close(); store.close();
});
