import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { Document, isMap, parse, parseDocument } from "yaml";

import { DevboxError } from "./errors.ts";
import type { Runner } from "./process.ts";
import type { Scope } from "./scope.ts";

// Линк приложения на локальные пакеты соседнего репозитория — ручное временное действие на время
// правки пакета. По умолчанию приложение берёт пакеты из реестра, как везде.
//
// link дописывает в `pnpm-workspace.yaml` ПРИЛОЖЕНИЯ блок `overrides` со ссылками на папки пакетов
// соседа и зовёт его `pnpm install` — то же, что `pnpm link <папка>`, только сразу для всех
// названных пакетов: без реестра линковать поштучно нельзя, каждая установка упрётся в остальные.
// pnpm при этом переписывает lock-файл приложения. Обе правки временные и не коммитятся; unlink
// откатывает их через git. В репозиторий соседа не пишется ничего.

// Что линковать у одного соседа: все пакеты, которые приложение использует, либо названные.
export type Wanted = "all" | readonly string[];

// `links.yaml`: приложение → сосед → что.
export type LinksConfig = Readonly<Record<string, Readonly<Record<string, Wanted>>>>;

export interface Linked {
  readonly name: string;
  // Папка пакета относительно корня скоупа — для отчёта человеку.
  readonly from: string;
}

export const LINKS_FILE = "links.yaml";

// Файлы приложения, которые линк меняет и откатывает.
const TOUCHED = ["pnpm-workspace.yaml", "pnpm-lock.yaml"] as const;
const WORKSPACE_FILE = TOUCHED[0];

// Отметка «прилинковано мной» лежит в `.git` клона: наружу она не уезжает, а без неё чужие
// незакоммиченные правки в тех же двух файлах нельзя отличить от своих.
const MARK = "devbox-link";

// Папки, в которые поиск пакетов не заходит.
const SKIPPED = new Set(["node_modules", "dist", ".git"]);

export const linksFile = (scope: Scope): string => join(scope.configDir, LINKS_FILE);

export function readLinks(scope: Scope): LinksConfig {
  const file = linksFile(scope);

  if (!existsSync(file)) throw new DevboxError(`нет конфига линков: ${file}`);

  const raw: unknown = parse(readFileSync(file, "utf8")) ?? {};

  if (!isRecord(raw)) throw new DevboxError(`${file}: ожидается «приложение: сосед: пакеты»`);

  for (const [app, neighbours] of Object.entries(raw)) {
    if (!isRecord(neighbours)) throw new DevboxError(`${file}: у «${app}» ожидается «сосед: пакеты»`);

    for (const [neighbour, wanted] of Object.entries(neighbours)) {
      const named = Array.isArray(wanted) && wanted.every((item) => typeof item === "string");

      if (wanted !== "all" && !named) {
        throw new DevboxError(`${file}: ${app} → ${neighbour}: ожидается список пакетов или слово all`);
      }
    }
  }

  return raw as LinksConfig;
}

export function link(scope: Scope, app: string, runner: Runner): Linked[] {
  const dir = join(scope.root, app);

  if (!existsSync(join(dir, "package.json"))) throw new DevboxError(`${app}: нет такого приложения в скоупе (${dir})`);

  const neighbours = readLinks(scope)[app];

  if (neighbours === undefined) throw new DevboxError(`${app}: не описан в ${linksFile(scope)}`);

  const mark = markOf(dir, runner);

  if (existsSync(mark)) {
    restore(dir, mark, runner);
  } else if (isDirty(dir, runner)) {
    throw new DevboxError(
      `${app}: в ${TOUCHED.join(" или ")} есть ваши незакоммиченные правки — откат линка их затрёт. Сохраните или откатите их сами.`,
    );
  }

  // Разрешаем всё ДО первой правки: неверное имя в конфиге не должно оставить приложение наполовину
  // прилинкованным.
  const linked = resolve(scope, app, dir, neighbours);

  if (linked.length === 0) throw new DevboxError(`${app}: линковать нечего — ни один пакет соседа приложением не используется`);

  const created = TOUCHED.filter((file) => !existsSync(join(dir, file)));
  writeFileSync(mark, `${JSON.stringify({ at: new Date().toISOString(), created })}\n`);

  writeOverrides(dir, linked);

  if (runner.passthrough("pnpm", ["install"], dir) !== 0) {
    throw new DevboxError(`${app}: установка не прошла. Ссылки записаны; откатить — devbox unlink ${app}`);
  }

  return linked.map((item) => ({ name: item.name, from: relative(scope.root, item.dir) }));
}

