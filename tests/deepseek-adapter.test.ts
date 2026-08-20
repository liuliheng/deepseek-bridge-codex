import test from "node:test";
import assert from "node:assert/strict";
import { DeepSeekCliAdapter } from "../packages/adapters/src/deepseek-cli.ts";

test("DeepSeek adapter 使用官方 headless 参数并返回最终回答", async () => {
  const script = "if(process.argv[1]==='--version'){console.log('dsh-test');process.exit(0)};const prompt=process.argv.at(-1);console.log(prompt.includes('真实委派')?'DSH_OK':'BAD_PROMPT')";
  const adapter = new DeepSeekCliAdapter(process.execPath, ["-e", script, "--"]);
  const probe = await adapter.probe(); assert.equal(probe.available, true); assert.equal(probe.runtime, "deepseek-harness-headless");
  const events = [];
  for await (const event of adapter.startRun({
    idempotencyKey: "dsh-adapter-1", sourceAgent: "codex", targetAgent: "deepseek", objective: "真实委派",
    sessionPolicy: "new", workspaceRoot: process.cwd(), allowedWriteRoots: [process.cwd()], capabilities: ["read_files"],
    inputs: [{ type: "text", text: "只回复结果" }], acceptanceCriteria: ["返回 DSH_OK"],
  }, { signal: new AbortController().signal, approval: async () => false, input: async () => ({}) })) events.push(event);
  assert.ok(events.some((event) => event.type === "completed" && (event.output as { answer?: string }).answer === "DSH_OK"));
});
