import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { DevboxError } from "./errors.ts";
import type { Scope } from "./scope.ts";

// Агент — роль, объявленная в самом репозитории (`.claude/roles/<роль>.json`). Списка агентов у
// девбокса нет: он каждый раз читает диск, поэтому второй копии, которая разошлась бы с
// репозиторием, не существует.
export interface Agent {
  readonly repo: string;
  readonly role: string;
}

// Чем запустить агента: одно описание на оба входа — команда исполняет его сама, расширение
// отправляет в терминал.
export interface Launch {
  // Имя сессии: Claude Code пишет его в заголовок терминала, по нему видно, кто где.
  readonly name: string;
  readonly cwd: string;
  readonly command: string;
  readonly args: readonly string[];
}

const ROLES_DIR = join(".claude", "roles");
const ROLE_SUFFIX = ".json";

const roleFile = (role: string): string => join(ROLES_DIR, `${role}${ROLE_SUFFIX}`);

export const agentName = (agent: Agent): string => `${agent.repo} · ${agent.role}`;

function names(dir: string, keep: (name: string) => boolean): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => keep(entry.name) && (entry.isDirectory() || entry.isFile()))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

// Все агенты скоупа: по репозиториям, внутри репозитория — по имени роли.
export function listAgents(scope: Scope): Agent[] {
  return names(scope.root, (name) => !name.startsWith(".")).flatMap((repo) =>
    names(join(scope.root, repo, ROLES_DIR), (name) => name.endsWith(ROLE_SUFFIX)).map((file) => ({
      repo,
      role: file.slice(0, -ROLE_SUFFIX.length),
    })),
  );
}

export function findAgent(scope: Scope, repo: string, role: string): Agent {
  const file = join(scope.root, repo, roleFile(role));

  if (!existsSync(file)) throw new DevboxError(`${repo}: нет роли «${role}» (${file})`);

  return { repo, role };
}

export function launchOf(scope: Scope, agent: Agent): Launch {
  const name = agentName(agent);

  return {
    name,
    cwd: join(scope.root, agent.repo),
    command: "claude",
    args: ["--settings", roleFile(agent.role), "-n", name],
  };
}
