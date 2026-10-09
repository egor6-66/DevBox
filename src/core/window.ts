import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { applyEdits, modify, parse } from "jsonc-parser";

import { DevboxError } from "./errors.ts";
import { readRepos } from "./repos.ts";
import { type Scope, CONFIG_DIR, WINDOW_FILE } from "./scope.ts";

// Файл окна редактора лежит вне папки конфигов, поэтому человек его не правит: список папок окна
// девбокс производит сам из `mani.yaml`. Вписал репозиторий в конфиг — его папка появилась в окне.
//
// Трогается только список папок. Остальное в файле (настройки редактора) остаётся как есть,
// вместе с комментариями: файл окна — JSON с комментариями, и правится он точечно.

export interface WindowFolder {
  readonly name: string;
  readonly path: string;
}

export interface WindowReport {
  readonly folders: readonly WindowFolder[];
  // Имена папок, которых в окне не было, и тех, что из него ушли.
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

const FORMAT = { tabSize: 2, insertSpaces: true, eol: "\n" } as const;

// Папки окна: сначала конфиги, потом репозитории в порядке `mani.yaml`. Конфиги первыми
// намеренно: редактор перезапускает расширения, когда меняется ПЕРВАЯ папка окна, а так она не
// меняется никогда, сколько репозиториев ни добавляй.
//
// Репозиторий, которого ещё нет на диске, в окно не попадает: пустая строка с ошибкой вместо
// папки хуже, чем её отсутствие до следующего применения.
export function windowFolders(scope: Scope): WindowFolder[] {
  return [
    { name: CONFIG_DIR, path: CONFIG_DIR },
    ...readRepos(scope)
      .filter((repo) => existsSync(repo.dir))
      .map((repo) => ({ name: repo.name, path: relative(scope.root, repo.dir) })),
  ];
}

export function syncWindow(scope: Scope): WindowReport {
  const file = join(scope.root, WINDOW_FILE);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "{}\n";
  const current: unknown = parse(text, [], { allowTrailingComma: true });

  if (typeof current !== "object" || current === null || Array.isArray(current)) {
    throw new DevboxError(`${file}: не разбирается как файл окна редактора`);
  }

  const before = namesOf((current as { folders?: unknown }).folders);
  const folders = windowFolders(scope);
  const after = folders.map((folder) => folder.name);

  const next = applyEdits(text, modify(text, ["folders"], folders, { formattingOptions: FORMAT }));

  if (next !== text) writeFileSync(file, next);

  return {
    folders,
    added: after.filter((name) => !before.includes(name)),
    removed: before.filter((name) => !after.includes(name)),
  };
}

function namesOf(folders: unknown): string[] {
  if (!Array.isArray(folders)) return [];

  return folders.flatMap((folder: unknown) => {
    if (typeof folder !== "object" || folder === null) return [];

    const { name, path } = folder as { name?: unknown; path?: unknown };

    return typeof name === "string" ? [name] : typeof path === "string" ? [path] : [];
  });
}
