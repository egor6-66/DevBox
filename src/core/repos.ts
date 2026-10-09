import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parse } from "yaml";

import { DevboxError } from "./errors.ts";
import type { Scope } from "./scope.ts";

// Репозитории скоупа — как их назвал человек в `mani.yaml`. Клонирует их сам mani; девбоксу список
// нужен, чтобы производить из него остальное (папки окна), а не просить человека назвать их дважды.
export interface Repo {
  readonly name: string;
  // Папка репозитория на диске.
  readonly dir: string;
}

export const REPOS_FILE = "mani.yaml";

export const reposFile = (scope: Scope): string => join(scope.configDir, REPOS_FILE);

// В порядке конфига. Нет файла — нет репозиториев: скоуп ещё пуст.
export function readRepos(scope: Scope): Repo[] {
  const file = reposFile(scope);

  if (!existsSync(file)) return [];

  let raw: unknown;

  try {
    raw = parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new DevboxError(`${file}: не разбирается — ${error instanceof Error ? error.message : String(error)}`);
  }

  const projects = isRecord(raw) ? raw.projects : undefined;

  if (!isRecord(projects)) return [];

  return Object.entries(projects).map(([name, project]) => {
    const path = isRecord(project) && typeof project.path === "string" ? project.path : name;

    // mani считает путь проекта от папки своего конфига.
    return { name, dir: resolve(scope.configDir, path) };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
