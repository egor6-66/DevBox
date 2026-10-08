# Образ девбокса: окружение целиком одним слепком — Node, mise и пути, по которым человек монтирует тома.
# При старте контейнера работают родные команды инструментов (метка внизу); своя команда одна —
# ручной линк на пакеты соседа (`bin/devbox`).
FROM mcr.microsoft.com/devcontainers/typescript-node:24

RUN corepack enable

# mise ставит инструменты скоупа по его конфигу. Сам он лежит в ОБРАЗЕ, по постоянному пути:
# шимы инструментов в томе — ссылки на него, и после пересоздания контейнера они обязаны вести сюда же.
ARG MISE_VERSION=v2026.10.3
RUN curl -fsSL https://mise.run | MISE_VERSION=${MISE_VERSION} MISE_INSTALL_PATH=/usr/local/bin/mise sh

# Линк приложения на локальные пакеты соседа — единственный собственный код девбокса: команда
# `devbox link` / `devbox unlink` читает `.devbox/links.yaml` скоупа. Запускает её человек; при
# старте контейнера она не зовётся. Конфиг разбирает yq — рыночный разборщик YAML, одним файлом.
ARG YQ_VERSION=v4.54.1
ARG TARGETARCH
RUN curl -fsSL "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_${TARGETARCH:-amd64}" -o /usr/local/bin/yq \
    && chmod +x /usr/local/bin/yq
COPY bin/devbox /usr/local/bin/devbox
RUN chmod +x /usr/local/bin/devbox

# Креды и кэши — ПУТИ, по которым человек монтирует свои тома. Сами тома образ не объявляет.
ENV CLAUDE_CONFIG_DIR=/home/node/.secrets/claude \
    GIT_CONFIG_GLOBAL=/home/node/.secrets/gitconfig \
    GH_CONFIG_DIR=/home/node/.secrets/gh \
    NPM_CONFIG_USERCONFIG=/home/node/.secrets/npmrc \
    NPM_CONFIG_STORE_DIR=/home/node/.pnpm-store \
    PNPM_CONFIG_STORE_DIR=/home/node/.pnpm-store \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# Инструменты живут в томе, а не в контейнере: mise держит поставленное на точке монтирования, его
# конфиг лежит в скоупе, шимы стоят в PATH. Пересоздание контейнера ничего не качает заново.
ENV MISE_DATA_DIR=/home/node/.tools/mise \
    MISE_GLOBAL_CONFIG_FILE=/workspaces/tree/.devbox/mise.toml \
    PATH=/home/node/.tools/mise/shims:$PATH

# Репозитории — mani: конфиг лежит в папке конфигов скоупа, поэтому путь к нему назван явно —
# сам mani ищет `mani.yaml` только вверх от текущей папки.
ENV MANI_CONFIG=/workspaces/tree/.devbox/mani.yaml

# Секреты — fnox: конфиг с шифртекстом лежит в папке конфигов скоупа как ОБЩИЙ (`config.toml` в
# FNOX_CONFIG_DIR — другого способа назвать путь у fnox нет), ключ age — в томе секретов.
# Значение задаётся с флагом `-g`: без него fnox заводит отдельный `fnox.toml` в текущей папке.
# В терминале значения подаёт его активация.
ENV FNOX_CONFIG_DIR=/workspaces/tree/.devbox/fnox \
    FNOX_AGE_KEY_FILE=/home/node/.secrets/age.txt
RUN echo 'command -v fnox >/dev/null 2>&1 && eval "$(fnox activate bash)"' >> /etc/bash.bashrc

# Точки монтирования готовятся ЗДЕСЬ, и это не перестраховка: пустой том docker наполняет
# содержимым и правами того каталога, на который его смонтировали. Каталога нет — том достаётся
# root'у, и первая же запись от пользователя отказывает.
RUN mkdir -p /home/node/.secrets /home/node/.tools /home/node/.pnpm-store /workspaces/tree \
    && chown -R node:node /home/node /workspaces

# Настройки контейнера едут В ОБРАЗЕ: редактор читает их метаданными и сливает со своим файлом,
# поэтому у человека на хосте остаются только образ и тома.
# При создании контейнера: mise ставит инструменты по `mise.toml`.
# При подключении редактора — три шага ПО ОЧЕРЕДИ, одной командой:
#  1. mani клонирует репозитории по `mani.yaml` и приводит их адреса (remotes) к конфигу: названное
#     в нём ставится, поставленное руками мимо него — убирается. Сменённый в конфиге адрес встаёт
#     со второго прогона: первый его только снимает (mani 0.32.1, 2026-10-07). Именно здесь, а не
#     при создании: закрытым репозиториям нужен логин, а его в контейнер передаёт редактор.
#  2. Ставятся расширения, названные в `*.code-workspace` скоупа: сам редактор их только
#     рекомендует и ждёт клика. ПОСЛЕ клонирования, а не рядом с ним: расширение, вставшее раньше
#     репозиториев, осматривает пустые папки — Task Explorer на пустом томе не видел задач из
#     `package.json`, пока окно не перезагрузили (2026-10-07). Ставятся и тогда, когда клонирование
#     упало: одно от другого не зависит. Ставит СЕРВЕР редактора (`code-server`): ему не нужно окно
#     на хосте. Через команду `code` на этом шаге расширения не встали (2026-10-07) — почему, не
#     выясняли.
#  3. Задача `bootstrap` из `mise.toml` скоупа, если она там объявлена и репозитории на месте:
#     список «что выполнить при подъёме» ведёт человек в конфиге, образ о его содержимом не знает.
#     Список у mise, а не у mani: у mani упавший шаг возвращает код 0 (0.32.1, 2026-10-07), и
#     редактор принял бы поломку за успех. Задача идёт БЕЗ ТЕРМИНАЛА: ввод закрыт (`</dev/null`),
#     управляющего терминала нет (`setsid`), вывод уходит в журнал `/tmp/devbox-bootstrap.log` и
#     показывается целиком по окончании. Заведено, когда шаг трижды вис на сборке под терминалом
#     редактора (2026-10-07); причина последнего зависания не найдена.
# Код возврата — общий: упал любой шаг — редактор покажет ошибку запуска.
# ПОЛЬЗОВАТЕЛЬ ОБЪЯВЛЕН ЗДЕСЬ: всё, что образ готовит, принадлежит `node`. Без объявления редактор
# подключается root'ом и человек пишет root-овые файлы в СВОИ тома. Ловилось живьём 2026-10-04.
LABEL devcontainer.metadata='[{ \
  "containerUser": "node", \
  "remoteUser": "node", \
  "postCreateCommand": "mise install", \
  "postAttachCommand": "mani sync --sync-gitignore=false --sync-remotes; repos=$?; jq -r \".extensions.recommendations[]?\" /workspaces/tree/*.code-workspace | xargs -r -n1 $(ls -td ~/.vscode-server/bin/*/bin/code-server | head -1) --install-extension; ext=$?; boot=0; if [ $repos -eq 0 ] && mise tasks info bootstrap >/dev/null 2>&1; then echo \"bootstrap: идёт, журнал — /tmp/devbox-bootstrap.log\"; setsid -w mise run bootstrap </dev/null >/tmp/devbox-bootstrap.log 2>&1; boot=$?; cat /tmp/devbox-bootstrap.log; fi; [ $repos -eq 0 ] && [ $ext -eq 0 ] && [ $boot -eq 0 ]" \
}]'
