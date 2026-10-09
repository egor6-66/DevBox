import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parse } from "yaml";

import { DevboxError } from "../../src/core/errors.ts";
import { link, unlink } from "../../src/core/links.ts";
import { type Runner, systemRunner } from "../../src/core/process.ts";
import { type Scope, resolveScope } from "../../src/core/scope.ts";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

const json = (file: string, value: unknown): void => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

// git — настоящий: откат линка держится на нём. pnpm подменён: ставить пакеты тесту незачем.
function runnerWith(pnpmCode = 0): Runner & { installs: string[] } {
  const installs: string[] = [];

  return {
    installs,
    capture: systemRunner.capture,
    pipe: systemRunner.pipe,
    passthrough(command, args, cwd) {
      assert.equal(command, "pnpm");
      assert.deepEqual(args, ["install", "--config.confirmModulesPurge=false"]);
      installs.push(cwd);
      // Настоящий pnpm при установке приводит lock-файл к настройкам: стоят ссылки — переписывает
      // его под них, ссылок нет — lock остаётся каким был.
      const settings = join(cwd, "pnpm-workspace.yaml");

      if (existsSync(settings) && readFileSync(settings, "utf8").includes("link:")) {
        writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n# linked\n");
      }

      return pnpmCode;
    },
  };
}

// Скоуп: приложение-репозиторий `app` и сосед `lib` с тремя пакетами.
function scopeWith(links: string): Scope {
  const scope = resolveScope(mkdtempSync(join(tmpdir(), "devbox-links-")));
  const app = join(scope.root, "app");

  mkdirSync(scope.configDir);
  writeFileSync(join(scope.configDir, "links.yaml"), links);

  mkdirSync(app);
  json(join(app, "package.json"), { name: "app", dependencies: { "@lib/ui": "^1.0.0", "@lib/store": "^1.0.0", react: "^19" } });
  writeFileSync(join(app, "pnpm-workspace.yaml"), "# настройки приложения\nallowBuilds:\n  esbuild: true\n");
  writeFileSync(join(app, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  git(app, "init", "-q");
  git(app, "add", ".");
  git(app, "commit", "-q", "-m", "init");

  for (const name of ["ui", "store", "unused"]) {
    mkdirSync(join(scope.root, "lib", name), { recursive: true });
    json(join(scope.root, "lib", name, "package.json"), { name: `@lib/${name}`, version: "1.0.0" });
  }

  // Копия пакета в node_modules соседа — не пакет соседа.
  mkdirSync(join(scope.root, "lib", "node_modules", "ui"), { recursive: true });
  json(join(scope.root, "lib", "node_modules", "ui", "package.json"), { name: "@lib/ui" });

  return scope;
}

const overridesOf = (scope: Scope): unknown => parse(readFileSync(join(scope.root, "app", "pnpm-workspace.yaml"), "utf8")).overrides;
const status = (scope: Scope): string => git(join(scope.root, "app"), "status", "--porcelain").trim();
const failure = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof DevboxError, String(error));

    return error.message;
  }

  return assert.fail("ожидался отказ");
};

test("all — линкуются только те пакеты соседа, которые приложение использует", () => {
  const scope = scopeWith("app:\n  lib: all\n");
  const runner = runnerWith();

  const linked = link(scope, "app", runner);

  assert.deepEqual(linked, [
    { name: "@lib/store", from: join("lib", "store") },
    { name: "@lib/ui", from: join("lib", "ui") },
  ]);
  assert.deepEqual(overridesOf(scope), { "@lib/store": "link:../lib/store", "@lib/ui": "link:../lib/ui" });
  assert.deepEqual(runner.installs, [join(scope.root, "app")]);
});

