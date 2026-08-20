import { CodexAppServerAdapter, DeepSeekCliAdapter } from "../../../packages/adapters/src/index.ts";
import { LabStore } from "../../../packages/store/src/index.ts";
import { loadConfig } from "./config.ts";
import { TaskRouter } from "./router.ts";
import { IpcServer } from "./server.ts";

const config = loadConfig();
const store = new LabStore(config.databasePath);
const codex = new CodexAppServerAdapter(config.codex.command, config.codex.args, config.codex.imageGenerate);
const deepseek = new DeepSeekCliAdapter(config.deepseek.command, config.deepseek.args);
const router = new TaskRouter(store, { codex, deepseek }, config.maxConcurrent);
await router.initialize();
const server = new IpcServer(config, router); await server.start();
process.stdout.write(`${JSON.stringify({ level: "info", event: "labd.started", socketPath: config.socketPath, databasePath: config.databasePath, capabilities: router.capabilities(), timestamp: new Date().toISOString() })}\n`);

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return; closing = true;
  process.stdout.write(`${JSON.stringify({ level: "info", event: "labd.stopping", signal, timestamp: new Date().toISOString() })}\n`);
  await server.close(); await router.close(); store.close(); process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT")); process.on("SIGTERM", () => void shutdown("SIGTERM"));
