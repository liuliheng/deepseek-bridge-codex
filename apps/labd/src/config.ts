import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export type ConcurrencyLimits = { codex: number; deepseek: number };
/** 向后兼容：既接受旧版全局数字（对两个 agent 生效），也接受按 agent 分别设置的记录 */
export type ConcurrencyConfig = number | { codex?: number; deepseek?: number };

export interface LabConfig {
  socketPath: string; databasePath: string; tokenPath: string;
  codex: { mode: "app-server"; command: string; args?: string[]; imageGenerate?: boolean };
  deepseek: { mode: "cli"; command: string; args?: string[] };
  /** 原始并发配置：`4` 表示每个 agent 最多 4 个并发；`{ "codex": 2, "deepseek": 4 }` 按 agent 分别设置 */
  maxConcurrentPerAgent?: ConcurrencyConfig;
  /** 解析后的按 agent 生效并发上限（环境变量 > 按 agent 配置 > 全局配置 > 默认值） */
  maxConcurrent: ConcurrencyLimits;
  maxMessageBytes: number;
}

export const DEFAULT_MAX_CONCURRENT_PER_AGENT = 4;

function positiveInt(value: unknown, name: string, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`无效的 ${name}：必须是不小于 1 的整数，收到 ${JSON.stringify(value)}`);
  return n;
}

export function resolveConcurrency(raw: unknown, env: NodeJS.ProcessEnv): ConcurrencyLimits {
  const perAgent = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as { codex?: unknown; deepseek?: unknown } : {};
  const global = positiveInt(env.LAB_MAX_CONCURRENT_PER_AGENT ?? (typeof raw === "number" ? raw : undefined), "maxConcurrentPerAgent", DEFAULT_MAX_CONCURRENT_PER_AGENT);
  return {
    codex: positiveInt(env.LAB_MAX_CONCURRENT_CODEX ?? perAgent.codex, "maxConcurrentPerAgent.codex", global),
    deepseek: positiveInt(env.LAB_MAX_CONCURRENT_DEEPSEEK ?? perAgent.deepseek, "maxConcurrentPerAgent.deepseek", global),
  };
}
export function loadConfig(cwd = process.cwd()): LabConfig {
  const configPath = process.env.LAB_CONFIG ? resolve(process.env.LAB_CONFIG) : resolve(cwd, "lab.config.json");
  const file = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) as Partial<LabConfig> : {};
  const absolute = (value: string) => isAbsolute(value) ? value : resolve(cwd, value);
  const codexMode = process.env.LAB_CODEX_MODE ?? file.codex?.mode ?? "app-server";
  const deepseekMode = process.env.LAB_DEEPSEEK_MODE ?? file.deepseek?.mode ?? "cli";
  if (codexMode !== "app-server") throw new Error(`不支持的 Codex 模式：${codexMode}；仅支持 app-server`);
  if (deepseekMode !== "cli") throw new Error(`不支持的 DeepSeek 模式：${deepseekMode}；仅支持 cli`);
  return {
    socketPath: absolute(process.env.LAB_SOCKET_PATH ?? file.socketPath ?? ".lab-data/labd.sock"),
    databasePath: absolute(process.env.LAB_DATABASE_PATH ?? file.databasePath ?? ".lab-data/lab.db"),
    tokenPath: absolute(process.env.LAB_TOKEN_PATH ?? file.tokenPath ?? ".lab-data/token"),
    codex: { mode: codexMode, command: process.env.LAB_CODEX_COMMAND ?? file.codex?.command ?? "codex", args: file.codex?.args ?? [], imageGenerate: process.env.LAB_CODEX_IMAGE_GENERATE === "true" || file.codex?.imageGenerate === true },
    deepseek: { mode: deepseekMode, command: process.env.LAB_DEEPSEEK_COMMAND ?? file.deepseek?.command ?? "dsh", args: process.env.LAB_DEEPSEEK_ARGS_JSON ? JSON.parse(process.env.LAB_DEEPSEEK_ARGS_JSON) : file.deepseek?.args ?? ["--profile", "headless"] },
    maxConcurrentPerAgent: file.maxConcurrentPerAgent,
    maxConcurrent: resolveConcurrency(file.maxConcurrentPerAgent, process.env),
    maxMessageBytes: Number(file.maxMessageBytes ?? 262_144),
  };
}
