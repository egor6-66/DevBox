import { existsSync } from "node:fs";
import { join } from "node:path";

// Скоуп — папка, в которой лежат репозитории и конфиги девбокса. Всё остальное ядро получает
// его аргументом и само пути не выдумывает.
export interface Scope {
  // Корень: здесь лежат репозитории и файл окна.
  readonly root: string;
  // Папка конфигов скоупа.
  readonly configDir: string;
}

export const DEFAULT_ROOT = "/workspaces/tree";
export const CONFIG_DIR = ".devbox";
// Файл окна редактора: папки скоупа и общие настройки. Лежит в корне скоупа.
export const WINDOW_FILE = "tree.code-workspace";

export function resolveScope(root: string = process.env.DEVBOX_SCOPE ?? DEFAULT_ROOT): Scope {
  return { root, configDir: join(root, CONFIG_DIR) };
}

// Скоуп, в который ещё ничего не положили: новому человеку здесь предлагают стартовые конфиги.
export const hasConfigs = (scope: Scope): boolean => existsSync(scope.configDir);

// Файл окна скоупа, если он уже есть.
export function windowFile(scope: Scope): string | undefined {
  const file = join(scope.root, WINDOW_FILE);

  return existsSync(file) ? file : undefined;
}
