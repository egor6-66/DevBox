# Образ девбокса: окружение целиком одним слепком — Node, mise и пути, по которым человек монтирует тома.
# Своего кода в образе нет: при старте контейнера работают родные команды инструментов (метка внизу).
FROM mcr.microsoft.com/devcontainers/typescript-node:24

RUN corepack enable

# mise ставит инструменты скоупа по его конфигу. Сам он лежит в ОБРАЗЕ, по постоянному пути:
# шимы инструментов в томе — ссылки на него, и после пересоздания контейнера они обязаны вести сюда же.
ARG MISE_VERSION=v2026.10.3
RUN curl -fsSL https://mise.run | MISE_VERSION=${MISE_VERSION} MISE_INSTALL_PATH=/usr/local/bin/mise sh

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

# Связка соседних репозиториев — общая установка pnpm. Её описание (`pnpm-workspace.yaml`) pnpm
# ищет только ВВЕРХ от пакета, и рядом с ним же кладёт свои служебные файлы. Поэтому файл стоит
# этажом выше скоупа: в корне скоупа от pnpm не появляется ничего. Сам файл — конфиг человека и
# лежит в скоупе, в `.devbox`; здесь только ссылка на него. Нет файла в скоупе — ссылка висит в
# воздухе, и общей установки просто нет. Раскладки, которые не прошли, и почему (2026-10-07):
# описание в `.devbox` с масками `../**` — pnpm 12.3.4 строит битые ссылки между пакетами; общее
# хранилище на машину (`virtualStoreType: global`) — оснастка web-core не находит из него
# `@web-core/solid`; отдельные lock-файлы — pnpm кладёт их внутрь репозиториев.
RUN ln -s /workspaces/tree/.devbox/pnpm-workspace.yaml /workspaces/pnpm-workspace.yaml \
    && chown -h node:node /workspaces/pnpm-workspace.yaml

# Настройки контейнера едут В ОБРАЗЕ: редактор читает их метаданными и сливает со своим файлом,
# поэтому у человека на хосте остаются только образ и тома.
# При создании контейнера: mise ставит инструменты по `mise.toml`.
# При подключении редактора — две НЕЗАВИСИМЫЕ команды, редактор гонит их параллельно, и падение
# одной не отменяет другую:
#  · mani клонирует репозитории по `mani.yaml` и приводит их адреса (remotes) к конфигу: названное
#    в нём ставится, поставленное руками мимо него — убирается. Сменённый в конфиге адрес встаёт со
#    второго прогона: первый его только снимает (mani 0.32.1, 2026-10-07). Именно здесь, а не при создании: закрытым
#    репозиториям нужен логин, а его в контейнер передаёт редактор. При создании логина ещё нет —
#    клон падал на первом же закрытом репозитории и уносил за собой все следующие шаги (2026-10-07).
#    Следом идёт задача `bootstrap` из `mise.toml` скоупа, если она там объявлена: список «что
#    выполнить при подъёме» — установка зависимостей, сборка соседа — ведёт человек в конфиге, образ
#    о его содержимом не знает. Список у mise, а не у mani: у mani упавший шаг возвращает код 0
#    (0.32.1, 2026-10-07), и редактор принял бы поломку за успех. Задача идёт БЕЗ ТЕРМИНАЛА:
#    ввод закрыт (`</dev/null`), управляющего терминала нет (`setsid`), вывод уходит в журнал
#    `/tmp/devbox-bootstrap.log` и показывается целиком по окончании. Шаг выполняется без человека,
#    а редактор даёт ему терминал, и это трижды ломало запуск (2026-10-07): nx спросил про сбор
#    статистики и ждал ответа; с закрытым вводом процессы сборки были остановлены терминалом как
#    фоновые; с отвязанным терминалом сборка молча обрывалась, не оставив следа. Журнал — чтобы
#    следующую поломку можно было прочитать, а не угадывать.
#  · ставятся расширения, названные в `*.code-workspace` скоупа: сам редактор их только рекомендует
#    и ждёт клика. Ставит СЕРВЕР редактора (`code-server`): ему не нужно окно на хосте. Через команду
#    `code` на этом шаге расширения не встали (2026-10-07) — почему, не выясняли.
# ПОЛЬЗОВАТЕЛЬ ОБЪЯВЛЕН ЗДЕСЬ: всё, что образ готовит, принадлежит `node`. Без объявления редактор
# подключается root'ом и человек пишет root-овые файлы в СВОИ тома. Ловилось живьём 2026-10-04.
LABEL devcontainer.metadata='[{ \
  "containerUser": "node", \
  "remoteUser": "node", \
  "postCreateCommand": "mise install", \
  "postAttachCommand": { \
    "repos": "mani sync --sync-gitignore=false --sync-remotes && { ! mise tasks info bootstrap >/dev/null 2>&1 || { echo \"bootstrap: идёт, журнал — /tmp/devbox-bootstrap.log\"; setsid -w mise run bootstrap </dev/null >/tmp/devbox-bootstrap.log 2>&1; rc=$?; cat /tmp/devbox-bootstrap.log; exit $rc; }; }", \
    "extensions": "jq -r \".extensions.recommendations[]?\" /workspaces/tree/*.code-workspace | xargs -r -n1 $(ls -td ~/.vscode-server/bin/*/bin/code-server | head -1) --install-extension" \
  } \
}]'
