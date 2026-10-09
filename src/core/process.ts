import { spawnSync } from "node:child_process";

// Единственное место, где ядро зовёт чужие программы (git, pnpm). Через него же тесты подменяют
// то, что в проверке запускать нельзя или незачем.
export interface Runner {
  // Запустить и забрать вывод: для вопросов к программе.
  capture(command: string, args: readonly string[], cwd: string): { code: number; stdout: string };
  // Запустить, отдав программе терминал: человек видит её вывод как есть.
  passthrough(command: string, args: readonly string[], cwd: string): number;
  // Прогнать байты через программу: вход — на её ввод, вывод — обратно байтами. Терминал при этом
  // остаётся у программы: спросить пароль она может сама, мимо этих байтов.
  pipe(command: string, args: readonly string[], cwd: string, input?: Uint8Array): { code: number; output: Uint8Array };
}

// Код «программа не найдена» — тот же, что у оболочки.
export const NOT_FOUND = 127;

export const systemRunner: Runner = {
  capture(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: result.status ?? 1, stdout: result.stdout ?? "" };
  },

  passthrough(command, args, cwd) {
    return spawnSync(command, args, { cwd, stdio: "inherit" }).status ?? 1;
  },

  pipe(command, args, cwd, input) {
    const result = spawnSync(command, args, { cwd, input, stdio: ["pipe", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 });

    // Программы нет вовсе — это не её отказ, и объяснять человеку надо другое.
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { code: NOT_FOUND, output: new Uint8Array() };

    return { code: result.status ?? 1, output: result.stdout ?? new Uint8Array() };
  },
};
