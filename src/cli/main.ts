import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

import { type Agent, agentName, findAgent, launchOf, listAgents } from "../core/agents.ts";
import { DevboxError } from "../core/errors.ts";
import { init } from "../core/init.ts";
import { link, linkedApps, unlink } from "../core/links.ts";
import { systemRunner } from "../core/process.ts";
import { type Scope, resolveScope } from "../core/scope.ts";

// Команда `devbox`: разбирает аргументы, зовёт ядро, печатает итог. Логики здесь нет — та же,
// что у расширения, лежит в `core`.

const USAGE = `Команды девбокса — то немногое, чего нет у готовых инструментов.

  devbox init                       разложить стартовые конфиги в пустом скоупе
  devbox agent [репозиторий роль]   запустить агента; без имён — выбор из списка
  devbox link [приложение…]         прилинковать, как написано в .devbox/links.yaml
  devbox unlink [приложение…]       вернуть приложение как было

При старте контейнера ничего из этого не запускается.`;

const say = (text: string): void => console.log(`[devbox] ${text}`);

type Command = (scope: Scope, args: readonly string[]) => Promise<number> | number;

const COMMANDS: Readonly<Record<string, Command>> = {
  init(scope) {
    const report = init(scope);

    for (const path of report.created) say(`создан ${path}`);
    for (const path of report.skipped) say(`уже есть, не тронут: ${path}`);

    if (report.created.length === 0) {
      say("все стартовые конфиги уже на месте");
    } else {
      say("дальше: впишите репозитории в .devbox/mani.yaml и пересоздайте контейнер (Rebuild Container)");
    }

    return 0;
  },

  async agent(scope, args) {
    if (args.length !== 0 && args.length !== 2) throw new DevboxError("ожидается: devbox agent [репозиторий роль]");

    const [repo, role] = args;
    const agent = repo !== undefined && role !== undefined ? findAgent(scope, repo, role) : await pickAgent(scope);
    const launch = launchOf(scope, agent);

    // Агент занимает терминал целиком и возвращает свой код.
    return spawnSync(launch.command, launch.args, { cwd: launch.cwd, stdio: "inherit" }).status ?? 1;
  },

  link(scope, args) {
    for (const app of args.length > 0 ? args : appsOf(scope)) {
      for (const item of link(scope, app, systemRunner)) say(`${app}: ${item.name} → ${item.from}`);
      say(`${app}: прилинкован. Не коммитьте pnpm-workspace.yaml и pnpm-lock.yaml, пока линк стоит.`);
    }

    return 0;
  },

  unlink(scope, args) {
    for (const app of args.length > 0 ? args : appsOf(scope)) {
      unlink(scope, app, systemRunner);
      say(`${app}: отлинкован, pnpm-workspace.yaml и pnpm-lock.yaml возвращены`);
    }

    return 0;
  },
};

function appsOf(scope: Scope): string[] {
  const apps = linkedApps(scope);

  if (apps.length === 0) throw new DevboxError("в конфиге линков не описано ни одного приложения");

  return apps;
}

async function pickAgent(scope: Scope): Promise<Agent> {
  const agents = listAgents(scope);

  if (agents.length === 0) throw new DevboxError("ролей не найдено: в репозиториях скоупа нет .claude/roles/*.json");

  console.log(columns(agents.map((agent, index) => `${String(index + 1).padStart(3)}) ${agentName(agent)}`)));

  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  // Ввод может закончиться раньше ответа (команду позвали без терминала): это отказ, а не ожидание.
  const answer = await new Promise<string>((resolve) => {
    prompt.once("close", () => resolve(""));
    void prompt.question("агент (номер): ").then(resolve, () => resolve(""));
  });
  prompt.close();

  const picked = /^\d+$/.test(answer.trim()) ? agents[Number(answer.trim()) - 1] : undefined;

  if (picked === undefined) throw new DevboxError(`нужен номер из списка: 1–${agents.length}`);

  return picked;
}

// Список в несколько колонок под ширину терминала: два десятка ролей в столбик не помещаются.
function columns(items: readonly string[]): string {
  const width = Math.max(...items.map((item) => item.length)) + 2;
  const perRow = Math.max(1, Math.floor((process.stdout.columns ?? 100) / width));
  const rows = Math.ceil(items.length / perRow);

  return Array.from({ length: rows }, (_, row) =>
    Array.from({ length: perRow }, (_, column) => items[column * rows + row] ?? "")
      .map((item) => item.padEnd(width))
      .join("")
      .trimEnd(),
  ).join("\n");
}

async function main(argv: readonly string[]): Promise<number> {
  const [name, ...args] = argv;

  if (name === undefined || name === "help" || name === "-h" || name === "--help") {
    console.log(USAGE);

    return name === undefined ? 1 : 0;
  }

  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;

  if (command === undefined) {
    console.error(USAGE);

    return 1;
  }

  try {
    return await command(resolveScope(), args);
  } catch (error) {
    if (!(error instanceof DevboxError)) throw error;

    console.error(`[devbox] ${error.message}`);

    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