export function unlink(scope: Scope, app: string, runner: Runner): void {
  const dir = join(scope.root, app);

  if (!existsSync(join(dir, ".git"))) throw new DevboxError(`${app}: нет такого приложения в скоупе (${dir})`);

  const mark = markOf(dir, runner);

  if (!existsSync(mark)) throw new DevboxError(`${app}: не прилинкован командой devbox link — откатывать нечего`);

  restore(dir, mark, runner);

  if (runner.passthrough("pnpm", ["install"], dir) !== 0) {
    throw new DevboxError(
      `${app}: файлы возвращены, но установка из реестра не прошла — в node_modules остались прежние ссылки. Повторите pnpm install, когда реестр будет доступен.`,
    );
  }
}

// Приложения, названные в конфиге: то, что линкуется командой без имён.
export const linkedApps = (scope: Scope): string[] => Object.keys(readLinks(scope));

interface Resolved {
  readonly name: string;
  readonly dir: string;
}

function resolve(scope: Scope, app: string, dir: string, neighbours: Readonly<Record<string, Wanted>>): Resolved[] {
  const used = dependenciesOf(dir);

  return Object.entries(neighbours).flatMap(([neighbour, wanted]) => {
    const root = join(scope.root, neighbour);

    if (!existsSync(root)) throw new DevboxError(`${app}: соседа ${neighbour} нет в скоупе`);

    const packages = packagesOf(root);

    if (wanted === "all") return [...packages].filter(([name]) => used.has(name)).map(([name, at]) => ({ name, dir: at }));

    return wanted.map((item) => {
      const found = [...packages].find(([name, at]) => matches(item, name, at));

      if (found === undefined) throw new DevboxError(`${app}: у соседа ${neighbour} нет пакета «${item}»`);

      return { name: found[0], dir: found[1] };
    });
  });
}

// Пакет в конфиге называют полным именем, хвостом имени после `/` или именем его папки.
function matches(item: string, name: string, dir: string): boolean {
  return item === name || item === name.slice(name.lastIndexOf("/") + 1) || item === dir.slice(dir.lastIndexOf("/") + 1);
}

// Все package.json под папкой: имя пакета → его папка.
function packagesOf(root: string): Map<string, string> {
  const found = new Map<string, string>();

  for (const manifest of manifestsUnder(root)) {
    const name = readManifest(manifest).name;

    if (typeof name === "string" && !found.has(name)) found.set(name, dirname(manifest));
  }

  return found;
}

// Имена всех зависимостей приложения — из всех его package.json.
function dependenciesOf(root: string): Set<string> {
  const used = new Set<string>();

  for (const manifest of manifestsUnder(root)) {
    const { dependencies, devDependencies } = readManifest(manifest);

    for (const group of [dependencies, devDependencies]) {
      if (isRecord(group)) for (const name of Object.keys(group)) used.add(name);
    }
  }

  return used;
}

function manifestsUnder(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const here = entries.some((entry) => entry.isFile() && entry.name === "package.json") ? [join(dir, "package.json")] : [];

  return [
    ...here,
    ...entries
      .filter((entry) => entry.isDirectory() && !SKIPPED.has(entry.name))
      .flatMap((entry) => manifestsUnder(join(dir, entry.name))),
  ];
}

function readManifest(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));

    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeOverrides(dir: string, linked: readonly Resolved[]): void {
  const file = join(dir, WORKSPACE_FILE);
  const parsed = parseDocument(existsSync(file) ? readFileSync(file, "utf8") : "");
  // Файла нет или в нём одни комментарии — настройки начинаются с чистого листа.
  const document: Document = isMap(parsed.contents) ? parsed : new Document({});

  for (const item of linked) document.setIn(["overrides", item.name], `link:${relative(dir, item.dir)}`);

  writeFileSync(file, document.toString());
}

function markOf(dir: string, runner: Runner): string {
  const { code, stdout } = runner.capture("git", ["rev-parse", "--absolute-git-dir"], dir);

  if (code !== 0) throw new DevboxError(`${dir}: это не репозиторий git — линк откатывается через git`);

  return join(stdout.trim(), MARK);
}

function isDirty(dir: string, runner: Runner): boolean {
  return runner.capture("git", ["status", "--porcelain", "--", ...TOUCHED], dir).stdout.trim() !== "";
}

function restore(dir: string, mark: string, runner: Runner): void {
  const created = createdBy(mark);

  for (const file of TOUCHED) {
    const tracked = runner.capture("git", ["ls-files", "--error-unmatch", file], dir).code === 0;

    if (tracked) runner.capture("git", ["checkout", "--", file], dir);
    // Файла в репозитории не было — его завёл link.
    else if (created.includes(file)) rmSync(join(dir, file), { force: true });
  }

  rmSync(mark, { force: true });
}

function createdBy(mark: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(mark, "utf8"));
    const created = isRecord(parsed) ? parsed.created : undefined;

    return Array.isArray(created) ? created.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
