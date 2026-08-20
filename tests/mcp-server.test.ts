import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

type ListedTool = { name: string; description: string; inputSchema: Record<string, unknown> };

async function listTools(target: "codex" | "deepseek", directOnly = false): Promise<ListedTool[]> {
  const entry = target === "codex" ? "plugins/deepseek-bridge/mcp-server/index.ts" : "plugins/codex-bridge/mcp-server/index.ts";
  const child = spawn(process.execPath, [resolve(entry), `--target=${target}`], {
    cwd: process.cwd(), env: { ...process.env, LAB_PROJECT_ROOT: process.cwd(), ...(directOnly ? { LAB_MCP_DIRECT_ONLY: "true" } : {}) }, stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const listed = await new Promise<ListedTool[]>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("MCP 响应超时")), 3000);
    child.once("error", reject);
    lines.on("line", (line) => {
      const message = JSON.parse(line) as { id?: number; result?: { tools?: ListedTool[] } };
      if (message.id === 2 && message.result?.tools) { clearTimeout(timer); resolvePromise(message.result.tools); }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  });
  child.kill("SIGTERM"); lines.close(); return listed;
}

test("DeepSeek companion 暴露 Codex 通用直达和图片直达工具", async () => {
  const tools = await listTools("codex", true);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["codex_do_work", "codex_generate_image"]);
  assert.ok(tools.find((tool) => tool.name === "codex_generate_image")?.description.includes("必须立刻调用"));
  assert.ok(tools.find((tool) => tool.name === "codex_do_work")?.description.includes("仅提及、讨论、引用、比较或否定"));
  const imageSchema = tools.find((tool) => tool.name === "codex_generate_image")?.inputSchema as { required?: string[] };
  assert.equal(imageSchema.required, undefined);
});

test("Codex companion 暴露 DeepSeek Harness 通用直达工具", async () => {
  const tools = await listTools("deepseek", true);
  assert.deepEqual(tools.map((tool) => tool.name), ["deepseek_do_work"]);
  assert.ok(tools[0]?.description.includes("真实 dsh headless"));
  assert.ok(tools[0]?.description.includes("仅提及、讨论、引用、比较或否定"));
  assert.ok(tools[0]?.description.includes("让 Codex 自己修复 DeepSeek 相关代码"));
});
