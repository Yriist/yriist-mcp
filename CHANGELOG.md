# Changelog

Формат: [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), версии:
[SemVer](https://semver.org/lang/ru/).

## [1.1.0] (не выпущено)

### Добавлено

- Без входа мост сразу отвечает на `initialize` и списки, открывает вход и
  показывает инструмент `yriist_login`. После входа клиент получает
  `notifications/tools/list_changed`.
- `403 insufficient_scope`: вход с недостающим правом и повтор запроса;
  `login --scope research,read`.
- Повтор с паузой (`Retry-After`) при `502`, `503`, `504` и отказе
  соединения, только для запросов, которые ничего не меняют.
- Прокси: `HTTPS_PROXY` и `NO_PROXY` на Node.js ≥ 22.21 и ≥ 24 (мост сам
  включает `NODE_USE_ENV_PROXY=1`), подсказка на старых версиях.
- Команда `doctor`; `status --json`; `status` показывает версию моста, срок
  токена, права и файл входа.
- `config`: Zed и Codex CLI с удалённым сервером и OAuth; Devin, Antigravity,
  Copilot CLI, Cline, Roo Code, Continue, Kiro, Junie, JetBrains AI Assistant,
  LM Studio, Goose, opencode, Warp, n8n; форма `cmd /c npx` для Windows
  (`--windows`); Claude Code с `timeout: 300000`.
- `docs/tools.json`, снимок `tools/list`. CI сверяет с ним `docs/tools.md`,
  еженедельная проверка сверяет снимок с сервером.
- Публикация `server.json` в MCP Registry из `release.yml`.
- README и `docs/tools.md` описывают 62 инструмента сервера: «Дела»
  (`projects_list`, `project_*`), файлы (`file_upload`, `file_upload_begin`,
  `file_upload_finish`, `files_list`, `file_read`), правку, версии, выгрузку
  и удаление документов, `deadline_update`, `deadline_delete`, карточку и
  проверку судебного дела, табличный анализ, `memory_list`, `chat_stop`,
  `chat_delete`, `anonymize`; таблица прав с полным списком инструментов.

### Изменено

- Шаги подключения: Claude (Customize → Connectors → «+ Add» → Add custom
  connector) и ChatGPT (Plugins → «+» → Add custom MCP server), в README и
  `config claude-desktop`.

### Удалено

- `skill_read` из документации: сервер убрал этот инструмент.
  `deadline_complete` помечен устаревшим, вместо него `deadline_update`.

### Исправлено

- Ошибка сервера без `id` (413, 400) оставляла запрос без ответа.
- Мост отправлял пакет JSON-RPC серверу, который пакеты больше не принимает,
  и отдавал ответы отдельными строками, а не массивом.
- `notifications/cancelled` для запроса в полёте больше не уходит на сервер.
- Процесс, проигравший гонку обновления токена, мог стереть токены
  победителя. Теперь мост пишет файл входа под блокировкой.
- Занятый порт входа больше не регистрирует нового клиента.
- `--url` без значения молча брал сервер по умолчанию; `status` писал ошибки
  в stdout.
- Файл токена с правами шире 0600 вызывает предупреждение.
- Мост, запущенный вручную в терминале, объясняет, что он stdio-сервер.
- `release.yml`: без `NPM_TOKEN` токен больше не пишется в `.npmrc`; действия
  закреплены по SHA.

## [1.0.0] (не выпущено)

Первый выпуск.

- Stdio-мост к удалённому MCP-серверу ЮрИИста (`https://app.yriist.ru/api/mcp`):
  JSON и SSE-ответы, `Mcp-Session-Id`, версия протокола, параллельные запросы.
- Вход через OAuth 2.1 (метаданные RFC 9728 и 8414, динамическая регистрация
  RFC 7591, PKCE S256, локальный порт RFC 8252, проверка `iss` RFC 9207),
  обновление токена, личные токены `YRIIST_TOKEN` и `~/.config/yriist/token`.
- Команды `login`, `logout`, `status`, `config <клиент>`.
- Отмена запроса по `notifications/cancelled`, `notifications/progress` для
  долгих вызовов инструментов.
