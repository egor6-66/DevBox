import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { agentName, findAgent, launchOf, listAgents } from "../../src/core/agents.ts";
import { DevboxError } from "../../src/core/errors.ts";
import { resolveScope } from "../../src/core/scope.ts";

function scopeWith(roles: Readonly<Record<string, readonly string[]>>) {
  const root = mkdtempSync(join(tmpdir(), "devbox-agents-"));

  for (const [repo, names] of Object.entries(roles)) {
    mkdirSync(join(root, repo, ".claude", "roles"), { recursive: true });
    for (const name of names) writeFileSync(join(root, repo, ".claude", "roles", `${name}.json`), "{}");
  }

  return resolveScope(root);
}

test("агенты собираются с диска: по репозиториям, внутри — по имени роли", () => {
  const scope = scopeWith({ "web-core": ["ui", "main"], statboard: ["main"] });

  assert.deepEqual(listAgents(scope), [
    { repo: "statboard", role: "main" },
    { repo: "web-core", role: "main" },
    { repo: "web-core", role: "ui" },
  ]);
});

test("репозиторий без ролей, скрытые папки и посторонние файлы в список не попадают", () => {
  const scope = scopeWith({ app: ["main"], ".devbox": ["ghost"] });
  mkdirSync(join(scope.root, "no-roles"));
  writeFileSync(join(scope.root, "tree.code-workspace"), "{}");
  writeFileSync(join(scope.root, "app", ".claude", "roles", "notes.md"), "");

  assert.deepEqual(listAgents(scope), [{ repo: "app", role: "main" }]);
});

test("пустой скоуп — пустой список, а не ошибка", () => {
  assert.deepEqual(listAgents(resolveScope(join(tmpdir(), "devbox-no-such-scope"))), []);
});

test("запуск: папка репозитория, файл роли и имя сессии «репозиторий · роль»", () => {
  const scope = scopeWith({ statboard: ["main"] });
  const launch = launchOf(scope, findAgent(scope, "statboard", "main"));

  assert.equal(launch.name, "statboard · main");
  assert.equal(launch.cwd, join(scope.root, "statboard"));
  assert.equal(launch.command, "claude");
  assert.deepEqual(launch.args, ["--settings", join(".claude", "roles", "main.json"), "-n", "statboard · main"]);
  assert.equal(agentName({ repo: "statboard", role: "main" }), launch.name);
});

test("несуществующая роль — отказ с путём, где её искали", () => {
  const scope = scopeWith({ statboard: ["main"] });

  assert.throws(() => findAgent(scope, "statboard", "nosuch"), (error: unknown) => {
    assert.ok(error instanceof DevboxError);
    assert.match(error.message, /statboard: нет роли «nosuch»/);

    return true;
  });
});
