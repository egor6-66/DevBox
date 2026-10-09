// Сборка: из одного ядра — два результата. В образ едут только они; исходников и сборщика в нём нет.
//
//   dist/devbox.mjs     команда `devbox`, один файл
//   dist/devbox.vsix    расширение редактора

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";

import { type BuildOptions, build } from "esbuild";

// Библиотеку берём в её ESM-сборке, если такая есть: UMD-обёртки (jsonc-parser) зовут свои части
// через `require` по ходу дела, и сборщик не может вложить их в один файл.
const common: BuildOptions = { bundle: true, platform: "node", target: "node24", logLevel: "warning", mainFields: ["module", "main"] };

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/extension", { recursive: true });

await build({
  ...common,
  entryPoints: ["src/cli/main.ts"],
  outfile: "dist/devbox.mjs",
  format: "esm",
  // Библиотека YAML приезжает в сборку в формате CommonJS и зовёт `require` для встроенных модулей;
  // в ESM-файле его нет, пока не заведёшь.
  banner: { js: '#!/usr/bin/env node\nimport { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);' },
});

// Расширение редактор грузит как CommonJS, а сам `vscode` даёт ему на месте.
await build({
  ...common,
  entryPoints: ["src/extension/extension.ts"],
  outfile: "dist/extension/extension.js",
  format: "cjs",
  external: ["vscode"],
});

for (const file of ["package.json", "README.md", "media"]) cpSync(`extension/${file}`, `dist/extension/${file}`, { recursive: true });

execFileSync("vsce", ["package", "--skip-license", "--no-dependencies", "--out", "../devbox.vsix"], {
  cwd: "dist/extension",
  stdio: "inherit",
});
