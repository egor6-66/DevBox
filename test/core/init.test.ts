import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DevboxError } from "../../src/core/errors.ts";
import { init } from "../../src/core/init.ts";
import { hasConfigs, resolveScope } from "../../src/core/scope.ts";

// Настоящие шаблоны репозитория: тест заодно держит их набор.
const TEMPLATES = join(import.meta.dirname, "..", "..", "templates");

const emptyScope = () => resolveScope(mkdtempSync(join(tmpdir(), "devbox-init-")));

test("пустой скоуп получает стартовый набор и обе ссылки", () => {
  const scope = emptyScope();
  assert.equal(hasConfigs(scope), false);

  const report = init(scope, TEMPLATES);

  assert.deepEqual([...report.created].sort(), [
    ".devbox/.vscode/tasks.json",
    ".devbox/agents.md",
    ".devbox/links.yaml",
    ".devbox/mani.yaml",
    ".devbox/mcp.json",
    ".devbox/mise.toml",
    ".devbox/tree.code-workspace",
    ".mcp.json",
    "tree.code-workspace",
  ]);
  assert.deepEqual(report.skipped, []);
  assert.equal(hasConfigs(scope), true);

  // Ссылки ведут туда, где инструменты их ищут, и читаются насквозь.
  assert.equal(readlinkSync(join(scope.root, ".mcp.json")), join(".devbox", "mcp.json"));
  assert.equal(readlinkSync(join(scope.configDir, "tree.code-workspace")), join("..", "tree.code-workspace"));
  assert.ok(JSON.parse(readFileSync(join(scope.root, ".mcp.json"), "utf8")).mcpServers);
  assert.ok(JSON.parse(readFileSync(join(scope.configDir, "tree.code-workspace"), "utf8")).folders);
});

test("повторный запуск ничего не меняет", () => {
  const scope = emptyScope();
  const first = init(scope, TEMPLATES);
  const second = init(scope, TEMPLATES);

  assert.deepEqual(second.created, []);
  assert.deepEqual([...second.skipped].sort(), [...first.created].sort());
});

test("конфиг, который человек уже правил, не перезаписывается", () => {
  const scope = emptyScope();
  mkdirSync(scope.configDir);
  writeFileSync(join(scope.configDir, "mise.toml"), "# моё\n");

  const report = init(scope, TEMPLATES);

  assert.ok(report.skipped.includes(".devbox/mise.toml"));
  assert.equal(readFileSync(join(scope.configDir, "mise.toml"), "utf8"), "# моё\n");
  assert.ok(report.created.includes(".devbox/mani.yaml"));
});

test("на месте ссылки лежит обычный файл — он остаётся", () => {
  const scope = emptyScope();
  writeFileSync(join(scope.root, ".mcp.json"), "{}");

  const report = init(scope, TEMPLATES);

  assert.ok(report.skipped.includes(".mcp.json"));
  assert.equal(lstatSync(join(scope.root, ".mcp.json")).isSymbolicLink(), false);
});

test("нет шаблонов — понятный отказ", () => {
  assert.throws(() => init(emptyScope(), join(tmpdir(), "devbox-no-templates")), DevboxError);
});
