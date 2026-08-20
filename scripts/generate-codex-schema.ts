import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const codex = process.env.LAB_CODEX_COMMAND ?? "codex";
const versionRun = spawnSync(codex, ["--version"], { encoding: "utf8" });
if (versionRun.status !== 0) { process.stderr.write(versionRun.stderr || `无法执行 ${codex}\n`); process.exit(1); }
const version = versionRun.stdout.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
const output = resolve("schemas", "codex", version); mkdirSync(output, { recursive: true });
const result = spawnSync(codex, ["app-server", "generate-json-schema", "--out", output], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
process.stdout.write(`${output}\n`);
