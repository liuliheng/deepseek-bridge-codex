import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexAppServerAdapter } from "../packages/adapters/src/codex-app-server.ts";
import type { AgentEvent } from "../packages/adapters/src/types.ts";

test("Codex App Server adapter 完成 initialize/thread/turn 契约", async () => {
  const executable = resolve("tests/fixtures/fake-codex"); chmodSync(executable, 0o755); const workspace = mkdtempSync(join(tmpdir(), "lab-codex-"));
  const adapter = new CodexAppServerAdapter(executable); const probe = await adapter.probe(); assert.equal(probe.available, true);
  const controller = new AbortController(); const events: AgentEvent[] = [];
  for await (const event of adapter.startRun({ idempotencyKey: "fake-1", sourceAgent: "deepseek", targetAgent: "codex", objective: "契约测试", sessionPolicy: "new", workspaceRoot: workspace, allowedWriteRoots: [], capabilities: ["read_files"], inputs: [], acceptanceCriteria: ["完成"] }, { signal: controller.signal, approval: async () => false, input: async () => ({}) })) events.push(event);
  assert.equal(events[0].type, "started"); assert.ok(events.some((event) => event.type === "tool.started")); assert.equal(events.at(-1)?.type, "completed"); await adapter.close();
});
test("Codex App Server adapter 支持并发多个会话且各自完成", async () => {
  const executable = resolve("tests/fixtures/fake-codex"); chmodSync(executable, 0o755); const workspace = mkdtempSync(join(tmpdir(), "lab-codex-concurrent-"));
  const adapter = new CodexAppServerAdapter(executable); await adapter.probe();
  const run = async (index: number): Promise<AgentEvent[]> => {
    const controller = new AbortController(); const events: AgentEvent[] = [];
    for await (const event of adapter.startRun({ idempotencyKey: `fake-concurrent-${index}`, sourceAgent: "deepseek", targetAgent: "codex", objective: `并发会话 ${index}`, sessionPolicy: "new", workspaceRoot: workspace, allowedWriteRoots: [], capabilities: ["read_files"], inputs: [], acceptanceCriteria: ["完成"] }, { signal: controller.signal, approval: async () => false, input: async () => ({}) })) events.push(event);
    return events;
  };
  const results = await Promise.all([run(1), run(2), run(3)]);
  for (const events of results) { assert.equal(events[0].type, "started"); assert.equal(events.at(-1)?.type, "completed"); }
  await adapter.close();
});
