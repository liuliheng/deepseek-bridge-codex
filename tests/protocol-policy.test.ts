import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeError, assertTransition, parseSubmitTask } from "../packages/protocol/src/index.ts";
import { assertWritePath, validateTaskPolicy } from "../packages/policy/src/index.ts";

function base(workspace: string) {
  return { idempotencyKey: "test-1", sourceAgent: "codex", targetAgent: "deepseek", objective: "分析模块", sessionPolicy: "new", workspaceRoot: workspace, allowedWriteRoots: [join(workspace, "out")], capabilities: ["read_files", "write_files"], inputs: [{ type: "text", text: "只读分析" }], acceptanceCriteria: ["返回摘要"] };
}
test("协议校验与状态机拒绝非法输入", () => {
  const root = mkdtempSync(join(tmpdir(), "lab-protocol-")); mkdirSync(join(root, "out"));
  const task = parseSubmitTask(base(root)); assert.equal(task.targetAgent, "deepseek");
  assert.throws(() => parseSubmitTask({ ...base(root), capabilities: ["root"] }), (error: unknown) => error instanceof BridgeError && error.code === "INVALID_REQUEST");
  assert.throws(() => assertTransition("SUCCEEDED", "RUNNING"), (error: unknown) => error instanceof BridgeError && error.code === "INVALID_STATE_TRANSITION");
});
test("路径策略拒绝 ../ 和符号链接逃逸", () => {
  const root = mkdtempSync(join(tmpdir(), "lab-path-")); const out = join(root, "out"); const outside = mkdtempSync(join(tmpdir(), "lab-outside-")); mkdirSync(out);
  assert.match(assertWritePath(join(out, "ok.txt"), root, [out]), /\/out\/ok\.txt$/);
  assert.throws(() => assertWritePath(join(out, "..", "escape.txt"), root, [out]), (error: unknown) => error instanceof BridgeError && error.code === "PATH_OUTSIDE_ALLOWED_ROOT");
  symlinkSync(outside, join(out, "link"));
  assert.throws(() => assertWritePath(join(out, "link", "escape.txt"), root, [out]), (error: unknown) => error instanceof BridgeError && error.code === "PATH_OUTSIDE_ALLOWED_ROOT");
});
test("委派循环签名和 capability 扩大被拒绝", () => {
  const root = mkdtempSync(join(tmpdir(), "lab-loop-")); mkdirSync(join(root, "out")); const task = parseSubmitTask(base(root)); const checked = validateTaskPolicy(task);
  assert.throws(() => validateTaskPolicy({ ...task, delegationChain: [{ source: "codex", target: "deepseek", objectiveHash: checked.objectiveHash }] }), (error: unknown) => error instanceof BridgeError && error.code === "DELEGATION_LOOP_DETECTED");
  assert.throws(() => validateTaskPolicy({ ...task, capabilities: ["read_files"] }), (error: unknown) => error instanceof BridgeError && error.code === "CAPABILITY_DENIED");
});
