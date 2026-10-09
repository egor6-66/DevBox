import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CLAUDE_STORE_DIRS, claudeLayoutFromEnv, layoutClaude } from "../../src/core/volumes.ts";

function volumes() {
  const root = mkdtempSync(join(tmpdir(), "devbox-volumes-"));

  return { config: join(root, "tools", "claude"), store: join(root, "store", "claude") };
}

test("сессии и кэш Claude Code уходят в том кэша ссылками на папки", () => {
  const { config, store } = volumes();

  const report = layoutClaude(config, store);

  assert.deepEqual(report.linked, [...CLAUDE_STORE_DIRS]);
  assert.deepEqual(report.kept, []);

  for (const name of CLAUDE_STORE_DIRS) {
    assert.equal(readlinkSync(join(config, name)), join(store, name));
    assert.ok(lstatSync(join(store, name)).isDirectory());
  }

  // Запись «в папку Claude» ложится в том кэша.
  writeFileSync(join(config, "projects", "session.jsonl"), "{}\n");
  assert.equal(readFileSync(join(store, "projects", "session.jsonl"), "utf8"), "{}\n");
});

test("повторный запуск ничего не меняет", () => {
  const { config, store } = volumes();
  layoutClaude(config, store);

  assert.deepEqual(layoutClaude(config, store), { linked: [], kept: [] });
});

test("пустая обычная папка заменяется ссылкой, папка с накопленным остаётся как есть", () => {
  const { config, store } = volumes();
  mkdirSync(join(config, "cache"), { recursive: true });
  mkdirSync(join(config, "projects"), { recursive: true });
  writeFileSync(join(config, "projects", "old.jsonl"), "{}\n");

  const report = layoutClaude(config, store);

  assert.deepEqual(report.kept, ["projects"]);
  assert.ok(report.linked.includes("cache"));
  assert.equal(lstatSync(join(config, "cache")).isSymbolicLink(), true);
  assert.equal(lstatSync(join(config, "projects")).isSymbolicLink(), false);
  assert.deepEqual(readdirSync(join(config, "projects")), ["old.jsonl"]);
});

test("настройки, плагины и навыки в раскладку не входят — они остаются в томе инструментов", () => {
  for (const name of ["settings.json", "plugins", "skills", "agents", "commands", ".claude.json", ".credentials.json"]) {
    assert.equal((CLAUDE_STORE_DIRS as readonly string[]).includes(name), false);
  }
});

test("где что стоит, задаёт образ; вне образа раскладывать нечего", () => {
  assert.deepEqual(claudeLayoutFromEnv({ CLAUDE_CONFIG_DIR: "/t/claude", DEVBOX_STORE_DIR: "/s" }), { config: "/t/claude", store: "/s/claude" });
  assert.equal(claudeLayoutFromEnv({ CLAUDE_CONFIG_DIR: "/t/claude" }), undefined);
  assert.equal(claudeLayoutFromEnv({}), undefined);
});
