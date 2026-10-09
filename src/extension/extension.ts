import { dirname } from "node:path";

import * as vscode from "vscode";

import { type Agent, agentName, launchOf, listAgents } from "../core/agents.ts";
import { DevboxError } from "../core/errors.ts";
import { init } from "../core/init.ts";
import { type Scope, DEFAULT_ROOT, WINDOW_FILE, hasConfigs, resolveScope, windowFile } from "../core/scope.ts";
import { hasKey, secretsPaths } from "../core/secrets.ts";
import { hostPaths, pendingSnapshot } from "../core/snapshot.ts";

// Расширение — кнопки поверх ядра. Своей логики у него нет: список агентов, способ запуска и
// стартовые конфиги те же, что у команды `devbox`.
//
// Зачем оно, а не задача редактора: терминалу задачи редактор даёт имя задачи и другого не
// принимает, а расширение создаёт терминал сразу с именем агента.

// Цвета вкладок — по кругу, в порядке репозиториев.
const COLORS = ["terminal.ansiGreen", "terminal.ansiBlue", "terminal.ansiMagenta", "terminal.ansiYellow", "terminal.ansiCyan", "terminal.ansiRed"];

// Узел дерева: репозиторий или его роль.
type Node =
  | { readonly kind: "repo"; readonly repo: string; readonly color: string; readonly agents: readonly Agent[] }
  | { readonly kind: "agent"; readonly agent: Agent; readonly color: string };

// Корень скоупа — папка, где лежит файл окна; пока окна нет — открытая папка.
function currentScope(): Scope {
  const file = vscode.workspace.workspaceFile;

  if (file !== undefined && file.scheme !== "untitled") return resolveScope(dirname(file.fsPath));

  return resolveScope(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? DEFAULT_ROOT);
}

const findTerminal = (name: string): vscode.Terminal | undefined =>
  vscode.window.terminals.find((terminal) => terminal.name === name);

