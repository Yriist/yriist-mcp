# Yriist MCP

**An AI lawyer for Russian law inside your AI assistant.** One MCP server for
Cursor, VS Code, ChatGPT, Claude, Windsurf, Zed, Gemini CLI and any
[Model Context Protocol](https://modelcontextprotocol.io) client.

[![CI](https://github.com/Yriist/yriist-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Yriist/yriist-mcp/actions/workflows/ci.yml)
[![MCP](https://img.shields.io/badge/MCP-2025--11--25-0a7cff)](docs/protocol.md)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2018.17-3c873a)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[Русский](README.md) · **English** · [Tools](docs/tools.md) · [Protocol](docs/protocol.md) · [Legal](LEGAL.md)

---

[ЮрИИст](https://yriist.ru) (Yriist) is an AI lawyer for the law of the Russian
Federation. Its MCP server is remote — `https://app.yriist.ru/api/mcp`
(Streamable HTTP, OAuth 2.1). This repository holds its public documentation
and `@yriist/mcp`, an optional dependency-free stdio bridge for clients that
only run local servers or cannot do OAuth.

> [!NOTE]
> Tool descriptions, answers and most of the documentation are in Russian: the
> service works with Russian law and Russian-language sources.

## What the assistant gets

| | |
| --- | --- |
| **Case law** | search across Russian court decisions, case cards, outcomes |
| **Statutes** | article text checked against several sources, currency checks, verification of citations and figures in a draft |
| **Counterparties** | company card, bank and court requisites, risk check |
| **Calculators** | penalties and interest, court fees, procedural deadlines on the Russian business calendar |
| **The full agent** | `ask_yriist` — the complete Yriist agent; the answer is saved as a chat in the app |
| **Your data** | chats, documents, 230+ templates, deadlines and tracked cases, memory |

## Quick start

You need a [Yriist](https://app.yriist.ru) account.

1. Add a remote MCP server in your app: `https://app.yriist.ru/api/mcp`
2. The app opens the Yriist sign-in window — sign in and allow access.

For stdio-only clients:

```json
{ "mcpServers": { "yriist": { "command": "npx", "args": ["-y", "@yriist/mcp"] } } }
```

```sh
npx -y @yriist/mcp login     # sign in through the browser
npx -y @yriist/mcp status    # account, plan, tools
npx -y @yriist/mcp config    # ready-made configs for every client
npx -y @yriist/mcp logout    # sign out and revoke access
```

With a personal token (scripts, n8n, clients without OAuth): create one in
[Account → Connections](https://app.yriist.ru/account/connections) and send
`Authorization: Bearer yrp_…`, or run `YRIIST_TOKEN=yrp_… npx -y @yriist/mcp`.

Per-client configuration (Cursor, VS Code, Windsurf, Claude, ChatGPT,
Gemini CLI, Zed, Codex CLI) is in the [Russian README](README.md#подключение).

## Scopes

| Scope | Grants |
| --- | --- |
| `yriist:research` | case law, statutes, counterparties, calculators, web search and reading |
| `yriist:read` | your chats, documents, templates, deadlines, cases, account |
| `yriist:write` | create a document, save a deadline, track a case, memory |
| `yriist:agent` | `ask_yriist` (spends one message of your plan) |

A tool outside the granted scopes is not listed to the client. Access is
revoked in Account → Connections.

## The bridge

No dependencies, Node.js ≥ 18.17. It forwards each JSON-RPC message from stdin
to the server with a bearer token; stdout carries only responses, logs go to
stderr.

- OAuth 2.1 per the MCP authorization spec: protected-resource and
  authorization-server metadata, dynamic client registration, authorization
  code + PKCE S256 on a `127.0.0.1` loopback port, `state` and `iss` checks.
- One token refresh for all waiting requests; safe when several clients share
  one credentials file; a network error never forgets the sign-in.
- `notifications/cancelled` aborts the request; long tool calls that asked for
  progress get `notifications/progress` every 15 s.
- Tokens stay on your machine (`~/.config/yriist/credentials.json`, mode 0600).
  The package collects nothing. Plain `http://` is refused except for localhost.

| Variable / flag | Meaning |
| --- | --- |
| `--url`, `YRIIST_MCP_URL` | another server |
| `YRIIST_TOKEN` | personal token instead of OAuth |
| `--no-browser`, `YRIIST_NO_BROWSER=1` | print the sign-in link to stderr instead of opening a browser |
| `XDG_CONFIG_HOME` | where the sign-in is stored |

## Development

```sh
npm test
node bin/yriist-mcp.mjs status --url http://localhost:3000/api/mcp
npm run docs:tools
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Legal

The code in this repository is MIT-licensed. The Yriist service it connects to
is governed by its [user agreement](https://yriist.ru/offer) and
[privacy policy](https://yriist.ru/privacy) (in Russian). AI output is
informational and is not legal advice. Full text: [LEGAL.md](LEGAL.md).
