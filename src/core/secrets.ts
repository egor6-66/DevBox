import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { parse, stringify } from "smol-toml";

import { DevboxError } from "./errors.ts";
import type { Runner } from "./process.ts";
import type { Scope } from "./scope.ts";

// Секреты скоупа живут в двух местах:
//   · значения — шифртекстом в `.devbox/fnox/config.toml`. Это конфиг, он едет вместе с остальными;
//   · ключ, который их открывает, — в томе секретов. Туда же инструменты кладут свои входы.
//
// Здесь — только заведение ключа. Переносит секреты слепок скоупа (`snapshot.ts`): по отдельности
// ключ и шифртекст бесполезны, поэтому отдельного «переноса секретов» нет.
//
// Ключи — age: он уже стоит среди инструментов скоупа, своего здесь нет.

export interface SecretsPaths {
  // Том секретов.
  readonly dir: string;
  // Ключ age.
  readonly key: string;
  // Конфиг fnox с шифртекстом значений.
  readonly config: string;
}

// Где лежит ключ, задаёт образ; том секретов — папка, в которой он лежит.
export function secretsPaths(scope: Scope, env: NodeJS.ProcessEnv = process.env): SecretsPaths {
  const key = env.FNOX_AGE_KEY_FILE ?? join(homedir(), ".secrets", "age.txt");

  return { dir: dirname(key), key, config: join(scope.configDir, "fnox", "config.toml") };
}

export const hasKey = (paths: SecretsPaths): boolean => existsSync(paths.key);

// Завести ключ и вписать его открытую половину в конфиг секретов. Возвращает открытую половину.
export function createKey(paths: SecretsPaths, runner: Runner): string {
  if (hasKey(paths)) throw new DevboxError(`ключ уже есть: ${paths.key}. Второй заводить незачем — им открываются секреты этого скоупа.`);

  mkdirSync(paths.dir, { recursive: true });

  if (runner.capture("age-keygen", ["-o", paths.key], paths.dir).code !== 0) {
    throw new DevboxError("ключ не создан: нужен age (назовите его в .devbox/mise.toml и примените конфиги)");
  }

  return admitKey(paths, runner);
}

// Вписать открытую половину ключа в конфиг секретов скоупа: с этого момента ключом можно и
// читать секреты, и задавать новые.
function admitKey(paths: SecretsPaths, runner: Runner): string {
  const recipient = runner.capture("age-keygen", ["-y", paths.key], paths.dir).stdout.trim();

  if (!recipient.startsWith("age1")) throw new DevboxError(`открытая половина ключа не читается: ${paths.key}`);

  addRecipient(paths.config, recipient);

  return recipient;
}

// Конфиг fnox: провайдер age со списком тех, кому можно читать секреты. Нет файла — заводится;
// есть (скоуп получен от другого человека) — в список дописывается ещё один получатель.
function addRecipient(file: string, recipient: string): void {
  const config = existsSync(file) ? asRecord(parse(readFileSync(file, "utf8"))) : {};
  const providers = asRecord(config.providers);
  const age = asRecord(providers.age);
  const recipients = Array.isArray(age.recipients) ? age.recipients.filter((item) => typeof item === "string") : [];

  if (recipients.includes(recipient)) return;

  config.default_provider ??= "age";
  config.providers = { ...providers, age: { ...age, type: "age", recipients: [...recipients, recipient] } };

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, stringify(config));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}
