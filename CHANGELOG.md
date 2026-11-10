# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), версии —
[SemVer](https://semver.org/lang/ru/).

## [1.0.0] — не выпущено

Первый выпуск.

- Stdio-мост к удалённому MCP-серверу ЮрИИста (`https://app.yriist.ru/api/mcp`):
  JSON и SSE-ответы, `Mcp-Session-Id`, версия протокола, параллельные запросы.
- Вход через OAuth 2.1 (метаданные RFC 9728 / 8414, динамическая регистрация
  RFC 7591, PKCE S256, локальный порт RFC 8252, проверка `iss` RFC 9207),
  обновление токена, личные токены `YRIIST_TOKEN` / `~/.config/yriist/token`.
- Команды `login`, `logout`, `status`, `config <клиент>`.
- Отмена запроса по `notifications/cancelled`, `notifications/progress` для
  долгих вызовов инструментов.
