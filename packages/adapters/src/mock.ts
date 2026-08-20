import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BridgeError } from "../../protocol/src/index.ts";
import type { Capability, SubmitTaskInput } from "../../protocol/src/index.ts";
import { assertWritePath } from "../../policy/src/index.ts";
import type { AgentAdapter, AgentEvent, RunContext, RuntimeCapabilities } from "./types.ts";

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolvePromise, reject) => {
  const timer = setTimeout(resolvePromise, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); reject(new BridgeError("TASK_CANCELED", "任务已取消")); }, { once: true });
});

export class MockAdapter implements AgentAdapter {
  readonly kind: "codex" | "deepseek"; private readonly delayMs: number;
  constructor(kind: "codex" | "deepseek", delayMs = 5) { this.kind = kind; this.delayMs = delayMs; }
  async probe(): Promise<RuntimeCapabilities> {
    const capabilities: Capability[] = ["read_files", "write_files", "shell", "delegate"];
    return { available: true, runtime: `mock-${this.kind}`, version: "0.1.0", capabilities };
  }
  async *startRun(task: SubmitTaskInput, context: RunContext): AsyncIterable<AgentEvent> {
    yield { type: "started", sessionId: `mock-${this.kind}-session`, runId: `mock-${Date.now()}` };
    await pause(this.delayMs, context.signal);
    yield { type: "progress", message: `${this.kind} 模拟适配器正在执行任务` };
    const text = task.inputs.find((input) => input.type === "text")?.text ?? "";
    if (text.startsWith("[approval]")) {
      const approved = await context.approval({ action: "mock.high_risk", reason: text.slice(10).trim() || "测试审批" }, 30_000);
      if (!approved) throw new BridgeError("APPROVAL_DENIED", "用户拒绝了高风险动作");
    }
    if (text.startsWith("[input]")) {
      const answer = await context.input({ question: text.slice(7).trim() || "请输入补充信息" }, 30_000);
      yield { type: "progress", message: `已收到补充输入：${JSON.stringify(answer)}` };
    }
    const artifactPaths: string[] = [];
    for (const artifact of task.artifacts?.expected ?? []) {
      if (artifact.kind === "image") throw new BridgeError("TARGET_CAPABILITY_MISSING", "模拟适配器不具备真实图片生成能力");
      const path = assertWritePath(resolve(artifact.directory, artifact.suggestedName), task.workspaceRoot, task.allowedWriteRoots);
      await mkdir(artifact.directory, { recursive: true });
      try { await writeFile(path, `Local Agent Bridge mock artifact\nobjective: ${task.objective}\n`, { flag: artifact.overwrite === "overwrite" ? "w" : "wx" }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new BridgeError("ARTIFACT_EXISTS", "目标文件已存在，未覆盖", false, { path }); throw error; }
      artifactPaths.push(path); yield { type: "artifact", path };
    }
    await pause(this.delayMs, context.signal);
    yield { type: "completed", summary: `${this.kind} 模拟任务完成`, output: { objective: task.objective }, artifactPaths };
  }
}
