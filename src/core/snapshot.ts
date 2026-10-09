import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { applyEdits, modify, parse } from "jsonc-parser";

import { DevboxError } from "./errors.ts";
import { ensureLinks } from "./init.ts";
import { type Runner, NOT_FOUND } from "./process.ts";
import { type Scope, CONFIG_DIR, WINDOW_FILE, hasConfigs } from "./scope.ts";
import type { SecretsPaths } from "./secrets.ts";

// Слепок скоупа — папка, из которой скоуп поднимается на другой машине одним действием: «Open
// Folder in Container». В ней два файла:
//   · `.devcontainer/devcontainer.json` — тот же, с которого работает окно, но с ТОЧНОЙ версией
//     образа: слепок и девбокс не могут разойтись;
//   · `scope.devbox` — конфиги `.devbox`, файл окна и том секретов. Под паролем, если он задан.
//
// Приватность решает пароль, а не два вида слепка: задан — без него слепок не развернуть; не
// задан — не спрашивается, но тогда ключ и секреты едут открыто.
//
// Папку на хосте, из которой открыто окно, образ видит по одной строке в `devcontainer.json`
// (`HOST_MOUNT`): оттуда берётся сам `devcontainer.json`, туда кладётся слепок, там же он
// ищется при развёртывании. Шифрование — age, упаковка — tar: своего здесь нет.

export interface HostPaths {
  // Папка хоста, из которой открыто окно, — как её видно изнутри.
  readonly dir: string;
  // Образ, на котором работает скоуп, с точной версией.
  readonly image: string;
}

export const SNAPSHOT_DIR = "snapshot";
export const SNAPSHOT_FILE = "scope.devbox";
export const HOST_TARGET = "/home/node/.host";
export const HOST_MOUNT = `source=\${localWorkspaceFolder},target=${HOST_TARGET},type=bind`;

// Имена томов в слепке — от имени папки, в которую его положат: тот же слепок в другой папке
// становится другим скоупом, а не садится на тома исходного.
const VOLUMES: Readonly<Record<string, string>> = {
  "/workspaces/tree": "repos",
  "/home/node/.secrets": "secrets",
  "/home/node/.tools": "tools",
  "/home/node/.store": "store",
};

const SECRETS_PREFIX = "secrets/";
const AGE_HEADER = "age-encryption.org/";

export function hostPaths(env: NodeJS.ProcessEnv = process.env): HostPaths {
  return { dir: env.DEVBOX_HOST_DIR ?? HOST_TARGET, image: env.DEVBOX_IMAGE ?? "devbox:dev" };
}

const containerFile = (dir: string): string => join(dir, ".devcontainer", "devcontainer.json");

// Слепок, ждущий развёртывания: окно открыто из его папки.
export function pendingSnapshot(host: HostPaths): string | undefined {
  const file = join(host.dir, SNAPSHOT_FILE);

  return existsSync(file) ? file : undefined;
}

export interface ExportReport {
  // Папка слепка, как её видно изнутри.
  readonly dir: string;
  readonly secrets: readonly string[];
}

// `open` — без пароля. С паролем его спрашивает сам age, в терминале.
export function exportSnapshot(scope: Scope, secrets: SecretsPaths, host: HostPaths, runner: Runner, open = false): ExportReport {
  if (!hasConfigs(scope)) throw new DevboxError("в скоупе нет конфигов — снимать слепок не с чего");

  const source = containerFile(host.dir);

  if (!existsSync(source)) {
    throw new DevboxError(
      `папка окна на хосте не видна (${host.dir}). Добавьте в "mounts" своего devcontainer.json строку "${HOST_MOUNT}" и пересоберите контейнер.`,
    );
  }

  const entries = existsSync(secrets.dir) ? readdirSync(secrets.dir).sort() : [];
  const archive = runner.pipe(
    "tar",
    [
      "-cz",
      "-C",
      scope.root,
      CONFIG_DIR,
      ...(existsSync(join(scope.root, WINDOW_FILE)) ? [WINDOW_FILE] : []),
      // Том секретов ложится в архив под своим именем-приставкой: пути `./…` есть только у него.
      ...(entries.length > 0 ? ["-C", secrets.dir, `--transform=s,^\\./,${SECRETS_PREFIX},SH`, ...entries.map((entry) => `./${entry}`)] : []),
    ],
    scope.root,
  );

  if (archive.code !== 0) throw new DevboxError("скоуп не упакован: tar завершился с ошибкой");

  const out = join(host.dir, SNAPSHOT_DIR);
  const file = join(out, SNAPSHOT_FILE);

  mkdirSync(join(out, ".devcontainer"), { recursive: true });

  if (open) {
    writeFileSync(file, archive.output);
  } else {
    const locked = runner.pipe("age", ["--encrypt", "--passphrase", "-o", file], scope.root, archive.output).code;

    if (locked === NOT_FOUND) throw new DevboxError("слепок не создан: в контейнере нет age");
    if (locked !== 0) throw new DevboxError("слепок не создан: пароли не совпали");
  }

  writeFileSync(containerFile(out), snapshotContainer(readFileSync(source, "utf8"), host.image));

  // Версии дополнений контейнера (features) закреплены соседним файлом — он едет как есть.
  const lock = join(host.dir, ".devcontainer", "devcontainer-lock.json");
  if (existsSync(lock)) copyFileSync(lock, join(out, ".devcontainer", "devcontainer-lock.json"));

  return { dir: out, secrets: entries };
}

