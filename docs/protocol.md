# Протокол и авторизация

## Сервер

`https://app.yriist.ru/api/mcp` — MCP по Streamable HTTP без состояния:
каждый `POST` несёт одно JSON-RPC сообщение (или пакет до 50) и получает
ответ целиком (`application/json`); уведомления — `202`. `GET`/`DELETE` — `405`
(сервер не открывает поток сам и не держит сессий). Версии протокола:
`2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`.

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
результат самодостаточен: в нём есть и текст (`text`, `answer`), и источники.

## Авторизация (MCP Authorization, OAuth 2.1)

1. Запрос без токена → `401` и
   `WWW-Authenticate: Bearer resource_metadata="https://app.yriist.ru/.well-known/oauth-protected-resource/api/mcp"`.
2. Protected Resource Metadata (RFC 9728) → `authorization_servers: ["https://app.yriist.ru"]`.
3. `GET /.well-known/oauth-authorization-server` (RFC 8414).
4. `POST /api/oauth/register` — динамическая регистрация (RFC 7591), только
   публичные клиенты (`token_endpoint_auth_method: none`). Redirect URI:
   https, `http://127.0.0.1|localhost` (порт любой, RFC 8252) или схема
   приложения (`cursor://…`).
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
вызов возвращает результат с `isError: true` и ссылкой, где расширить права.
Лимиты: 240 вызовов инструментов в минуту, `ask_yriist` — 20 за 10 минут на
пользователя.
