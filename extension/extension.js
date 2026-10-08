// Панель «Агенты»: дерево «репозиторий → роли», собранное с диска. Клик открывает терминал с
// именем «репозиторий · роль» и цветом репозитория и запускает в нём `devbox agent` — вся логика
// запуска живёт в команде девбокса, расширение только кнопки поверх неё.
//
// Зачем расширение, а не задача: терминалу задачи редактор даёт имя задачи и другого не
// принимает. Расширение создаёт терминал сразу с нужным именем.

const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");

// Цвета вкладок — по кругу, в порядке репозиториев.
const COLORS = ["terminal.ansiGreen", "terminal.ansiBlue", "terminal.ansiMagenta", "terminal.ansiYellow", "terminal.ansiCyan", "terminal.ansiRed"];

// Корень скоупа — папка, где лежит файл окна; без него — привычный путь девбокса.
function scopeRoot() {
  const file = vscode.workspace.workspaceFile;
  return file && file.scheme !== "untitled" ? path.dirname(file.fsPath) : "/workspaces/tree";
}

// Репозитории с ролями: [{ repo, roles: [имя, …] }], как лежат на диске.
function readRoles(root) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => {
      let files = [];
      try {
        files = fs.readdirSync(path.join(root, entry.name, ".claude", "roles"));
      } catch {
        // У репозитория нет ролей — в дереве его не будет.
      }
      const roles = files.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).sort();
      return { repo: entry.name, roles };
    })
    .filter((item) => item.roles.length > 0)
    .sort((a, b) => a.repo.localeCompare(b.repo));
}

const terminalName = (repo, role) => `${repo} · ${role}`;
const findTerminal = (name) => vscode.window.terminals.find((terminal) => terminal.name === name);

class AgentsProvider {
  constructor() {
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
  }

  refresh() {
    this.changed.fire();
  }

  getChildren(element) {
    const tree = readRoles(scopeRoot());
    if (!element) return tree.map((item, index) => ({ kind: "repo", ...item, color: COLORS[index % COLORS.length] }));
    if (element.kind === "repo") return element.roles.map((role) => ({ kind: "role", repo: element.repo, role, color: element.color }));
    return [];
  }

  getTreeItem(element) {
    if (element.kind === "repo") {
      const item = new vscode.TreeItem(element.repo, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon("repo", new vscode.ThemeColor(element.color));
      item.contextValue = "repo";
      return item;
    }

    const running = Boolean(findTerminal(terminalName(element.repo, element.role)));
    const item = new vscode.TreeItem(element.role, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(running ? "circle-filled" : "circle-outline", new vscode.ThemeColor(element.color));
    item.description = running ? "запущен" : "";
    item.tooltip = running ? "Открыт терминал с этим агентом — клик покажет его" : "Запустить агента в новом терминале";
    item.contextValue = "role";
    item.command = { command: "devbox.agents.launch", title: "Запустить агента", arguments: [element] };
    return item;
  }
}

// Один агент — один терминал: повторный клик показывает уже открытый, а не плодит второй.
function launch(element) {
  if (!element || element.kind !== "role") return;

  const name = terminalName(element.repo, element.role);
  const existing = findTerminal(name);
  if (existing) {
    existing.show();
    return;
  }

  const terminal = vscode.window.createTerminal({
    name,
    cwd: path.join(scopeRoot(), element.repo),
    iconPath: new vscode.ThemeIcon("robot"),
    color: new vscode.ThemeColor(element.color),
  });
  terminal.show();
  terminal.sendText(`devbox agent ${element.repo} ${element.role}`);
}

function activate(context) {
  const provider = new AgentsProvider();
  const refresh = () => provider.refresh();

  // Роль добавили или убрали в репозитории — дерево обновляется само.
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(scopeRoot(), "*/.claude/roles/*.json"));

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("devbox.agents", provider),
    vscode.commands.registerCommand("devbox.agents.refresh", refresh),
    vscode.commands.registerCommand("devbox.agents.launch", launch),
    vscode.window.onDidOpenTerminal(refresh),
    vscode.window.onDidCloseTerminal(refresh),
    watcher,
    watcher.onDidCreate(refresh),
    watcher.onDidDelete(refresh),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
