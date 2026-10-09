#!/bin/sh
# Проверки образа: то, без чего среда не поднимется. Один и тот же файл гоняют и человек перед
# Rebuild тестового окна, и GitHub на каждую отправку — второй список тех же проверок разошёлся бы
# с этим молча.
#
#   sh test/image.sh [образ]        по умолчанию devbox:dev
#
# Команда docker берётся из переменной DOCKER: там, где docker проброшен с хоста и зовётся иначе,
# её называют целиком, например DOCKER="sudo -n docker -H unix:///var/run/docker-host.sock".

image="${1:-devbox:dev}"
docker="${DOCKER:-docker}"
failed=0

# Проверка — команда внутри контейнера из образа: код 0 — прошла.
inside() {
  name="$1"
  shift
  if $docker run --rm "$image" sh -c "$*" >/dev/null 2>&1; then
    echo "ok    $name"
  else
    echo "FAIL  $name"
    failed=1
  fi
}

# Проверка метки: выражение jq над `devcontainer.metadata`.
label() {
  name="$1"
  if echo "$meta" | jq -e "$2" >/dev/null 2>&1; then
    echo "ok    $name"
  else
    echo "FAIL  $name"
    failed=1
  fi
}

# Команды старта и команда `devbox` зовут эти инструменты по имени.
inside "инструменты старта на месте" \
  'for t in mise pnpm git node; do command -v "$t" >/dev/null || exit 1; done'

# mise лежит в образе по постоянному пути: шимы в томе — ссылки на него.
inside "mise по постоянному пути" 'test -x /usr/local/bin/mise'
inside "шимы первыми в PATH" 'case "$PATH" in /home/node/.tools/mise/shims:*) ;; *) exit 1;; esac'

# Пустой том docker наполняет правами каталога, на который его смонтировали: каталог не
# принадлежит пользователю — первая же запись отказывает.
inside "точки монтирования принадлежат пользователю" \
  'for d in /home/node/.secrets /home/node/.tools /home/node/.pnpm-store /workspaces/tree; do [ "$(stat -c %U "$d")" = node ] || exit 1; done'

inside "путь к конфигу mise" '[ "$MISE_GLOBAL_CONFIG_FILE" = /workspaces/tree/.devbox/mise.toml ]'
inside "путь к конфигу mani" '[ "$MANI_CONFIG" = /workspaces/tree/.devbox/mani.yaml ]'
inside "путь к конфигу fnox" '[ "$FNOX_CONFIG_DIR" = /workspaces/tree/.devbox/fnox ]'
inside "путь к ключу age" '[ "$FNOX_AGE_KEY_FILE" = /home/node/.secrets/age.txt ]'

# Докачка навыков ходит в GitHub мимо сервера версий и при исчерпанном лимите валит весь старт.
inside "докачка навыков mise выключена" '[ "$(mise settings get skills.fetch 2>/dev/null)" = false ]'

# Браузера в образе нет — он по выбору, фичей. Но флаг, без которого он в контейнере не стартует,
# лежит заранее в папке флагов его запускалки.
inside "браузера в образе нет, флаг для него на месте" \
  '! command -v chromium >/dev/null && grep -q -- "--no-sandbox" /etc/chromium.d/devbox-no-sandbox'

# Команда девбокса: собрана, запускается, знает свои команды.
inside "команда devbox на месте" 'devbox --help | grep -q "devbox init" && devbox --help | grep -q "devbox unlink"'
inside "devbox без конфига линков говорит об этом, а не падает молча" \
  'devbox link 2>&1 | grep -q "нет конфига линков"'

# Новый скоуп пуст, и человеку не с чего начать: init раскладывает стартовые конфиги и ссылки,
# повторный запуск ничего не трогает. Разложенное обязано читаться инструментами, для которых оно.
inside "devbox init раскладывает стартовые конфиги в пустом скоупе" \
  'cd /workspaces/tree && devbox init >/dev/null && test -f .devbox/mise.toml -a -f .devbox/mani.yaml -a -f .devbox/links.yaml -a -f tree.code-workspace && test "$(readlink .mcp.json)" = .devbox/mcp.json && test "$(readlink .devbox/tree.code-workspace)" = ../tree.code-workspace && devbox init | grep -q "уже на месте"'
# Без сети: проверка, которая ходит за версиями инструментов, сама съедает часовой лимит GitHub.
inside "стартовые конфиги читаются: JSON разбирается, mise видит свой файл" \
  'cd /workspaces/tree && devbox init >/dev/null && node -e "for (const f of [\".mcp.json\", \".devbox/.vscode/tasks.json\", \"tree.code-workspace\"]) JSON.parse(require(\"fs\").readFileSync(f, \"utf8\"))" && mise config ls 2>/dev/null | grep -q "mise.toml.*mani"'

# Метку читает редактор: битый JSON или пропавшая команда — и среда молча не поднимается.
meta="$($docker image inspect "$image" --format '{{ index .Config.Labels "devcontainer.metadata" }}' 2>/dev/null)"
label "метка: пользователь node" '.[0].remoteUser == "node" and .[0].containerUser == "node"'

# Расширение девбокса едет в образе файлом, и редактору оно названо путём к этому файлу.
inside "расширение девбокса лежит в образе" 'test -s /usr/local/share/devbox/devbox.vsix'
label "метка: редактору названо расширение девбокса" \
  '.[0].customizations.vscode.extensions | index("/usr/local/share/devbox/devbox.vsix") != null'

# При подключении образ делает два дела родными командами: ставит инструменты и приводит
# репозитории к конфигу. Расширения ставит редактор, библиотеки и свои скрипты запускает человек.
attach='mise install && { test ! -f "$MANI_CONFIG" || mani sync --sync-gitignore=false --sync-remotes; }'
label "метка: при подключении — инструменты, затем репозитории, если есть их конфиг" \
  ".[0].postAttachCommand == $(printf '%s' "$attach" | jq -Rs .)"
label "метка: при создании контейнера образ ничего не запускает" '.[0] | has("postCreateCommand") | not'

# Новый скоуп пуст: ни конфигов, ни инструментов. Команда старта обязана пройти и на нём.
inside "пустой скоуп: команда старта проходит без ошибок" "cd /workspaces/tree && $attach"

if [ "$failed" -ne 0 ]; then
  echo "[проверки] образ $image не прошёл"
  exit 1
fi

echo "[проверки] образ $image прошёл"