// Аргумент для оболочки: в одинарных кавычках, если в нём есть что-то кроме простых символов.
const quote = (value: string): string => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`);

class AgentsProvider implements vscode.TreeDataProvider<Node> {
  readonly #changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.#changed.event;

  refresh(): void {
    this.#changed.fire();
  }

  getChildren(node?: Node): Node[] {
    if (node?.kind === "agent") return [];
    if (node?.kind === "repo") return node.agents.map((agent) => ({ kind: "agent", agent, color: node.color }));

    const scope = currentScope();
    const byRepo = new Map<string, Agent[]>();

    for (const agent of listAgents(scope)) byRepo.set(agent.repo, [...(byRepo.get(agent.repo) ?? []), agent]);

    // Чем встретить человека в пустой панели, решает описание расширения — по этому ключу.
    void vscode.commands.executeCommand("setContext", "devbox.scope", hasConfigs(scope) ? "ready" : "empty");

    return [...byRepo].map(([repo, agents], index) => ({ kind: "repo", repo, agents, color: COLORS[index % COLORS.length] ?? COLORS[0]! }));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "repo") {
      const item = new vscode.TreeItem(node.repo, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon("repo", new vscode.ThemeColor(node.color));

      return item;
    }

    const running = findTerminal(agentName(node.agent)) !== undefined;
    const item = new vscode.TreeItem(node.agent.role, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(running ? "circle-filled" : "circle-outline", new vscode.ThemeColor(node.color));
    item.description = running ? "запущен" : "";
    item.tooltip = running ? "Открыт терминал с этим агентом — клик покажет его" : "Запустить агента в новом терминале";
    item.command = { command: "devbox.agents.launch", title: "Запустить агента", arguments: [node] };

    return item;
  }
}

// Панель «Скоуп»: действия над скоупом целиком — кнопками, чтобы не искать команды через F1.
interface Action {
  readonly label: string;
  readonly icon: string;
  readonly command: string;
  readonly tooltip: string;
}

const ACTIONS: readonly Action[] = [
  {
    label: "Применить конфиги",
    icon: "sync",
    command: "devbox.sync",
    tooltip: "Привести скоуп к конфигам из .devbox: инструменты, репозитории, папки окна",
  },
  {
    label: "Пересобрать контейнер",
    icon: "debug-restart",
    command: "devbox.rebuild",
    tooltip: "То же, что Dev Containers: Rebuild Container",
  },
];

const SNAPSHOT_ACTION: Action = {
  label: "Экспортировать слепок",
  icon: "package",
  command: "devbox.snapshot.export",
  tooltip: "Снять слепок скоупа в папку на вашем компьютере: конфиги, секреты и точная версия девбокса",
};

const KEY_ACTION: Action = {
  label: "Создать ключ секретов",
  icon: "key",
  command: "devbox.secrets.key",
  tooltip: "Завести ключ в томе секретов и конфиг секретов скоупа",
};

class ScopeProvider implements vscode.TreeDataProvider<Action> {
  readonly #changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.#changed.event;
  // Конфиги правили после последнего применения.
  pending = false;

  refresh(): void {
    this.#changed.fire();
  }

  getChildren(action?: Action): Action[] {
    const scope = currentScope();

    if (action !== undefined || !hasConfigs(scope)) return [];

    return [...ACTIONS, SNAPSHOT_ACTION, ...(hasKey(secretsPaths(scope)) ? [] : [KEY_ACTION])];
  }

  getTreeItem(action: Action): vscode.TreeItem {
    const item = new vscode.TreeItem(action.label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(action.icon);
    item.tooltip = action.tooltip;
    item.description = action.command === "devbox.sync" && this.pending ? "конфиги изменились" : "";
    item.command = { command: action.command, title: action.label };

    return item;
  }
}

const SYNC_TERMINAL = "devbox · применить";

// Применение идёт в терминале: оно качает и клонирует, и человек должен видеть, что происходит.
function applyConfigs(scopeView: ScopeProvider): void {
  const terminal = findTerminal(SYNC_TERMINAL) ?? vscode.window.createTerminal({ name: SYNC_TERMINAL, cwd: currentScope().root, iconPath: new vscode.ThemeIcon("sync") });

  terminal.show();
  terminal.sendText("devbox sync");

  scopeView.pending = false;
  scopeView.refresh();
}

const SCOPE_TERMINAL = "devbox · скоуп";

// Ключ и слепок — в терминале: пароль слепка спрашивает age, и спрашивает он у терминала.
function runInTerminal(command: string): void {
  const terminal = findTerminal(SCOPE_TERMINAL) ?? vscode.window.createTerminal({ name: SCOPE_TERMINAL, cwd: currentScope().root, iconPath: new vscode.ThemeIcon("package") });

  terminal.show();
  terminal.sendText(command);
}

function createKey(scopeView: ScopeProvider): void {
  runInTerminal("devbox secrets key");
  // Ключ появится чуть позже нажатия — набор кнопок сверяем, когда команда отработала.
  setTimeout(() => scopeView.refresh(), 3000);
}

async function exportSnapshot(): Promise<void> {
  const locked = "С паролем";
  const open = "Без пароля";
  const picked = await vscode.window.showQuickPick(
    [
      { label: locked, detail: "Развернуть слепок сможет только тот, кто знает пароль" },
      { label: open, detail: "Пароль не спрашивается; ключ и секреты едут открыто" },
    ],
    { title: "DevBox: слепок скоупа" },
  );

  if (picked !== undefined) runInTerminal(picked.label === open ? "devbox snapshot export --open" : "devbox snapshot export");
}

// Ключ памяти расширения: «слепок развёрнут, после открытия окна примени конфиги».
const JUST_RESTORED = "devbox.justRestored";

// Окно открыто из папки слепка, а скоуп пуст — разворачиваем сами. Когда появится файл окна,
// редактор перезагрузится в скоуп, и уже там применятся конфиги: инструменты и репозитории.
function restoreIfPending(context: vscode.ExtensionContext): boolean {
  const scope = currentScope();

  if (hasConfigs(scope) || pendingSnapshot(hostPaths()) === undefined) return false;

  void context.globalState.update(JUST_RESTORED, scope.root);
  runInTerminal("devbox snapshot restore");

  return true;
}

// Конфиг в `.devbox` сохранили — напоминаем применить, один раз на пачку правок.
function configsChanged(scopeView: ScopeProvider): void {
  if (scopeView.pending) return;

  scopeView.pending = true;
  scopeView.refresh();

  const apply = "Применить";

  void vscode.window.showInformationMessage("DevBox: конфиги скоупа изменились.", apply).then((picked) => {
    if (picked === apply) applyConfigs(scopeView);
  });
}

// Один агент — один терминал: повторный клик показывает уже открытый, а не плодит второй.
function launchAgent(node?: Node): void {
  if (node?.kind !== "agent") return;

  const launch = launchOf(currentScope(), node.agent);
  const existing = findTerminal(launch.name);

  if (existing !== undefined) {
    existing.show();

    return;
  }

  const terminal = vscode.window.createTerminal({
    name: launch.name,
    cwd: launch.cwd,
    iconPath: new vscode.ThemeIcon("robot"),
    color: new vscode.ThemeColor(node.color),
  });

  terminal.show();
  terminal.sendText([launch.command, ...launch.args].map(quote).join(" "));
}

// Ключ памяти расширения: «этот скоуп только что создан, после открытия окна скажи, что дальше».
const JUST_CREATED = "devbox.justCreated";

// Открыта папка скоупа, а не его окно, хотя файл окна есть — открываем окно сами. Редактор при
// этом перезагружается и дальше помнит окно, так что случается это один раз.
async function openWindowIfFolder(): Promise<boolean> {
  const folder = vscode.workspace.workspaceFolders?.[0];

  if (vscode.workspace.workspaceFile !== undefined || folder === undefined) return false;
  if (windowFile(resolveScope(folder.uri.fsPath)) === undefined) return false;

  // Адрес собирается от адреса папки: в контейнере у него своя схема, путём с диска её не получить.
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.joinPath(folder.uri, WINDOW_FILE));

  return true;
}

async function initScope(context: vscode.ExtensionContext, refresh: () => void): Promise<void> {
  const scope = currentScope();

  try {
    const report = init(scope);
    refresh();

    if (report.created.length === 0) {
      void vscode.window.showInformationMessage("DevBox: все стартовые конфиги уже на месте.");

      return;
    }

    // Окно сейчас перезагрузится в скоуп — подсказку «что дальше» покажет уже оно.
    await context.globalState.update(JUST_CREATED, scope.root);

    if (!(await openWindowIfFolder())) await greetNewScope(context);
  } catch (error) {
    if (!(error instanceof DevboxError)) throw error;

    void vscode.window.showErrorMessage(`DevBox: ${error.message}`);
  }
}

async function greetNewScope(context: vscode.ExtensionContext): Promise<void> {
  const scope = currentScope();

  if (context.globalState.get(JUST_CREATED) !== scope.root) return;

  await context.globalState.update(JUST_CREATED, undefined);

  const open = "Открыть mani.yaml";
  const picked = await vscode.window.showInformationMessage(
    "DevBox: конфиги скоупа созданы. Впишите репозитории в .devbox/mani.yaml и нажмите «Применить конфиги» в панели DevBox.",
    open,
  );

  if (picked === open) await vscode.window.showTextDocument(vscode.Uri.joinPath(vscode.Uri.file(scope.configDir), "mani.yaml"));
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new AgentsProvider();
  const scopeView = new ScopeProvider();
  const refresh = (): void => {
    provider.refresh();
    scopeView.refresh();
  };

  // Роль добавили или убрали в репозитории, появилась папка конфигов — панель обновляется сама.
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(currentScope().root, "{*/.claude/roles/*.json,.devbox}"),
  );

  // Файл окна появился в скоупе, открытом папкой (слепок развёрнут) — переходим в окно. Не сразу:
  // команда, которая его положила, ещё доделывает своё.
  const windowCreated = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(currentScope().root, WINDOW_FILE));

  // Правят то, из чего скоуп производится: список репозиториев и инструменты.
  const configs = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(currentScope().root, ".devbox/{mani.yaml,mise.toml}"));

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("devbox.scope", scopeView),
    vscode.commands.registerCommand("devbox.sync", () => applyConfigs(scopeView)),
    vscode.commands.registerCommand("devbox.rebuild", () => vscode.commands.executeCommand("remote-containers.rebuildContainer")),
    vscode.commands.registerCommand("devbox.secrets.key", () => createKey(scopeView)),
    vscode.commands.registerCommand("devbox.snapshot.export", exportSnapshot),
    configs,
    configs.onDidChange(() => configsChanged(scopeView)),
    vscode.window.registerTreeDataProvider("devbox.agents", provider),
    vscode.commands.registerCommand("devbox.agents.refresh", refresh),
    vscode.commands.registerCommand("devbox.agents.launch", launchAgent),
    vscode.commands.registerCommand("devbox.init", () => initScope(context, refresh)),
    vscode.window.onDidOpenTerminal(refresh),
    vscode.window.onDidCloseTerminal(refresh),
    windowCreated,
    windowCreated.onDidCreate(() => setTimeout(() => void openWindowIfFolder(), 2000)),
    watcher,
    watcher.onDidCreate(refresh),
    watcher.onDidDelete(refresh),
  );

  // Скоуп с файлом окна открыт папкой — переходим в окно; уже в окне — здороваемся, если он новый.
  void openWindowIfFolder().then(async (reopening) => {
    if (reopening || restoreIfPending(context)) return;

    if (context.globalState.get(JUST_RESTORED) === currentScope().root && vscode.workspace.workspaceFile !== undefined) {
      await context.globalState.update(JUST_RESTORED, undefined);
      applyConfigs(scopeView);

      return;
    }

    await greetNewScope(context);
  });
}

export function deactivate(): void {}
