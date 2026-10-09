import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parse } from "jsonc-parser";

import { DevboxError } from "../../src/core/errors.ts";
import { readRepos } from "../../src/core/repos.ts";
import { type Scope, resolveScope } from "../../src/core/scope.ts";
import { syncWindow, windowFolders } from "../../src/core/window.ts";

// Скоуп с `mani.yaml` и уже склонированными (то есть существующими) папками.
function scopeWith(mani: string, cloned: readonly string[] = []): Scope {
  const scope = resolveScope(mkdtempSync(join(tmpdir(), "devbox-window-")));

  mkdirSync(scope.configDir);
  writeFileSync(join(scope.configDir, "mani.yaml"), mani);
  for (const name of cloned) mkdirSync(join(scope.root, name), { recursive: true });

  return scope;
}

const MANI = `projects:
  web-core:
    url: https://example.test/web-core.git
    path: ../web-core
  statboard:
    url: https://example.test/statboard.git
    path: ../statboard
`;

const windowOf = (scope: Scope): string => readFileSync(join(scope.root, "tree.code-workspace"), "utf8");
const foldersOf = (scope: Scope): unknown => parse(windowOf(scope)).folders;

test("репозитории читаются из mani.yaml в его порядке, путь считается от папки конфига", () => {
  const scope = scopeWith(`${MANI}  plain:\n    url: https://example.test/plain.git\n`);

  assert.deepEqual(readRepos(scope), [
    { name: "web-core", dir: join(scope.root, "web-core") },
    { name: "statboard", dir: join(scope.root, "statboard") },
    // Без `path` mani кладёт проект рядом со своим конфигом, под его именем.
    { name: "plain", dir: join(scope.configDir, "plain") },
  ]);
});

test("нет mani.yaml или в нём нет проектов — репозиториев нет, это не ошибка", () => {
  assert.deepEqual(readRepos(resolveScope(mkdtempSync(join(tmpdir(), "devbox-window-")))), []);
  assert.deepEqual(readRepos(scopeWith("projects: {}\n")), []);
  assert.deepEqual(readRepos(scopeWith("# одни комментарии\n")), []);
});

test("папки окна: конфиги первыми, дальше репозитории в порядке mani.yaml", () => {
  const scope = scopeWith(MANI, ["web-core", "statboard"]);

  assert.deepEqual(windowFolders(scope), [
    { name: ".devbox", path: ".devbox" },
    { name: "web-core", path: "web-core" },
    { name: "statboard", path: "statboard" },
  ]);
});

test("репозиторий, которого ещё нет на диске, в окно не попадает", () => {
  const scope = scopeWith(MANI, ["statboard"]);

  assert.deepEqual(windowFolders(scope).map((folder) => folder.name), [".devbox", "statboard"]);
});

test("в файле окна меняется только список папок: настройки и комментарии остаются", () => {
  const scope = scopeWith(MANI, ["web-core", "statboard"]);
  writeFileSync(
    join(scope.root, "tree.code-workspace"),
    `{
  // Окно скоупа.
  "folders": [
    { "name": ".devbox", "path": ".devbox" }
  ],
  "settings": {
    // Вкладка терминала показывает заголовок от программы.
    "terminal.integrated.tabs.title": "\${sequence}",
  }
}
`,
  );

  const report = syncWindow(scope);

  assert.deepEqual(report.added, ["web-core", "statboard"]);
  assert.deepEqual(report.removed, []);
  assert.deepEqual(foldersOf(scope), [
    { name: ".devbox", path: ".devbox" },
    { name: "web-core", path: "web-core" },
    { name: "statboard", path: "statboard" },
  ]);
  assert.match(windowOf(scope), /\/\/ Окно скоупа\./);
  assert.match(windowOf(scope), /\/\/ Вкладка терминала показывает заголовок от программы\./);
  assert.equal(parse(windowOf(scope)).settings["terminal.integrated.tabs.title"], "${sequence}");
});

test("репозиторий убрали из mani.yaml — его папка уходит из окна; повтор ничего не меняет", () => {
  const scope = scopeWith(MANI, ["web-core", "statboard"]);
  syncWindow(scope);

  writeFileSync(join(scope.configDir, "mani.yaml"), "projects:\n  statboard:\n    url: x\n    path: ../statboard\n");
  const report = syncWindow(scope);

  assert.deepEqual(report.removed, ["web-core"]);
  assert.deepEqual(report.added, []);

  const once = windowOf(scope);
  assert.deepEqual(syncWindow(scope), { folders: report.folders, added: [], removed: [] });
  assert.equal(windowOf(scope), once);
});

test("файла окна нет — он заводится со списком папок", () => {
  const scope = scopeWith(MANI, ["web-core"]);

  syncWindow(scope);

  assert.deepEqual(foldersOf(scope), [
    { name: ".devbox", path: ".devbox" },
    { name: "web-core", path: "web-core" },
  ]);
});

test("файл окна не разбирается — отказ, файл не тронут", () => {
  const scope = scopeWith(MANI);
  writeFileSync(join(scope.root, "tree.code-workspace"), "[1, 2]\n");

  assert.throws(() => syncWindow(scope), DevboxError);
  assert.equal(windowOf(scope), "[1, 2]\n");
});
