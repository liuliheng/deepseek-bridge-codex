import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

const target = process.argv[2] === "codex" ? "codex" : "deepseek";
const task = process.argv.slice(3).join(" ") || "只回复 BRIDGE_OK";
const entry = target === "codex" ? "plugins/deepseek-bridge/mcp-server/index.ts" : "plugins/codex-bridge/mcp-server/index.ts";
const tool = target === "codex" ? "codex_do_work" : "deepseek_do_work";
const child = spawn(process.execPath, [resolve(entry), `--target=${target}`], { cwd: process.cwd(), env: { ...process.env, LAB_MCP_DIRECT_ONLY: "true" }, stdio: ["pipe", "pipe", "inherit"] });
const lines = createInterface({ input: child.stdout });
const timer = setTimeout(() => { child.kill("SIGTERM"); throw new Error("direct MCP smoke timeout"); }, 620_000);
lines.on("line", (line) => {
  const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
  if (message.id !== 2) return;
  clearTimeout(timer); process.stdout.write(`${JSON.stringify(message.error ?? message.result, null, 2)}\n`); child.kill("SIGTERM"); lines.close();
});
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } })}\n`);
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: { task, workspaceRoot: process.cwd(), allowedWriteRoots: [], capabilities: ["read_files"] } } })}\n`);
