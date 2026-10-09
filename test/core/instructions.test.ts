import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { syncInstructions } from "../../src/core/instructions.ts";
import { type Scope, resolveScope } from "../../src/core/scope.ts";

function setup(): { scope: Scope; templates: string } {
  const root = mkdtempSync(join(tmpdir(), "devbox-instructions-"));
  const scope = resolveScope(join(root, "tree"));

  mkdirSync(scope.configDir, { recursive: true });
  mkdirSync(join(root, "templates", "agents"), { recursive: true });
  writeFileSync(join(root, "templates", "agents", "devbox.md"), "# Как работать в скоупе\n\ndevbox link\n");

  return { scope, templates: join(root, "templates") };
}

const read = (scope: Scope): string => readFileSync(join(scope.root, "CLAUDE.md"), "utf8");

test("указания девбокса кладутся в корень скоупа — оттуда их видят агенты всех репозиториев", () => {
  const { scope, templates } = setup();

  assert.equal(syncInstructions(scope, templates), "written");
  assert.ok(read(scope).includes("devbox link"));
  assert.equal(syncInstructions(scope, templates), "unchanged");
});

test("свои указания скоупа из .devbox/agents.md дописываются; пустая заготовка — нет", () => {
  const { scope, templates } = setup();
  writeFileSync(join(scope.configDir, "agents.md"), "<!-- заготовка -->\n");
  syncInstructions(scope, templates);
  assert.equal(read(scope).includes("Указания этого скоупа"), false);

  writeFileSync(join(scope.configDir, "agents.md"), "<!-- заготовка -->\nКоммиты — на русском.\n");
  assert.equal(syncInstructions(scope, templates), "written");
  assert.ok(read(scope).endsWith("# Указания этого скоупа\n\nКоммиты — на русском.\n"));
});

test("новая версия девбокса обновляет свою часть", () => {
  const { scope, templates } = setup();
  syncInstructions(scope, templates);
  writeFileSync(join(templates, "agents", "devbox.md"), "# Новое\n");

  assert.equal(syncInstructions(scope, templates), "written");
  assert.equal(read(scope).includes("devbox link"), false);
});

test("чужой CLAUDE.md в корне скоупа не затирается", () => {
  const { scope, templates } = setup();
  writeFileSync(join(scope.root, "CLAUDE.md"), "моё\n");

  assert.equal(syncInstructions(scope, templates), "foreign");
  assert.equal(read(scope), "моё\n");
});

test("вне образа шаблона нет — ничего не пишется", () => {
  const { scope } = setup();

  assert.equal(syncInstructions(scope, join(scope.root, "none")), "no-template");
});
