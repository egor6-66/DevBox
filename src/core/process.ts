import { spawnSync } from "node:child_process";

// Единственное место, где ядро зовёт чужие программы (git, pnpm). Через него же тесты подменяют
// то, что в проверке запускать нельзя или незачем.
export interface Runner {
  // Запустить и забрать вывод: для вопросов к программе.
  capture(command: string, args: readonly string[], cwd: string): { code: number; stdout: string };
  // Запустить, отдав программе терминал: человек видит её вывод как есть.
  passthrough(command: string, args: readonly string[], cwd: string): number;
}

export const systemRunner: Runner = {
  capture(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: result.status ?? 1, stdout: result.stdout ?? "" };
  },

  passthrough(command, args, cwd) {
    return spawnSync(command, args, { cwd, stdio: "inherit" }).status ?? 1;
  },
};
