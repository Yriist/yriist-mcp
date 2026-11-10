#!/usr/bin/env node
import { login, revoke } from "../src/auth.mjs";
import { createBridge, DEFAULT_URL, runStdio } from "../src/bridge.mjs";
import { clientConfigs } from "../src/clients.mjs";
import { credentialsPath, personalToken } from "../src/store.mjs";
import { VERSION } from "../src/version.mjs";

const HELP = `ЮрИИст MCP ${VERSION} — ИИ-юрист по праву РФ для любого MCP-клиента.

Использование:
  yriist-mcp                 stdio-сервер (его запускает MCP-клиент)
  yriist-mcp login           войти через браузер (OAuth)
  yriist-mcp logout          выйти и отозвать доступ
  yriist-mcp status          кто вошёл, тариф, доступные инструменты
  yriist-mcp config [клиент] готовый конфиг: claude-code, claude-desktop, cursor,
                             vscode, windsurf, zed, chatgpt, codex, gemini, stdio, token

Параметры:
  --url <адрес>              MCP-сервер (по умолчанию ${DEFAULT_URL},
                             или YRIIST_MCP_URL)
  --no-browser               не открывать браузер (ссылка — в stderr)
  -v, --version              версия
  -h, --help                 эта справка

Токен вместо OAuth: YRIIST_TOKEN=yrp_… или файл ~/.config/yriist/token.
Токены: https://app.yriist.ru/account/connections`;

function parseArgs(argv) {
  const args = { command: null, rest: [], url: null, browser: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--url") args.url = argv[++i] ?? null;
    else if (arg.startsWith("--url=")) args.url = arg.slice(6);
    else if (arg === "--no-browser") args.browser = false;
    else if (arg === "-h" || arg === "--help") args.command = "help";
    else if (arg === "-v" || arg === "--version") args.command = "version";
    else if (!args.command) args.command = arg;
    else args.rest.push(arg);
  }
  return args;
}

/** The server's address, or an error a person can act on. */
function serverUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Неверный адрес сервера: ${raw}`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    // The token travels in a header: never over plain http to another host.
    throw new Error(`Адрес сервера должен начинаться с https://: ${raw}`);
  }
  return url.toString();
}

const PERSONAL_TOKEN_NOTE =
  "задан личный токен (YRIIST_TOKEN или ~/.config/yriist/token) — используется он, а не вход через браузер.";

async function status(url) {
  const bridge = createBridge({ url, interactive: false, log: () => {} });
  const call = async (id, method, params) => {
    const [reply] = await bridge.forward({ jsonrpc: "2.0", id, method, params });
    if (!reply) throw new Error("сервер не ответил");
    if (reply.error) {
      const error = new Error(reply.error.message);
      error.code = reply.error.code;
      throw error;
    }
    return reply.result;
  };
  try {
    const init = await call(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "yriist-mcp-status", version: VERSION },
    });
    await bridge.forward({ jsonrpc: "2.0", method: "notifications/initialized" });
    const tools = await call(2, "tools/list", {});
    const names = tools.tools.map((tool) => tool.name);
    if (names.includes("whoami")) {
      const who = await call(3, "tools/call", { name: "whoami", arguments: {} });
      console.log(who?.content?.[0]?.text ?? "");
    }
    const personal = await personalToken();
    console.log(
      `Вход: ${personal ? "личный токен" : "OAuth"} · сервер: ${url} (${init.serverInfo?.name ?? "MCP"} ${init.serverInfo?.version ?? ""}, протокол ${init.protocolVersion})`,
    );
    console.log(`Инструменты (${names.length}): ${names.join(", ")}`);
  } catch (error) {
    if (error.code === -32001) {
      console.log(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.browser) process.env.YRIIST_NO_BROWSER = "1";

  switch (args.command) {
    case "version":
      console.log(VERSION);
      return;
    case "help":
      console.log(HELP);
      return;
    default:
  }

  const url = serverUrl(args.url || process.env.YRIIST_MCP_URL || DEFAULT_URL);
  switch (args.command) {
    case null:
    case "serve":
    case "stdio":
      await runStdio({ url, openBrowser: args.browser });
      return;
    case "login": {
      await login(url, { openBrowser: args.browser });
      console.log(`Готово: ЮрИИст подключён. Данные входа: ${credentialsPath()}`);
      if (await personalToken()) console.log(`Внимание: ${PERSONAL_TOKEN_NOTE}`);
      return;
    }
    case "logout": {
      const removed = await revoke(url);
      console.log(removed ? "Вы вышли из ЮрИИста." : "Вход не выполнялся.");
      if (await personalToken()) {
        console.log(`Внимание: ${PERSONAL_TOKEN_NOTE} Чтобы отключить его, удалите токен в «Подключениях».`);
      }
      return;
    }
    case "status":
      await status(url);
      return;
    case "config": {
      const configs = clientConfigs(url);
      const name = args.rest[0];
      if (name && !configs[name]) {
        console.error(`Нет клиента «${name}». Есть: ${Object.keys(configs).join(", ")}`);
        process.exitCode = 1;
        return;
      }
      const picked = name ? [configs[name]] : Object.values(configs);
      for (const config of picked) {
        console.log(`# ${config.title}${config.kind === "stdio" ? " — через этот пакет (stdio)" : ""}\n${config.text}\n`);
      }
      return;
    }
    default:
      console.error(`Неизвестная команда «${args.command}».\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`[yriist-mcp] ${error?.message ?? error}\n`);
  process.exit(1);
});
