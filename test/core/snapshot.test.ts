import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parse } from "jsonc-parser";

import { type Runner, systemRunner } from "../../src/core/process.ts";
import { type Scope, resolveScope } from "../../src/core/scope.ts";
import { type SecretsPaths, secretsPaths } from "../../src/core/secrets.ts";
import { type HostPaths, HOST_MOUNT, exportSnapshot, pendingSnapshot, restoreSnapshot, snapshotContainer } from "../../src/core/snapshot.ts";

const IMAGE = "ghcr.io/someone/devbox:1.2.3";

const CONTAINER = `{
  // мой комментарий
  "image": "devbox:dev",
  "workspaceMount": "source=old-repos,target=/workspaces/tree,type=volume",
  "features": { "x": {} },
  "mounts": [
    "source=old-secrets,target=/home/node/.secrets,type=volume",
    "source=old-tools,target=/home/node/.tools,type=volume",
    "source=old-store,target=/home/node/.store,type=volume",
    "source=other,target=/data,type=volume"
  ]
}
`;

// tar — настоящий: слепок должен быть настоящим архивом. age подменён (в проверках его нет, а
// пароль он спрашивает у терминала): «шифрование» — заголовок age и перевёрнутые байты.
function runner(): Runner {
  const header = Buffer.from("age-encryption.org/v1\n");
  const flip = (bytes: Uint8Array): Uint8Array => bytes.map((byte) => byte ^ 0xff);

  return {
    passthrough: () => 0,
    capture: () => ({ code: 0, stdout: "" }),
    pipe(command, args, cwd, input) {
      if (command !== "age") return systemRunner.pipe(command, args, cwd, input);

      if (args[0] === "--encrypt") {
        writeFileSync(args.at(-1)!, Buffer.concat([header, flip(input!)]));

        return { code: 0, output: new Uint8Array() };
      }

      return { code: 0, output: flip(readFileSync(args.at(-1)!).subarray(header.length)) };
    },
  };
}

interface Machine {
  scope: Scope;
  secrets: SecretsPaths;
  host: HostPaths;
}

function machine(): Machine {
  const root = mkdtempSync(join(tmpdir(), "devbox-snapshot-"));
  const scope = resolveScope(join(root, "tree"));

  return { scope, secrets: secretsPaths(scope, { FNOX_AGE_KEY_FILE: join(root, "secrets", "age.txt") }), host: { dir: join(root, "host"), image: IMAGE } };
}

// Скоуп с конфигами, файлом окна, секретами и папкой окна на хосте.
function working(): Machine {
  const m = machine();

  mkdirSync(join(m.scope.configDir, "fnox"), { recursive: true });
  writeFileSync(join(m.scope.configDir, "mani.yaml"), "projects: {}\n");
  writeFileSync(join(m.scope.configDir, "mcp.json"), "{}\n");
  writeFileSync(join(m.scope.configDir, "fnox", "config.toml"), "шифртекст\n");
  writeFileSync(join(m.scope.root, "tree.code-workspace"), '{ "folders": [] }\n');
  symlinkSync("../tree.code-workspace", join(m.scope.configDir, "tree.code-workspace"));
  mkdirSync(join(m.scope.root, "repo"));
  writeFileSync(join(m.scope.root, "repo", "code.ts"), "");

  mkdirSync(join(m.secrets.dir, "gh"), { recursive: true });
  writeFileSync(m.secrets.key, "AGE-SECRET-KEY-TEST\n");
  writeFileSync(join(m.secrets.dir, "gh", "hosts.yml"), "token\n");

  mkdirSync(join(m.host.dir, ".devcontainer"), { recursive: true });
  writeFileSync(join(m.host.dir, ".devcontainer", "devcontainer.json"), CONTAINER);
  writeFileSync(join(m.host.dir, ".devcontainer", "devcontainer-lock.json"), "{}\n");

  return m;
}

// Вторая машина: окно открыто из папки слепка, тома пусты.
function deployTo(from: Machine): Machine {
  const to = machine();

  return { ...to, host: { dir: join(from.host.dir, "snapshot"), image: IMAGE } };
}

