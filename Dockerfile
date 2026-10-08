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

# Вместе с инструментом mise докачивает «навык для ИИ-агента», если инструмент его объявил, — и
# идёт за ним прямо в GitHub. Анонимный лимит GitHub — 60 запросов в час на адрес, общий на все
# контейнеры машины. Лимит исчерпан — навык не скачан, mise считает установку проваленной, а
# редактор после упавшей команды создания пропускает всё остальное: ни клонирования, ни логина.
# Ловилось живьём 2026-10-08 на fnox 1.39.0. Навыки девбоксу не нужны; сами инструменты mise ставит
# мимо лимита, через свой сервер версий — с выключенной докачкой установка с нуля проходит и при
# лимите 0.
ENV MISE_SKILLS_FETCH=false

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
# При подключении редактора: mani клонирует репозитории по `mani.yaml` и приводит их адреса
# (remotes) к конфигу — названное в нём ставится, поставленное руками мимо него убирается.
# Сменённый в конфиге адрес встаёт со второго прогона: первый его только снимает (mani 0.32.1,
# 2026-10-07). Именно здесь, а не при создании: закрытым репозиториям нужен логин, а его в
# контейнер передаёт редактор.
#
# Больше образ при старте не делает ничего, и это намеренно.
#  · РАСШИРЕНИЯ ставит сам редактор по списку из `devcontainer.json` человека
#    (`customizations.vscode.extensions`) — это его родной способ. Ставить их отсюда, по списку из
#    скоупа, можно только в обход: шагу подъёма редактор не даёт ни команды `code` (в PATH лишь
#    заглушка базового образа), ни переменных, по которым она находит окно, — проверено журналом
#    2026-10-08.
#  · БИБЛИОТЕКИ репозиториев ставит человек командами самого репозитория.
#  · СВОИХ ШАГОВ ПОДЪЁМА нет: были (задача `bootstrap` из `mise.toml`), сняты 2026-10-08. Под
#    терминалом редактора шаг трижды вис, лечилось запуском без терминала, и причина последнего
#    зависания осталась невыясненной — непонятый код не держим про запас. Свои скрипты скоупа живут
#    в `.devbox/.vscode/tasks.json` и запускаются человеком.
# ПОЛЬЗОВАТЕЛЬ ОБЪЯВЛЕН ЗДЕСЬ: всё, что образ готовит, принадлежит `node`. Без объявления редактор
# подключается root'ом и человек пишет root-овые файлы в СВОИ тома. Ловилось живьём 2026-10-04.
LABEL devcontainer.metadata='[{ \
  "containerUser": "node", \
  "remoteUser": "node", \
  "postCreateCommand": "mise install", \
  "postAttachCommand": "mani sync --sync-gitignore=false --sync-remotes" \
}]'
