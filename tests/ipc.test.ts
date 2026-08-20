import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { LabStore } from "../packages/store/src/index.ts";
import { MockAdapter } from "../packages/adapters/src/mock.ts";
import { TaskRouter } from "../apps/labd/src/router.ts";
import { IpcServer } from "../apps/labd/src/server.ts";
import { BridgeClient } from "../packages/sdk/src/index.ts";

test("Unix socket 鉴权、提交、等待和事件重放形成闭环", async () => {
  const root = mkdtempSync("/private/tmp/lab-ipc-"); const out = join(root, "out"); mkdirSync(out); const store = new LabStore(join(root, "lab.db"));
  const router = new TaskRouter(store, { codex: new MockAdapter("codex"), deepseek: new MockAdapter("deepseek") }); await router.initialize();
  const config = { socketPath: join(root, "lab.sock"), databasePath: join(root, "lab.db"), tokenPath: join(root, "token"), codex: { mode: "app-server" as const, command: "codex" }, deepseek: { mode: "cli" as const, command: "dsh" }, maxConcurrentPerAgent: 1, maxConcurrent: { codex: 1, deepseek: 1 }, maxMessageBytes: 262144 };
  const server = new IpcServer(config, router); await server.start(); const client = new BridgeClient({ socketPath: config.socketPath, tokenPath: config.tokenPath, nodeId: "ipc-test", kind: "codex" });
  const accepted = await client.submit({ idempotencyKey: "ipc-1", sourceAgent: "codex", targetAgent: "deepseek", objective: "IPC 测试", sessionPolicy: "new", workspaceRoot: root, allowedWriteRoots: [], capabilities: ["read_files"], inputs: [], acceptanceCriteria: ["完成"] });
  let result = await client.waitTask(accepted.task.id, 0, 3000); while (!['SUCCEEDED','FAILED'].includes(result.task.status)) result = await client.waitTask(accepted.task.id, result.events.at(-1)?.seq ?? 0, 3000);
  assert.equal(result.task.status, "SUCCEEDED"); const replay = await client.request<unknown[]>("task.events", { taskId: accepted.task.id, afterSeq: 0 }); assert.ok(replay.length >= 4);
  client.close(); await server.close(); await router.close(); store.close();
});

test("关闭 Bridge 时主动断开仍保持连接的客户端", async () => {
  const root = mkdtempSync("/private/tmp/lab-ipc-close-"); const store = new LabStore(join(root, "lab.db"));
  const router = new TaskRouter(store, { codex: new MockAdapter("codex"), deepseek: new MockAdapter("deepseek") }); await router.initialize();
  const config = { socketPath: join(root, "lab.sock"), databasePath: join(root, "lab.db"), tokenPath: join(root, "token"), codex: { mode: "app-server" as const, command: "codex" }, deepseek: { mode: "cli" as const, command: "dsh" }, maxConcurrentPerAgent: 4, maxConcurrent: { codex: 4, deepseek: 4 }, maxMessageBytes: 262144 };
  const server = new IpcServer(config, router); await server.start(); const client = new BridgeClient({ socketPath: config.socketPath, tokenPath: config.tokenPath, nodeId: "ipc-close-test", kind: "codex" });
  await client.request("health");
  await Promise.race([
    server.close(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Bridge 关闭被客户端连接阻塞")), 1000)),
  ]);
  client.close(); await router.close(); store.close();
});