// `devcontainer.json` слепка: тот же файл, в котором заменены образ и имена томов. Остальное —
// дополнения, расширения, комментарии человека — остаётся как было.
export function snapshotContainer(text: string, image: string): string {
  const config = (parse(text) ?? {}) as { workspaceMount?: unknown; mounts?: unknown };
  const mounts = Array.isArray(config.mounts) ? config.mounts : [];
  const format = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
  const edit = (current: string, path: (string | number)[], value: unknown): string => applyEdits(current, modify(current, path, value, format));

  let result = edit(text, ["image"], image);

  if (typeof config.workspaceMount === "string") result = edit(result, ["workspaceMount"], renameVolume(config.workspaceMount));

  mounts.forEach((mount, index) => {
    if (typeof mount === "string") result = edit(result, ["mounts", index], renameVolume(mount));
  });

  if (!mounts.some((mount) => typeof mount === "string" && mount.includes(`target=${HOST_TARGET}`))) {
    result = edit(result, ["mounts", mounts.length], HOST_MOUNT);
  }

  return result;
}

function renameVolume(mount: string): string {
  const fields = new Map(mount.split(",").map((field) => field.split("=", 2) as [string, string]));
  const role = VOLUMES[fields.get("target") ?? fields.get("dst") ?? ""];

  if (fields.get("type") !== "volume" || role === undefined) return mount;

  return mount.replace(/(^|,)(source|src)=[^,]*/, `$1$2=\${localWorkspaceFolderBasename}-${role}`);
}

export interface RestoreReport {
  readonly configs: readonly string[];
  readonly secrets: readonly string[];
}

// Развернуть слепок в пустой скоуп. Если он под паролем, пароль спрашивает age, в терминале.
export function restoreSnapshot(scope: Scope, secrets: SecretsPaths, file: string, runner: Runner): RestoreReport {
  if (!existsSync(file)) throw new DevboxError(`слепка нет: ${file}`);
  if (hasConfigs(scope)) throw new DevboxError(`в скоупе уже есть конфиги (${scope.configDir}) — слепок разворачивается только в пустой скоуп`);

  // Корня скоупа на чистом томе может ещё не быть, а программам нужна папка, из которой их звать.
  mkdirSync(scope.root, { recursive: true });

  const packed = readFileSync(file);
  const locked = packed.subarray(0, AGE_HEADER.length).toString("latin1") === AGE_HEADER;
  const archive = locked ? runner.pipe("age", ["--decrypt", file], scope.root) : { code: 0, output: packed };

  if (archive.code === NOT_FOUND) throw new DevboxError("слепок под паролем, а открыть его нечем: в контейнере нет age");
  if (archive.code !== 0) throw new DevboxError("слепок не открыт: неверный пароль");

  const listing = runner.pipe("tar", ["-tz"], scope.root, archive.output);

  if (listing.code !== 0) throw new DevboxError("это не слепок скоупа: внутри не архив");

  const members = Buffer.from(listing.output).toString("utf8").split("\n").filter((member) => member !== "" && !member.endsWith("/"));
  const secretFiles = members.filter((member) => member.startsWith(SECRETS_PREFIX)).map((member) => member.slice(SECRETS_PREFIX.length));
  const clashes = secretFiles.filter((member) => existsSync(join(secrets.dir, member)));

  // Молча заменить ключ — значит потерять секреты, зашифрованные прежним.
  if (clashes.length > 0) throw new DevboxError(`в томе секретов уже есть: ${clashes.join(", ")}. Слепок их заменил бы — разверните его на чистых томах.`);

  // Секреты — первыми: по появлению файла окна редактор перезагружается в скоуп, и к этому
  // моменту всё остальное уже должно лежать на месте.
  if (secretFiles.length > 0) {
    mkdirSync(secrets.dir, { recursive: true });

    if (runner.pipe("tar", ["-xz", "-C", secrets.dir, "--strip-components=1", SECRETS_PREFIX.slice(0, -1)], scope.root, archive.output).code !== 0) {
      throw new DevboxError("секреты не распакованы: tar завершился с ошибкой");
    }
  }

  if (runner.pipe("tar", ["-xz", "-C", scope.root, "--anchored", `--exclude=${SECRETS_PREFIX.slice(0, -1)}`], scope.root, archive.output).code !== 0) {
    throw new DevboxError("конфиги не распакованы: tar завершился с ошибкой");
  }

  // Ссылки вне папки конфигов (`.mcp.json` в корне скоупа) в слепок не входят — ставятся заново.
  ensureLinks(scope);

  return { configs: members.filter((member) => !member.startsWith(SECRETS_PREFIX)), secrets: secretFiles };
}
