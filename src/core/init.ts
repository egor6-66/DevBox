import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { DevboxError } from "./errors.ts";
import type { Scope } from "./scope.ts";

// Стартовые конфиги скоупа. На новом, пустом скоупе человеку не с чего начать: набор файлов у
// девбокса свой, и что куда класть, без образца неочевидно. init раскладывает образец.
//
// Существующее не трогается никогда: конфиг, который человек уже правил, важнее шаблона.

export interface InitReport {
  // Пути относительно корня скоупа.
  readonly created: readonly string[];
  readonly skipped: readonly string[];
}

// Шаблоны едут в образе обычными файлами — их можно открыть и прочитать.
export const DEFAULT_TEMPLATES = "/usr/local/share/devbox/templates";

// Ссылки, которые нужны инструментам по их правилам поиска:
//  · Claude Code ищет `.mcp.json` вверх от репозитория — в корне скоупа, а сам конфиг лежит с
//    остальными в папке конфигов;
//  · файл окна редактор помнит по пути в корне скоупа, а видеть его удобно рядом с остальными.
const LINKS: readonly (readonly [at: string, to: string])[] = [
  [".mcp.json", join(".devbox", "mcp.json")],
  [join(".devbox", "tree.code-workspace"), join("..", "tree.code-workspace")],
];

export function templatesDir(): string {
  return process.env.DEVBOX_TEMPLATES ?? DEFAULT_TEMPLATES;
}

export function init(scope: Scope, templates: string = templatesDir()): InitReport {
  const source = join(templates, "scope");

  if (!existsSync(source)) throw new DevboxError(`шаблоны скоупа не найдены: ${source}`);

  const created: string[] = [];
  const skipped: string[] = [];

  for (const file of filesUnder(source)) {
    const path = relative(source, file);
    const target = join(scope.root, path);

    if (exists(target)) {
      skipped.push(path);
      continue;
    }

    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file, target);
    created.push(path);
  }

  const linked = ensureLinks(scope);

  created.push(...linked);
  skipped.push(...LINKS.map(([at]) => at).filter((at) => !linked.includes(at)));

  return { created, skipped };
}

// Поставить недостающие ссылки; занятое место не трогается. Возвращает созданные.
export function ensureLinks(scope: Scope): string[] {
  const created: string[] = [];

  for (const [at, to] of LINKS) {
    const target = join(scope.root, at);

    if (exists(target)) continue;

    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(to, target);
    created.push(at);
  }

  return created;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]));
}

// Занято ли место: висящая ссылка тоже считается — её кто-то положил намеренно.
function exists(path: string): boolean {
  try {
    lstatSync(path);

    return true;
  } catch {
    return false;
  }
}
