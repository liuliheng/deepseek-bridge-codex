import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const roots = ["apps", "packages", "plugins", "scripts", "tests"];
function files(path: string): string[] {
  try { return readdirSync(path).flatMap((name) => { const child = resolve(path, name); return statSync(child).isDirectory() ? files(child) : child.endsWith(".ts") ? [child] : []; }); }
  catch { return []; }
}
const targets = roots.flatMap(files); let failures = 0;
for (const target of targets) {
  const check = spawnSync(process.execPath, ["--check", target], { encoding: "utf8" });
  if (check.status !== 0) { failures += 1; process.stderr.write(`${target}\n${check.stderr}`); }
}
process.stdout.write(`checked ${targets.length} TypeScript files; failures=${failures}\n`);
process.exitCode = failures ? 1 : 0;