for (const open of [false, true]) {
  test(`слепок ${open ? "без пароля" : "под паролем"} поднимает скоуп на другой машине как был`, () => {
    const from = working();

    const exported = exportSnapshot(from.scope, from.secrets, from.host, runner(), open);

    assert.deepEqual(exported.secrets, ["age.txt", "gh"]);
    assert.equal(readFileSync(join(exported.dir, "scope.devbox")).subarray(0, 18).toString() === "age-encryption.org", !open);
    assert.ok(existsSync(join(exported.dir, ".devcontainer", "devcontainer-lock.json")));

    const to = deployTo(from);
    const file = pendingSnapshot(to.host);
    assert.ok(file !== undefined);

    const restored = restoreSnapshot(to.scope, to.secrets, file, runner());

    assert.deepEqual([...restored.secrets].sort(), ["age.txt", "gh/hosts.yml"]);
    assert.equal(readFileSync(join(to.scope.configDir, "fnox", "config.toml"), "utf8"), "шифртекст\n");
    assert.equal(readFileSync(join(to.scope.root, "tree.code-workspace"), "utf8"), '{ "folders": [] }\n');
    assert.equal(readlinkSync(join(to.scope.configDir, "tree.code-workspace")), "../tree.code-workspace");
    assert.equal(readlinkSync(join(to.scope.root, ".mcp.json")), join(".devbox", "mcp.json"));
    assert.equal(readFileSync(to.secrets.key, "utf8"), "AGE-SECRET-KEY-TEST\n");
    assert.equal(readFileSync(join(to.secrets.dir, "gh", "hosts.yml"), "utf8"), "token\n");
    // Репозитории в слепок не входят — их клонирует применение конфигов; секреты не лежат в скоупе.
    assert.equal(existsSync(join(to.scope.root, "repo")), false);
    assert.equal(existsSync(join(to.scope.root, "secrets")), false);
  });
}

test("devcontainer.json слепка: точная версия образа, тома по имени папки, остальное как было", () => {
  const text = snapshotContainer(CONTAINER, IMAGE);
  const config = parse(text) as { image: string; workspaceMount: string; mounts: string[]; features: unknown };

  assert.equal(config.image, IMAGE);
  assert.equal(config.workspaceMount, "source=${localWorkspaceFolderBasename}-repos,target=/workspaces/tree,type=volume");
  assert.deepEqual(config.mounts, [
    "source=${localWorkspaceFolderBasename}-secrets,target=/home/node/.secrets,type=volume",
    "source=${localWorkspaceFolderBasename}-tools,target=/home/node/.tools,type=volume",
    "source=${localWorkspaceFolderBasename}-store,target=/home/node/.store,type=volume",
    "source=other,target=/data,type=volume",
    HOST_MOUNT,
  ]);
  assert.deepEqual(config.features, { x: {} });
  assert.ok(text.includes("// мой комментарий"));
  // Повторный снимок со слепка ничего не дописывает второй раз.
  assert.equal(snapshotContainer(text, IMAGE), text);
});

test("слепок разворачивается только в пустой скоуп и не затирает чужой ключ", () => {
  const from = working();
  exportSnapshot(from.scope, from.secrets, from.host, runner(), true);
  const file = pendingSnapshot(deployTo(from).host)!;

  assert.throws(() => restoreSnapshot(from.scope, from.secrets, file, runner()), /уже есть конфиги/);

  const to = deployTo(from);
  mkdirSync(to.secrets.dir, { recursive: true });
  writeFileSync(to.secrets.key, "MINE\n");

  assert.throws(() => restoreSnapshot(to.scope, to.secrets, file, runner()), /age\.txt/);
  assert.equal(readFileSync(to.secrets.key, "utf8"), "MINE\n");
  assert.equal(existsSync(to.scope.configDir), false);
});

test("скоуп без секретов и окно без папки хоста", () => {
  const from = working();
  const bare: Machine = { ...from, secrets: { ...from.secrets, dir: join(from.host.dir, "..", "none") } };

  assert.deepEqual(exportSnapshot(bare.scope, bare.secrets, bare.host, runner(), true).secrets, []);

  const to = deployTo(from);
  assert.deepEqual(restoreSnapshot(to.scope, to.secrets, pendingSnapshot(to.host)!, runner()).secrets, []);
  assert.ok(lstatSync(to.scope.configDir).isDirectory());

  assert.throws(() => exportSnapshot(from.scope, from.secrets, { dir: join(from.host.dir, "missing"), image: IMAGE }, runner(), true), /mounts/);
  assert.equal(pendingSnapshot(from.host), undefined);
});
