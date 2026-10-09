import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parse } from "smol-toml";

import { DevboxError } from "../../src/core/errors.ts";
import type { Runner } from "../../src/core/process.ts";
import { resolveScope } from "../../src/core/scope.ts";
import { type SecretsPaths, createKey, secretsPaths } from "../../src/core/secrets.ts";

const RECIPIENT = "age1testrecipient";

// Разобранный TOML — объекты без прототипа; для сравнения приводим к обычным.
const toml = (file: string): unknown => JSON.parse(JSON.stringify(parse(readFileSync(file, "utf8"))));

// age-keygen подменён: в проверках его нет.
function runner(): Runner {
  return {
    passthrough: () => 0,
    pipe: () => ({ code: 0, output: new Uint8Array() }),
    capture(command, args) {
      assert.equal(command, "age-keygen");
      if (args[0] === "-o") writeFileSync(args[1]!, "AGE-SECRET-KEY-TEST\n");

      return { code: 0, stdout: args[0] === "-y" ? `${RECIPIENT}\n` : "" };
    },
  };
}

function machine(): { paths: SecretsPaths } {
  const root = mkdtempSync(join(tmpdir(), "devbox-secrets-"));
  const scope = resolveScope(join(root, "tree"));

  return { paths: secretsPaths(scope, { FNOX_AGE_KEY_FILE: join(root, "secrets", "age.txt") }) };
}

test("ключ заводится вместе с конфигом секретов скоупа", () => {
  const { paths } = machine();

  assert.equal(createKey(paths, runner()), RECIPIENT);
  assert.ok(existsSync(paths.key));
  assert.deepEqual(toml(paths.config), {
    default_provider: "age",
    providers: { age: { type: "age", recipients: [RECIPIENT] } },
  });
});

test("в полученном от другого человека конфиге ключ дописывается к получателям, секреты целы", () => {
  const { paths } = machine();
  mkdirSync(join(paths.config, ".."), { recursive: true });
  writeFileSync(paths.config, 'default_provider = "age"\n\n[providers.age]\ntype = "age"\nrecipients = ["age1other"]\n\n[secrets]\nTOKEN = { provider = "age", value = "abc" }\n');

  createKey(paths, runner());

  const config = toml(paths.config) as { providers: { age: { recipients: string[] } }; secrets: unknown };
  assert.deepEqual(config.providers.age.recipients, ["age1other", RECIPIENT]);
  assert.deepEqual(config.secrets, { TOKEN: { provider: "age", value: "abc" } });
});

test("второй ключ поверх имеющегося не заводится", () => {
  const { paths } = machine();
  createKey(paths, runner());

  assert.throws(() => createKey(paths, runner()), DevboxError);
});
