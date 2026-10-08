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

# Команды старта и `devbox link` зовут эти инструменты по имени.
inside "инструменты старта на месте" \
  'for t in mise pnpm jq yq git; do command -v "$t" >/dev/null || exit 1; done'

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

# Ручной линк на пакеты соседа: команда девбокса и разборщик её конфига.
inside "команда devbox и yq на месте" 'command -v yq >/dev/null && devbox --help | grep -q "devbox unlink"'
inside "devbox без конфига линков говорит об этом, а не падает молча" \
  'devbox link 2>&1 | grep -q "нет конфига линков"'

# Метку читает редактор: битый JSON или пропавшая команда — и среда молча не поднимается.
meta="$($docker image inspect "$image" --format '{{ index .Config.Labels "devcontainer.metadata" }}' 2>/dev/null)"
label "метка: пользователь node" '.[0].remoteUser == "node" and .[0].containerUser == "node"'
label "метка: при создании — mise install" '.[0].postCreateCommand == "mise install"'
# Расширение девбокса едет в образе файлом, и редактору оно названо путём к этому файлу.
inside "расширение девбокса лежит в образе" 'test -s /usr/local/share/devbox/devbox.vsix'
label "метка: редактору названо расширение девбокса" \
  '.[0].customizations.vscode.extensions | index("/usr/local/share/devbox/devbox.vsix") != null'

# При подключении образ делает одно — приводит репозитории к конфигу. Расширения ставит редактор по
# списку из devcontainer.json человека, библиотеки и свои скрипты запускает человек.
label "метка: при подключении — только репозитории, и только если есть их конфиг" \
  '.[0].postAttachCommand == "test ! -f \"$MANI_CONFIG\" || mani sync --sync-gitignore=false --sync-remotes"'

# Новый скоуп пуст: ни конфигов, ни инструментов. Обе команды старта обязаны пройти и на нём.
inside "пустой скоуп: команды старта проходят без ошибок" \
  'cd /workspaces/tree && mise install >/dev/null 2>&1 && { test ! -f "$MANI_CONFIG" || mani sync --sync-gitignore=false --sync-remotes; }'

if [ "$failed" -ne 0 ]; then
  echo "[проверки] образ $image не прошёл"
  exit 1
fi

echo "[проверки] образ $image прошёл"