test("свои настройки приложения в файле сохраняются, комментарии тоже", () => {
  const scope = scopeWith("app:\n  lib: all\n");
  link(scope, "app", runnerWith());

  const text = readFileSync(join(scope.root, "app", "pnpm-workspace.yaml"), "utf8");

  assert.match(text, /# настройки приложения/);
  assert.deepEqual(parse(text).allowBuilds, { esbuild: true });
});

test("названные пакеты: полным именем, хвостом имени или именем папки", () => {
  const scope = scopeWith('app:\n  lib:\n    - ui\n    - "@lib/store"\n    - unused\n');

  const linked = link(scope, "app", runnerWith());

  assert.deepEqual(linked.map((item) => item.name), ["@lib/ui", "@lib/store", "@lib/unused"]);
});

test("unlink возвращает оба файла как были и ставит пакеты заново", () => {
  const scope = scopeWith("app:\n  lib: all\n");
  const runner = runnerWith();

  link(scope, "app", runner);
  assert.notEqual(status(scope), "");

  unlink(scope, "app", runner);

  assert.equal(status(scope), "");
  assert.equal(overridesOf(scope), undefined);
  assert.equal(runner.installs.length, 2);
});

test("повторный link переприменяет чисто, а не наслаивает", () => {
  const scope = scopeWith("app:\n  lib: all\n");
  link(scope, "app", runnerWith());

  writeFileSync(join(scope.configDir, "links.yaml"), "app:\n  lib:\n    - ui\n");
  link(scope, "app", runnerWith());

  assert.deepEqual(overridesOf(scope), { "@lib/ui": "link:../lib/ui" });
});

test("чужие незакоммиченные правки в тех же файлах — отказ, файлы не тронуты", () => {
  const scope = scopeWith("app:\n  lib: all\n");
  const file = join(scope.root, "app", "pnpm-workspace.yaml");
  writeFileSync(file, "# моя правка\n");

  assert.match(failure(() => link(scope, "app", runnerWith())), /ваши незакоммиченные правки/);
  assert.equal(readFileSync(file, "utf8"), "# моя правка\n");
});

test("неизвестный пакет в конфиге — отказ до первой правки", () => {
  const scope = scopeWith("app:\n  lib:\n    - ui\n    - nosuch\n");
  const runner = runnerWith();

  assert.match(failure(() => link(scope, "app", runner)), /у соседа lib нет пакета «nosuch»/);
  assert.equal(status(scope), "");
  assert.deepEqual(runner.installs, []);
});

test("установка не прошла — ссылки записаны, и unlink их откатывает", () => {
  const scope = scopeWith("app:\n  lib: all\n");

  assert.match(failure(() => link(scope, "app", runnerWith(1))), /установка не прошла.*devbox unlink app/);
  assert.notEqual(status(scope), "");

  assert.match(failure(() => unlink(scope, "app", runnerWith(1))), /файлы возвращены, но установка из реестра не прошла/);
  assert.equal(status(scope), "");
});

test("файла настроек у приложения не было — link заводит его, unlink убирает", () => {
  const scope = scopeWith("app:\n  lib: all\n");
  const app = join(scope.root, "app");
  git(app, "rm", "-q", "pnpm-workspace.yaml");
  git(app, "commit", "-q", "-m", "без настроек");

  link(scope, "app", runnerWith());
  assert.ok(existsSync(join(app, "pnpm-workspace.yaml")));

  unlink(scope, "app", runnerWith());
  assert.equal(existsSync(join(app, "pnpm-workspace.yaml")), false);
  assert.equal(status(scope), "");
});

test("отказы с понятной причиной: нет приложения, нет в конфиге, нет соседа, не линковали", () => {
  const scope = scopeWith("app:\n  nolib: all\nother:\n  lib: all\n");

  assert.match(failure(() => link(scope, "nosuch", runnerWith())), /нет такого приложения/);
  assert.match(failure(() => link(scope, "app", runnerWith())), /соседа nolib нет в скоупе/);
  assert.match(failure(() => unlink(scope, "app", runnerWith())), /не прилинкован командой devbox link/);

  writeFileSync(join(scope.configDir, "links.yaml"), "other:\n  lib: all\n");
  assert.match(failure(() => link(scope, "app", runnerWith())), /не описан в/);
});

test("конфиг линков: только комментарии — нечего линковать, кривой — отказ с местом", () => {
  const scope = scopeWith("# пока пусто\n");
  assert.match(failure(() => link(scope, "app", runnerWith())), /не описан в/);

  writeFileSync(join(scope.configDir, "links.yaml"), "app:\n  lib: everything\n");
  assert.match(failure(() => link(scope, "app", runnerWith())), /app → lib: ожидается список пакетов или слово all/);
});
