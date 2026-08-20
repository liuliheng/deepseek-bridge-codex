#!/usr/bin/env node
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { BridgeClient } from "../../../packages/sdk/src/index.ts";
import { BridgeError } from "../../../packages/protocol/src/index.ts";
import { loadConfig } from "../../labd/src/config.ts";

const config = loadConfig(); const args = process.argv.slice(2); const json = args.includes("--json");
const clean = args.filter((arg) => arg !== "--json");
const client = new BridgeClient({ socketPath: config.socketPath, tokenPath: config.tokenPath, nodeId: "labctl", kind: "user" });
const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, json ? 0 : 2)}\n`);

async function doctor(): Promise<void> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  checks.push({ name: "Node.js", ok: Number(process.versions.node.split(".")[0]) >= 24, detail: process.version });
  try { accessSync(config.databasePath, constants.W_OK); checks.push({ name: "数据库", ok: true, detail: config.databasePath }); }
  catch { try { accessSync(new URL(`file://${config.databasePath}`).pathname.replace(/\/[^/]+$/, ""), constants.W_OK); checks.push({ name: "数据库目录", ok: true, detail: config.databasePath }); } catch { checks.push({ name: "数据库目录", ok: false, detail: config.databasePath }); } }
  checks.push({ name: "Token 权限", ok: existsSync(config.tokenPath) && (statSync(config.tokenPath).mode & 0o077) === 0, detail: config.tokenPath });
  const codex = spawnSync(config.codex.command, ["--version"], { encoding: "utf8" }); checks.push({ name: "Codex CLI", ok: codex.status === 0, detail: (codex.stdout || codex.stderr || config.codex.command).trim() });
  const deepseek = spawnSync(config.deepseek.command, ["--version"], { encoding: "utf8" }); checks.push({ name: "DeepSeek Harness", ok: deepseek.status === 0, detail: (deepseek.stdout || deepseek.stderr || config.deepseek.command).trim() });
  try { const health = await client.request("health"); checks.push({ name: "Bridge", ok: true, detail: JSON.stringify(health) }); }
  catch (error) { checks.push({ name: "Bridge", ok: false, detail: error instanceof Error ? error.message : String(error) }); }
  print({ ok: checks.every((check) => check.ok), checks });
}

async function main(): Promise<void> {
  const [command, subcommand, id, ...rest] = clean;
  if (command === "doctor") return await doctor();
  if (command === "status") return print(await client.request("health"));
  if (command === "agents") return print(await client.request("capabilities.list"));
  if (command === "tasks" && subcommand === "list") return print(await client.request("task.list", { status: id?.toUpperCase(), limit: 100 }));
  if (command === "tasks" && subcommand === "show" && id) return print(await client.request("task.get", { taskId: id }));
  if (command === "tasks" && subcommand === "cancel" && id) return print(await client.request("task.cancel", { taskId: id, reason: rest.join(" ") || "labctl 取消" }));
  if (command === "tasks" && subcommand === "retry" && id) return print(await client.request("task.retry", { taskId: id, idempotencyKey: rest[0] }));
  if (command === "tasks" && subcommand === "submit" && id) return print(await client.request("task.submit", JSON.parse(id)));
  if (command === "events" && subcommand) return print(await client.request("task.events", { taskId: subcommand, afterSeq: Number(id ?? 0) }));
  if (command === "approvals" && subcommand === "list") return print(await client.request("approval.list", { status: id?.toUpperCase() }));
  if (command === "approvals" && ["approve", "deny"].includes(subcommand) && id) return print(await client.request("approval.decide", { approvalId: id, approved: subcommand === "approve", reason: rest.join(" ") }));
  if (command === "bridge" && subcommand === "stop") return print(await client.request("bridge.stop", { reason: rest.join(" ") }));
  if (command === "bridge" && subcommand === "resume") return print(await client.request("bridge.resume"));
  process.stdout.write("用法：labctl doctor|status|agents|tasks list [状态]|tasks show <id>|tasks cancel <id> [原因]|tasks retry <id> [幂等键]|tasks submit '<json>'|events <taskId> [afterSeq]|approvals list [状态]|approvals approve|deny <id> [原因]|bridge stop|resume\n");
  process.exitCode = 2;
}
try { await main(); } catch (error) { const e = error instanceof BridgeError ? error.toJSON() : { code: "CLI_ERROR", message: error instanceof Error ? error.message : String(error) }; print({ error: e }); process.exitCode = 1; }
finally { client.close(); }
