# Yriist MCP

**An AI lawyer for Russian law inside your AI assistant.** One MCP server for
Cursor, VS Code, ChatGPT, Claude, Windsurf, Zed, Codex, Gemini CLI, Copilot CLI
and any [Model Context Protocol](https://modelcontextprotocol.io) client.

[![CI](https://github.com/Yriist/yriist-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Yriist/yriist-mcp/actions/workflows/ci.yml)
[![MCP](https://img.shields.io/badge/MCP-2025--11--25-0a7cff)](docs/protocol.md)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2018.17-3c873a)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[Русский](README.md) · **English** · [Tools](docs/tools.md) · [Protocol](docs/protocol.md) · [Legal](LEGAL.md)

---

[ЮрИИст](https://yriist.ru) (Yriist) is an AI lawyer for the law of the Russian
Federation. Its MCP server runs remotely at `https://app.yriist.ru/api/mcp`
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
| **The full agent** | `ask_yriist`: the complete Yriist agent reads your files, edits documents and saves the answer as a chat in the app |
| **Your data** | chats, matters («Дела»), files (upload and read PDF, DOCX, scans), documents with versions and DOCX or PDF export, 230+ templates, deadlines, tracked court cases, review tables, memory. Personal space only: team workspaces are not exposed yet |
| **Anonymization** | names, phone numbers, addresses, passports, tax ids and accounts replaced with labels |

## Quick start

You need a [Yriist](https://app.yriist.ru) account.

1. Add a remote MCP server in your app: `https://app.yriist.ru/api/mcp`
2. The app opens the Yriist sign-in window. Sign in and allow access.

In Claude (desktop app and claude.ai): Customize → Connectors → «+ Add» → Add
custom connector. In ChatGPT: Plugins → «+» → Add custom MCP server, with
OAuth.

Zed, Codex CLI, Gemini CLI, Copilot CLI, Kiro, Junie, Goose, opencode and
Devin do remote servers with OAuth themselves; `npx -y @yriist/mcp config
<client>` prints the config with that client's own keys (run it without a
name for the list).

`ask_yriist` can take several minutes. Raise the client's per-call limit to
300 s where it has one (Claude Code `"timeout": 300000` via
`claude mcp add-json`, Codex `tool_timeout_sec = 300`); otherwise pass
`wait_seconds: 45` and read the answer later with `chat_read`. Cancelling
before the question is sent spends nothing. A call the client cuts after that
still finishes on the server and spends the message: don't ask again, find the
chat with `chats_list`, or stop the answer with `chat_stop`.

For stdio-only clients:

```json
{ "mcpServers": { "yriist": { "command": "npx", "args": ["-y", "@yriist/mcp"] } } }
```

On native Windows, clients that start servers without a shell need
`"command": "cmd", "args": ["/c", "npx", "-y", "@yriist/mcp"]`
(`config stdio --windows`).

```sh
npx -y @yriist/mcp login     # sign in through the browser (--scope research,read for fewer rights)
npx -y @yriist/mcp status    # account, plan, rights, tools (--json)
npx -y @yriist/mcp doctor    # check network, proxy, sign-in and files
npx -y @yriist/mcp config    # ready-made configs for every client
npx -y @yriist/mcp logout    # sign out and revoke access
```

With a personal token (scripts, n8n, clients without OAuth): create one in
[Account → Connections](https://app.yriist.ru/account/connections) and send
`Authorization: Bearer yrp_…`, or run `YRIIST_TOKEN=yrp_… npx -y @yriist/mcp`.

Per-client walkthroughs are in the [Russian README](README.md#подключение).

## Scopes

| Scope | Tools |
| --- | --- |
| `yriist:research` | case law, statutes, counterparties, calculators, web search and fetch, `anonymize` |
| `yriist:read` | `whoami` and every list and read: chats, matters, files (`file_read`), documents (`document_versions`, `document_export`), templates, deadlines, court cases (`case_read`), review tables, `memory_list`, `memory_search` |
| `yriist:write` | every create, update and delete: `project_*`, `file_upload`, `file_upload_begin`, `file_upload_finish`, `document_*`, `deadline_*`, `case_*`, `review_table_create`, `memory_save`, `memory_delete`, `chat_delete` |
| `yriist:agent` | `ask_yriist` (spends one message of your plan), `chat_stop` |

A tool outside the granted scopes is not listed to the client. You revoke
access in Account → Connections. Parameters of every tool are in
[docs/tools.md](docs/tools.md). `deadline_complete` is deprecated: use
`deadline_update` with `status: done`.

Files: a small file (up to 2.5 MB) goes to `file_upload` as base64. A larger
one, or any file from a client with a terminal, goes in two steps:
`file_upload_begin` returns a URL, the client PUTs the file there, and
`file_upload_finish` returns the `file_id`. Long reads (`chat_read`,
`document_read`, `file_read`) page with `from_message`, `from_paragraph` and
`from_char`.

## The bridge

No dependencies, Node.js ≥ 18.17. It forwards each JSON-RPC message from stdin
to the server with a bearer token; stdout carries only responses, logs go to
stderr.

- OAuth 2.1 per the MCP authorization spec: protected-resource and
  authorization-server metadata, dynamic client registration, authorization
  code + PKCE S256 on a `127.0.0.1` loopback port, `state` and `iss` checks.
- One token refresh for all waiting requests; safe when several clients share
  one credentials file (changes are made under a lock file); a network error
  never forgets the sign-in.
- Signed out, it answers `initialize` and the lists itself with one
  `yriist_login` tool and opens the sign-in; the real tools follow
  (`notifications/tools/list_changed`).
- JSON-RPC batches are sent as single requests on protocol 2025-06-18 and
  later and answered as one array; a server error without an `id` answers the
  request it belongs to.
- 502/503/504 and refused connections are retried with backoff (honouring
  `Retry-After`) for requests that change nothing, read-only tools included;
  `ask_yriist` and writes never. `403 insufficient_scope` opens a sign-in for
  the missing right and retries.
- `notifications/cancelled` aborts the request; long tool calls that asked for
  progress get `notifications/progress` every 15 s. SSE responses are read to
  the end before they are relayed.
- Tokens stay on your machine (`~/.config/yriist/credentials.json`, mode 0600).
  The package collects nothing. Plain `http://` is refused except for localhost.

| Variable / flag | Meaning |
| --- | --- |
| `--url`, `YRIIST_MCP_URL` | another server |
| `YRIIST_TOKEN` | personal token instead of OAuth |
| `--no-browser`, `YRIIST_NO_BROWSER=1` | print the sign-in link to stderr instead of opening a browser |
| `--scope` (`login`) | rights to ask for: `research,read,write,agent` (default: all) |
| `XDG_CONFIG_HOME` | where the sign-in is stored |
| `YRIIST_CREDENTIALS` | full path of the credentials file |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | a proxy; needs Node.js ≥ 22.21 or ≥ 24 (the bridge turns on `NODE_USE_ENV_PROXY=1` itself) |
| `NODE_EXTRA_CA_CERTS` | the CA of a TLS-inspecting proxy |

## Development

```sh
npm test
node bin/yriist-mcp.mjs status --url http://localhost:3000/api/mcp
npm run docs:tools                        # docs/tools.json + docs/tools.md from the server
npm run docs:tools -- --offline --check   # what CI runs
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Legal

The code in this repository is MIT-licensed. The Yriist service it connects to
is governed by its [user agreement](https://yriist.ru/offer) and
[privacy policy](https://yriist.ru/privacy) (in Russian). AI output is
informational and is not legal advice. Full text: [LEGAL.md](LEGAL.md).
