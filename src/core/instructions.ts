import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { templatesDir } from "./init.ts";
import type { Scope } from "./scope.ts";

// Указания агентам: как работать в скоупе. Агент — такой же пользователь девбокса, как человек,
// и без них он не знает ни команд, ни того, что `devbox link` переписывает lock-файл намеренно
// (найдено живьём 2026-10-09: агент принял штатный линк за поломку и стал её «чинить»).
//
// Claude Code читает `CLAUDE.md` вверх от репозитория, поэтому файл кладётся в корень скоупа и
// виден из всех репозиториев; в самих репозиториях ничего не появляется. Файл производит девбокс:
// своя часть едет в образе и обновляется вместе с ним, часть человека — `.devbox/agents.md`.

export const INSTRUCTIONS_FILE = "CLAUDE.md";
export const OWN_INSTRUCTIONS = "agents.md";

const MARK = "<!-- Этот файл производит девбокс (devbox sync). Свои указания пишите в .devbox/agents.md. -->";

export type InstructionsReport = "written" | "unchanged" | "foreign" | "no-template";

export function syncInstructions(scope: Scope, templates: string = templatesDir()): InstructionsReport {
  const source = join(templates, "agents", "devbox.md");

  if (!existsSync(source)) return "no-template";

  const file = join(scope.root, INSTRUCTIONS_FILE);
  const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;

  // Файл положил не девбокс — он чей-то, и затирать его нельзя.
  if (current !== undefined && !current.startsWith(MARK)) return "foreign";

  const own = join(scope.configDir, OWN_INSTRUCTIONS);
  const ownText = existsSync(own) ? readFileSync(own, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim() : "";
  const text = [MARK, readFileSync(source, "utf8").trim(), ...(ownText === "" ? [] : ["# Указания этого скоупа", ownText])].join("\n\n") + "\n";

  if (text === current) return "unchanged";

  writeFileSync(file, text);

  return "written";
}
