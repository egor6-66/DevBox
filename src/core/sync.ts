import { DevboxError } from "./errors.ts";
import type { Runner } from "./process.ts";
import { readRepos, reposFile } from "./repos.ts";
import { type Scope, hasConfigs } from "./scope.ts";
import { type ClaudeLayout, type LayoutReport, claudeLayoutFromEnv, layoutClaude } from "./volumes.ts";
import { type WindowReport, syncWindow } from "./window.ts";

// «Применить конфиги»: привести скоуп к тому, что написано в `.devbox`. Человек правит только
// конфиги; всё, что лежит вне их папки, производится отсюда. Эту же операцию образ выполняет при
// подключении редактора — другой дороги к рабочему скоупу нет.
//
//  0. Папка Claude Code раскладывается по томам (`volumes.ts`): сессии и кэш — в том кэша.
//  1. mise ставит инструменты по `mise.toml`. Когда всё уже стоит, это миг и без сети.
//  2. mani клонирует репозитории по `mani.yaml` и приводит их адреса к конфигу: названное в нём
//     ставится, поставленное руками мимо него — убирается.
//  3. Папки окна редактора вписываются по тому же `mani.yaml`.

export interface SyncReport {
  readonly window: WindowReport;
  // Раскладка папки Claude Code по томам; вне образа её нет.
  readonly claude?: LayoutReport;
}

// Раскладка томов приходит аргументом: по умолчанию её задаёт образ, а проверки передают свою или
// никакой — чтобы не раскладывать настоящую папку Claude Code того, кто их запустил.
export function sync(scope: Scope, runner: Runner, layout: ClaudeLayout | undefined = claudeLayoutFromEnv()): SyncReport {
  // Раньше всего остального: ссылки должны стоять до первого запуска Claude Code, иначе он
  // заведёт на их месте обычные папки — и сессии осядут в томе инструментов.
  const claude = layout === undefined ? undefined : layoutClaude(layout.config, layout.store);

  if (runner.passthrough("mise", ["install"], scope.root) !== 0) {
    throw new DevboxError("инструменты не поставились — см. вывод mise выше. Репозитории не трогались.");
  }

  // Скоуп, в который ещё ничего не положили, остаётся пустым: файлы в нём заводит только человек,
  // кнопкой «Создать конфиги».
  if (!hasConfigs(scope)) return { window: { folders: [], added: [], removed: [] }, claude };

  // Репозиториев в конфиге нет — mani не зовём: клонировать нечего, а самого mani может ещё не
  // быть (его ставит mise, если он назван в `mise.toml`).
  const cloned =
    readRepos(scope).length === 0 ||
    runner.passthrough("mani", ["sync", "--config", reposFile(scope), "--sync-gitignore=false", "--sync-remotes"], scope.root) === 0;

  // Окно приводится и тогда, когда клонирование споткнулось: то, что склонировалось, должно быть видно.
  const window = syncWindow(scope);

  if (!cloned) throw new DevboxError("не все репозитории склонировались — см. вывод mani выше. Окно приведено к тому, что есть на диске.");

  return { window, claude };
}
