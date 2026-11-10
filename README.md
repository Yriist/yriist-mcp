# ЮрИИст MCP

[![CI](https://github.com/Yriist/yriist-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Yriist/yriist-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@yriist/mcp)](https://www.npmjs.com/package/@yriist/mcp)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

ИИ-юрист по праву РФ для любого MCP-клиента: Claude Code, Claude Desktop и
claude.ai, Cursor, VS Code, Windsurf, Zed, ChatGPT, Codex CLI, Gemini CLI,
Continue, Cline, n8n и всего, что говорит на [Model Context Protocol](https://modelcontextprotocol.io).

> **In English.** [ЮрИИст](https://yriist.ru) (Yriist) is an AI lawyer for
> Russian law. Its MCP server is remote — `https://app.yriist.ru/api/mcp`
> (Streamable HTTP, OAuth 2.1) — and gives any MCP client court practice
> search, statutes checked against several sources, counterparty checks,
> penalty / court-fee / procedural-deadline calculators, and the user's own
> chats, documents and deadlines. This package is an optional, dependency-free
> stdio bridge for clients that only run local servers or can't do OAuth:
> `npx -y @yriist/mcp`. Tool descriptions and answers are in Russian.

- **Судебная практика** — поиск по актам судов РФ, карточки дел, исходы.
- **Нормы** — текст статьи со сверкой по нескольким источникам, проверка
  актуальности, сверка ссылок и цифр в готовом тексте.
- **Контрагенты** — карточка компании, реквизиты, проверка рисков.
- **Расчёты** — неустойка, госпошлина, процессуальные сроки по
  производственному календарю РФ.
- **ИИ-юрист целиком** — `ask_yriist`: полноценный агент ЮрИИста, ответ
  сохраняется чатом в приложении.
- **Ваши данные** — чаты, документы, шаблоны (230+), «Сроки и дела», память.
- **Интерактивные карточки** (MCP Apps) в клиентах, которые их рисуют:
  источники с исходами дел, сроки с кнопкой «Выполнено», ответ ИИ-юриста с
  полем для уточнения.

Сервер — удалённый: `https://app.yriist.ru/api/mcp` (Streamable HTTP,
OAuth 2.1). Этот пакет — необязательный stdio-мост для клиентов, которые
запускают только локальные серверы или не умеют OAuth.

## Подключение

Нужен аккаунт [ЮрИИста](https://app.yriist.ru).

### Клиенты с удалёнными серверами и OAuth — пакет не нужен

Укажите адрес, клиент сам откроет окно входа ЮрИИста:

| Клиент | Как |
| --- | --- |
| Claude Code | `claude mcp add --transport http yriist https://app.yriist.ru/api/mcp`, затем `/mcp` → yriist → Authenticate. Или [плагин](https://github.com/Yriist/yriist-claude-plugin) с командами и панелью |
| Claude Desktop, claude.ai | Настройки → Коннекторы → Добавить свой коннектор → `https://app.yriist.ru/api/mcp` |
| Cursor | `~/.cursor/mcp.json`: `{"mcpServers":{"yriist":{"url":"https://app.yriist.ru/api/mcp"}}}` |
| VS Code | `.vscode/mcp.json`: `{"servers":{"yriist":{"type":"http","url":"https://app.yriist.ru/api/mcp"}}}` |
| Windsurf | `mcp_config.json`: `{"mcpServers":{"yriist":{"serverUrl":"https://app.yriist.ru/api/mcp"}}}` |
| ChatGPT | Settings → Connectors → Create (developer mode): URL `https://app.yriist.ru/api/mcp`, OAuth |
| Gemini CLI | `settings.json`: `{"mcpServers":{"yriist":{"httpUrl":"https://app.yriist.ru/api/mcp"}}}` |

### Клиенты со stdio-серверами — через этот пакет

```json
{
  "mcpServers": {
    "yriist": { "command": "npx", "args": ["-y", "@yriist/mcp"] }
  }
}
```

Войдите заранее — так надёжнее, чем ждать окна входа при первом запросе
(клиент может не дождаться ответа и остановить сервер):

```sh
npx -y @yriist/mcp login     # вход через браузер
npx -y @yriist/mcp status    # кто вошёл, тариф, инструменты
npx -y @yriist/mcp config    # готовые конфиги для всех клиентов
npx -y @yriist/mcp logout    # выйти и отозвать доступ
```

Без входа мост сам откроет браузер при первом запросе; если клиент за это
время закрылся, вход всё равно завершится — следующий запуск уже будет
подключён.

Codex CLI (`~/.codex/config.toml`):

```toml
[mcp_servers.yriist]
command = "npx"
args = ["-y", "@yriist/mcp"]
```

### По личному токену (скрипты, n8n, клиенты без OAuth)

Создайте токен в [Аккаунт → Подключения](https://app.yriist.ru/account/connections)
и передайте его:

- удалённо: заголовок `Authorization: Bearer yrp_…` на `https://app.yriist.ru/api/mcp`;
- через пакет: `YRIIST_TOKEN=yrp_… npx -y @yriist/mcp` или файл
  `~/.config/yriist/token` (одна строка, `chmod 600`).

```sh
curl -s https://app.yriist.ru/api/mcp \
  -H "Authorization: Bearer $YRIIST_TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"law_article","arguments":{"articles":[{"act":"ГК РФ","article":"333"}]}}}'
```

## Права

При подключении ЮрИИст спрашивает разрешение. Права (OAuth scopes):

| Право | Что даёт |
| --- | --- |
| `yriist:read` | чаты, документы, шаблоны, сроки, дела, аккаунт, поиск в памяти |
| `yriist:research` | практика, нормы, контрагенты, расчёты, поиск и чтение источников, навыки |
| `yriist:write` | создать документ, сохранить срок, отметить выполненным, мониторинг дела, память |
| `yriist:agent` | `ask_yriist` — вопрос ИИ-юристу (расходует сообщение тарифа) |

Отключить приложение или удалить токен — там же, в «Подключениях».

## Инструменты

Полный список с параметрами — [docs/tools.md](docs/tools.md). Готовые сценарии
(MCP prompts): `legal_research`, `draft_claim`, `contract_review`,
`deadline_check`, `counterparty_check`, `court_prep`.

`ask_yriist` отвечает до нескольких минут. Если клиент обрывает долгие вызовы
(часто через 60 секунд), передайте `wait_seconds: 45` — инструмент вернёт
`status: running` и `chat_id`, а ответ заберёт `chat_read`.

## Параметры пакета

| Переменная / флаг | Что |
| --- | --- |
| `--url`, `YRIIST_MCP_URL` | другой сервер (по умолчанию `https://app.yriist.ru/api/mcp`); только `https://`, `http://` — лишь для `localhost` |
| `YRIIST_TOKEN` | личный токен вместо OAuth |
| `--no-browser`, `YRIIST_NO_BROWSER=1` | не открывать браузер: ссылка для входа — в stderr (удобно по SSH: откройте её на своём компьютере с пробросом порта) |
| `XDG_CONFIG_HOME` | где хранить вход (`$XDG_CONFIG_HOME/yriist/credentials.json`, 0600) |

## Как устроен мост

Пакет без зависимостей, Node.js ≥ 18.17. Мост читает JSON-RPC из stdin и
пересылает каждое сообщение на сервер с токеном; в stdout — только ответы,
журнал — в stderr.

- Понимает JSON- и SSE-ответы, переносит `Mcp-Session-Id` и согласованную
  версию протокола.
- Токен обновляет сам: один раз на все ожидающие запросы, с учётом того, что
  одним файлом входа могут пользоваться несколько клиентов сразу.
- `notifications/cancelled` обрывает соответствующий запрос к серверу.
- Долгому вызову инструмента, попросившему прогресс (`progressToken`), шлёт
  `notifications/progress` каждые 15 секунд.
- Вход — OAuth 2.1 по спецификации MCP: метаданные ресурса и сервера
  авторизации, динамическая регистрация, код + PKCE S256 на локальном порту
  `127.0.0.1`, проверка `state` и `iss`. Сетевая ошибка никогда не стирает
  сохранённый вход.

Токены лежат только у вас: `~/.config/yriist/credentials.json` (права 0600).
Подробности — [docs/protocol.md](docs/protocol.md).

## Если что-то не так

| Симптом | Что сделать |
| --- | --- |
| «Нужен вход в ЮрИИст» | `npx -y @yriist/mcp login`, затем перезапустите сервер в клиенте |
| «Личный токен недействителен» | токен удалён или истёк: создайте новый в «Подключениях» или уберите `YRIIST_TOKEN` / файл `token`, чтобы вернуться к OAuth |
| Окно входа пишет «Приложение не зарегистрировано» | `npx -y @yriist/mcp logout`, затем `login` — регистрация создастся заново |
| Клиент не видит инструменты | `npx -y @yriist/mcp status`: покажет, под кем вы вошли и какие права выданы |
| Нет инструмента `ask_yriist` или действий | при подключении не выдано право: отключите приложение в «Подключениях» и войдите снова |
| Вход по SSH / без браузера | `npx -y @yriist/mcp login --no-browser` и пробросьте порт из ссылки (`ssh -L PORT:127.0.0.1:PORT`), либо используйте личный токен |

## Разработка

```sh
npm test                                         # node:test, мок-сервер OAuth + MCP
node bin/yriist-mcp.mjs status --url http://localhost:3000/api/mcp
npm run docs:tools                               # docs/tools.md из tools/list сервера
```

Как прислать изменение — [CONTRIBUTING.md](CONTRIBUTING.md); об уязвимостях —
[SECURITY.md](SECURITY.md).

## Конфиденциальность

Запросы обрабатываются ЮрИИстом по [политике конфиденциальности](https://yriist.ru/privacy).
Пакет ничего не собирает и хранит только токены входа у вас на компьютере.

Лицензия [MIT](LICENSE).
