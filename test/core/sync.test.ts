import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parse } from "jsonc-parser";

import { DevboxError } from "../../src/core/errors.ts";
import type { Runner } from "../../src/core/process.ts";
import { type Scope, resolveScope } from "../../src/core/scope.ts";
import { sync } from "../../src/core/sync.ts";

const MANI = "projects:\n  app:\n    url: https://example.test/app.git\n    path: ../app\n";

// mise и mani подменены: «клонирование» заводит папку репозитория, как это сделал бы mani.
function runnerWith(codes: Readonly<Record<string, number>> = {}): Runner & { calls: string[] } {
  const calls: string[] = [];

  return {
    calls,
    capture: () => ({ code: 0, stdout: "" }),
    passthrough(command, args, cwd) {
      calls.push([command, ...args].join(" "));

      const code = codes[command] ?? 0;
      if (command === "mani" && code === 0) mkdirSync(join(cwd, "app"), { recursive: true });

      return code;
    },
  };
}

function scopeWith(mani?: string): Scope {
  const scope = resolveScope(mkdtempSync(join(tmpdir(), "devbox-sync-")));

  if (mani !== undefined) {
    mkdirSync(scope.configDir);
    writeFileSync(join(scope.configDir, "mani.yaml"), mani);
  }

  return scope;
}

const foldersOf = (scope: Scope): string[] =>
  parse(readFileSync(join(scope.root, "tree.code-workspace"), "utf8")).folders.map((folder: { name: string }) => folder.name);

test("по порядку: инструменты, репозитории своим конфигом, папки окна", () => {
  const scope = scopeWith(MANI);
  const runner = runnerWith();

  const report = sync(scope, runner);

  assert.deepEqual(runner.calls, [
    "mise install",
    `mani sync --config ${join(scope.configDir, "mani.yaml")} --sync-gitignore=false --sync-remotes`,
  ]);
  assert.deepEqual(report.window.added, [".devbox", "app"]);
  assert.deepEqual(foldersOf(scope), [".devbox", "app"]);
});

test("пустой скоуп остаётся пустым: mani не зовётся, файлов не появляется", () => {
  const scope = scopeWith();
  const runner = runnerWith();

  sync(scope, runner);

  assert.deepEqual(runner.calls, ["mise install"]);
  assert.deepEqual(readdirSync(scope.root), []);
});

test("репозиториев в конфигах нет — mani не зовётся, окно получает папку конфигов", () => {
  for (const mani of [undefined, "projects: {}\n", "# одни комментарии\n"]) {
    const scope = scopeWith(mani);
    mkdirSync(scope.configDir, { recursive: true });
    const runner = runnerWith();

    sync(scope, runner);

    assert.deepEqual(runner.calls, ["mise install"]);
    assert.deepEqual(foldersOf(scope), [".devbox"]);
  }
});

test("инструменты не поставились — отказ, репозитории и окно не трогаются", () => {
  const scope = scopeWith(MANI);
  const runner = runnerWith({ mise: 1 });

  assert.throws(() => sync(scope, runner), (error: unknown) => error instanceof DevboxError && /инструменты не поставились/.test(error.message));
  assert.deepEqual(runner.calls, ["mise install"]);
});

test("клонирование споткнулось — окно всё равно приведено к диску, а итог — отказ", () => {
  const scope = scopeWith(MANI);

  assert.throws(() => sync(scope, runnerWith({ mani: 1 })), (error: unknown) => error instanceof DevboxError && /не все репозитории склонировались/.test(error.message));
  assert.deepEqual(foldersOf(scope), [".devbox"]);
});
