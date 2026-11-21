# Протокол и авторизация

## Сервер

`https://app.yriist.ru/api/mcp` — MCP по Streamable HTTP без состояния:
каждый `POST` несёт одно JSON-RPC сообщение и получает ответ целиком
(`application/json`); уведомления — `202`. Пакет (batch, до 50 сообщений)
принимается только с протоколом `2025-03-26` и старше: в `2025-06-18` пакеты
убраны из спецификации, и сервер отвечает на них `400`. `GET`/`DELETE` —
`405` (сервер не открывает поток сам и не держит сессий). Версии протокола:
`2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`.

Ответы на уровне HTTP:

| Код | Когда | Что делать клиенту |
| --- | --- | --- |
| `401` + `WWW-Authenticate: Bearer resource_metadata="…"` | нет токена или он истёк | обновить токен или войти (OAuth) |
| `403` + `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"` | у токена нет нужного права | войти заново, попросив права из `scope` (step-up) |
| `400`, `413` с `id: null` | неверный заголовок, пакет, тело больше 4 МБ | ошибка относится к отправленному запросу |
| `503` + `Retry-After` | временный сбой инфраструктуры | повторить через указанное время; запрос, который что-то меняет, — только по решению пользователя |

Методы: `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`,
`resources/templates/list`, `resources/read`, `prompts/list`, `prompts/get`,
`completion/complete`, `logging/setLevel`.

Ресурсы:

| URI | Что |
| --- | --- |
| `yriist://guide` | как пользоваться (Markdown) |
| `yriist://chat/{chat_id}` | переписка чата |
| `yriist://document/{document_id}` | текст документа |
| `ui://yriist/{research,answer,deadlines,list,account}.html` | карточки MCP Apps (`text/html;profile=mcp-app`) |

Инструмент с карточкой объявляет её в `_meta.ui.resourceUri` (и
`openai/outputTemplate` для хостов Apps SDK); данные карточки — в
`structuredContent` результата. Номера источников `[n]` сохраняются в
пределах подключения: `web_fetch` читает источник по номеру из прошлого вызова.

Некоторые клиенты (Claude Code) передают своей модели JSON из
`structuredContent` вместо текста `content`, поэтому структурированный
результат самодостаточен: в нём есть текст (`text`) и источники. Длинные
чтения (`chat_read`, `document_read`, `file_read`) объявляют
`_meta["anthropic/maxResultSizeChars"] = 200000` и отдают текст частями
(`from_message`, `from_paragraph`, `from_char`).

## Авторизация (MCP Authorization, OAuth 2.1)

1. Запрос без токена → `401` и
   `WWW-Authenticate: Bearer resource_metadata="https://app.yriist.ru/.well-known/oauth-protected-resource/api/mcp"`.
2. Protected Resource Metadata (RFC 9728) → `authorization_servers: ["https://app.yriist.ru"]`.
3. `GET /.well-known/oauth-authorization-server` (RFC 8414).
4. `POST /api/oauth/register` — динамическая регистрация (RFC 7591), только
   публичные клиенты (`token_endpoint_auth_method: none`). Redirect URI:
   https, `http://127.0.0.1|localhost` (порт любой, RFC 8252) или схема
   приложения (`cursor://…`). Клиент может обойтись без регистрации и
   передать в `client_id` https-адрес своего документа метаданных (Client ID
   Metadata Document, CIMD).
5. `GET /oauth/authorize` — вход в ЮрИИст и экран согласия; PKCE `S256`
   обязателен; `resource` (RFC 8707) — адрес MCP или origin. Ответ несёт
   `code`, `state` и `iss` (RFC 9207).
6. `POST /api/oauth/token` — `authorization_code` и `refresh_token`.
   Access-токен (`yrt_…`) живёт час, refresh (`yrr_…`) — 90 дней, меняется
   при каждом обновлении (повтор старого → `invalid_grant`).
   Обновление сразу отменяет прежний access-токен, поэтому клиент обновляет
   токен один раз на все свои параллельные запросы.
7. `POST /api/oauth/revoke` (RFC 7009) — отзыв любого токена подключения.

Личные токены (`yrp_…`) выдаются в «Аккаунт → Подключения» с выбранными
правами и сроком; работают как access-токен.

Ошибки прав: инструмент вне выданных прав не попадает в `tools/list`, а его
вызов отклоняется `403 insufficient_scope` с нужным правом в `scope`.
Лимиты: 240 вызовов инструментов в минуту, `ask_yriist` — 20 за 10 минут на
пользователя.

## Мост `@yriist/mcp`: что он делает с протоколом

- Пакет от клиента на протоколе `2025-06-18` и новее (или до `initialize`)
  отправляет отдельными запросами и отвечает одним массивом; на старых
  версиях передаёт пакет как есть.
- Ошибку сервера с `id: null` отдаёт как ответ на запросы этого сообщения,
  оставшиеся без ответа.
- `502`/`503`/`504`, `ECONNREFUSED` — до двух повторов с паузой (`Retry-After`
  до 10 с, иначе 1 и 2 с) для `initialize`, `ping`, списков, `resources/read`,
  `prompts/get`, `completion/complete` и инструментов с `readOnlyHint` из
  `tools/list`. Остальные вызовы инструментов не повторяются: они могут
  потратить сообщение тарифа или изменить данные.
- `403 insufficient_scope` — вход с объединением текущих и недостающих прав,
  затем один повтор; без браузера (или с личным токеном) — ошибка `-32003` с
  командой, которая выдаст право.
- Без входа отвечает сам на `initialize`, `ping`, `tools/list` (один
  инструмент `yriist_login`), `resources/list`, `resources/templates/list`,
  `prompts/list`; после входа шлёт `notifications/*/list_changed`.

Ограничения: SSE-ответ читается до конца и только потом передаётся клиенту
(промежуточные уведомления приходят вместе с ответом); `GET`-поток и `DELETE`
сессии мост не открывает — серверу ЮрИИста они не нужны. С другими MCP-серверами
мост не проверялся.
