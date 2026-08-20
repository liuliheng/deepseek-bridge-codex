import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const skill = readFileSync(resolve("plugins/codex-bridge/skills/delegate-to-deepseek/SKILL.md"), "utf8");

test("DeepSeek 委派技能仅由肯定式直接委派触发", () => {
  const frontmatter = skill.slice(0, skill.indexOf("---", 4) + 3);
  assert.match(frontmatter, /affirmatively and directly assigns execution/);
  assert.match(frontmatter, /Mere mention, discussion, quotation, comparison, negation/);
  assert.match(frontmatter, /request for Codex itself to edit DeepSeek-related code must not trigger/);
});

test("DeepSeek 委派技能正文明确覆盖否定、故障报告和 Codex 自行处理", () => {
  assert.match(skill, /不要让 DeepSeek 做/);
  assert.match(skill, /included in a bug report/);
  assert.match(skill, /explicit request for Codex to do the work overrides/);
});
