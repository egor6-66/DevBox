import { DevboxError } from "./errors.ts";
import type { Runner } from "./process.ts";
import { readRepos, reposFile } from "./repos.ts";
import { type Scope, hasConfigs } from "./scope.ts";
import { type WindowReport, syncWindow } from "./window.ts";

// «Применить конфиги»: привести скоуп к тому, что написано в `.devbox`. Человек правит только
// конфиги; всё, что лежит вне их папки, производится отсюда. Эту же операцию образ выполняет при
// подключении редактора — другой дороги к рабочему скоупу нет.
//
//  1. mise ставит инструменты по `mise.toml`. Когда всё уже стоит, это миг и без сети.
//  2. mani клонирует репозитории по `mani.yaml` и приводит их адреса к конфигу: названное в нём
//     ставится, поставленное руками мимо него — убирается.
//  3. Папки окна редактора вписываются по тому же `mani.yaml`.

export interface SyncReport {
  readonly window: WindowReport;
}

export function sync(scope: Scope, runner: Runner): SyncReport {
  if (runner.passthrough("mise", ["install"], scope.root) !== 0) {
    throw new DevboxError("инструменты не поставились — см. вывод mise выше. Репозитории не трогались.");
  }

  // Скоуп, в который ещё ничего не положили, остаётся пустым: файлы в нём заводит только человек,
  // кнопкой «Создать конфиги».
  if (!hasConfigs(scope)) return { window: { folders: [], added: [], removed: [] } };

  // Репозиториев в конфиге нет — mani не зовём: клонировать нечего, а самого mani может ещё не
  // быть (его ставит mise, если он назван в `mise.toml`).
  const cloned =
    readRepos(scope).length === 0 ||
    runner.passthrough("mani", ["sync", "--config", reposFile(scope), "--sync-gitignore=false", "--sync-remotes"], scope.root) === 0;

  // Окно приводится и тогда, когда клонирование споткнулось: то, что склонировалось, должно быть видно.
  const window = syncWindow(scope);

  if (!cloned) throw new DevboxError("не все репозитории склонировались — см. вывод mani выше. Окно приведено к тому, что есть на диске.");

  return { window };
}
