import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_CONCURRENT_PER_AGENT, loadConfig } from "../apps/labd/src/config.ts";

const ENV_KEYS = ["LAB_CONFIG", "LAB_MAX_CONCURRENT_PER_AGENT", "LAB_MAX_CONCURRENT_CODEX", "LAB_MAX_CONCURRENT_DEEPSEEK"] as const;

/** 在临时目录写入 lab.config.json 并设置 LAB_CONFIG，测试后恢复环境变量 */
function withConfig(config: unknown, env: Partial<Record<string, string>>, fn: () => void): void {
  const root = mkdtempSync(join(tmpdir(), "lab-config-"));
  writeFileSync(join(root, "lab.config.json"), JSON.stringify(config));
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  process.env.LAB_CONFIG = join(root, "lab.config.json");
  try { fn(); } finally { for (const key of ENV_KEYS) { const value = saved[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

test("无配置时并发默认值提高到每个 agent 4", () => {
  withConfig({}, {}, () => {
    const config = loadConfig();
    assert.deepEqual(config.maxConcurrent, { codex: DEFAULT_MAX_CONCURRENT_PER_AGENT, deepseek: DEFAULT_MAX_CONCURRENT_PER_AGENT });
  });
});

test("旧版数字 maxConcurrentPerAgent 向后兼容，对两个 agent 生效", () => {
  withConfig({ maxConcurrentPerAgent: 1 }, {}, () => {
    assert.deepEqual(loadConfig().maxConcurrent, { codex: 1, deepseek: 1 });
  });
  withConfig({ maxConcurrentPerAgent: 6 }, {}, () => {
    assert.deepEqual(loadConfig().maxConcurrent, { codex: 6, deepseek: 6 });
  });
});

test("按 agent 对象分别设置并发上限，未指定项回退默认值", () => {
  withConfig({ maxConcurrentPerAgent: { codex: 3 } }, {}, () => {
    assert.deepEqual(loadConfig().maxConcurrent, { codex: 3, deepseek: DEFAULT_MAX_CONCURRENT_PER_AGENT });
  });
  withConfig({ maxConcurrentPerAgent: { codex: 2, deepseek: 5 } }, {}, () => {
    assert.deepEqual(loadConfig().maxConcurrent, { codex: 2, deepseek: 5 });
  });
});

test("环境变量覆盖配置文件：全局与按 agent", () => {
  withConfig({ maxConcurrentPerAgent: 2 }, { LAB_MAX_CONCURRENT_PER_AGENT: "5" }, () => {
    assert.deepEqual(loadConfig().maxConcurrent, { codex: 5, deepseek: 5 });
  });
  withConfig({ maxConcurrentPerAgent: 2 }, { LAB_MAX_CONCURRENT_CODEX: "7" }, () => {
    assert.deepEqual(loadConfig().maxConcurrent, { codex: 7, deepseek: 2 });
  });
  withConfig({ maxConcurrentPerAgent: { codex: 3, deepseek: 4 } }, { LAB_MAX_CONCURRENT_DEEPSEEK: "8" }, () => {
    assert.deepEqual(loadConfig().maxConcurrent, { codex: 3, deepseek: 8 });
  });
});

test("非法并发值报错而不是静默回落", () => {
  withConfig({ maxConcurrentPerAgent: 0 }, {}, () => { assert.throws(() => loadConfig(), /maxConcurrentPerAgent/); });
  withConfig({ maxConcurrentPerAgent: { codex: -1 } }, {}, () => { assert.throws(() => loadConfig(), /maxConcurrentPerAgent\.codex/); });
  withConfig({}, { LAB_MAX_CONCURRENT_PER_AGENT: "abc" }, () => { assert.throws(() => loadConfig(), /maxConcurrentPerAgent/); });
});
