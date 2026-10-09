import { existsSync, lstatSync, mkdirSync, readdirSync, rmdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";

// Три тома — три смысла, и смешивать их нельзя:
//   секреты      только ключи, входы и переменные — маленький том, который уезжает слепком;
//   инструменты  программы, их плагины и настройки;
//   кэш          сессии и кэш — тяжёлое и восстановимое.
//
// Claude Code держит всё своё в одной папке. Сама папка стоит в томе инструментов (настройки,
// плагины, навыки), входа в ней нет вовсе — он задан секретной переменной, — а то, что по смыслу
// сессии и кэш, уведено в том кэша ссылками на папки. Ссылки именно на ПАПКИ: файл Claude Code
// переписывает заменой, и ссылка на файл после первой записи стала бы обычным файлом.

// Папки Claude Code, которые по смыслу сессии и кэш (по его документации, раздел о его папке).
export const CLAUDE_STORE_DIRS = [
  "projects",
  "sessions",
  "file-history",
  "paste-cache",
  "shell-snapshots",
  "session-env",
  "tasks",
  "plans",
  "debug",
  "cache",
  "backups",
  "usage-data",
  "image-cache",
  "uploads",
  "telemetry",
] as const;

export interface LayoutReport {
  // Папки, которые только что уведены в том кэша.
  readonly linked: readonly string[];
  // Папки, где уже лежит накопленное: их не трогаем, переносить чужие данные молча нельзя.
  readonly kept: readonly string[];
}

export interface ClaudeLayout {
  // Папка Claude Code — в томе инструментов.
  readonly config: string;
  // Куда уходят его сессии и кэш — в томе кэша.
  readonly store: string;
}

// Где что стоит, задаёт образ — переменными окружения. Вне образа раскладывать нечего.
export function claudeLayoutFromEnv(env: NodeJS.ProcessEnv = process.env): ClaudeLayout | undefined {
  const config = env.CLAUDE_CONFIG_DIR;
  const store = env.DEVBOX_STORE_DIR;

  return config !== undefined && store !== undefined ? { config, store: join(store, "claude") } : undefined;
}

export function layoutClaude(config: string, store: string): LayoutReport {
  const linked: string[] = [];
  const kept: string[] = [];

  mkdirSync(config, { recursive: true });

  for (const name of CLAUDE_STORE_DIRS) {
    const at = join(config, name);
    const target = join(store, name);

    mkdirSync(target, { recursive: true });

    const state = stateOf(at);

    if (state === "link") continue;

    if (state === "filled") {
      kept.push(name);
      continue;
    }

    if (state === "empty") rmdirSync(at);

    symlinkSync(target, at);
    linked.push(name);
  }

  return { linked, kept };
}

function stateOf(path: string): "absent" | "link" | "empty" | "filled" {
  if (!existsSync(path) && !isLink(path)) return "absent";
  if (isLink(path)) return "link";

  return readdirSync(path).length === 0 ? "empty" : "filled";
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
