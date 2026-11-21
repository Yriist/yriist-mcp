#!/usr/bin/env node
import { lookup } from "node:dns/promises";
import { stat } from "node:fs/promises";
import { currentToken, discover, login, normalizeScopes, revoke } from "../src/auth.mjs";
import { createBridge, DEFAULT_URL, PROTOCOL_VERSIONS, runStdio } from "../src/bridge.mjs";
import { clientConfigs } from "../src/clients.mjs";
import {
  nodeHasEnvProxy,
  PROXY_UNSUPPORTED,
  proxyFromEnv,
  proxyPlan,
  reexecWithProxy,
} from "../src/proxy.mjs";
import { credentialsPath, loadCredentials, personalToken, tokenFilePath } from "../src/store.mjs";
import { VERSION } from "../src/version.mjs";

const HELP = `ЮрИИст MCP ${VERSION} — ИИ-юрист по праву РФ для любого MCP-клиента.

Использование:
  yriist-mcp                 stdio-сервер (его запускает MCP-клиент)
  yriist-mcp login           войти через браузер (OAuth)
  yriist-mcp logout          выйти и отозвать доступ
  yriist-mcp status          кто вошёл, тариф, права, инструменты
  yriist-mcp doctor          проверить сеть, прокси, вход и файлы
  yriist-mcp config [клиент] готовый конфиг: claude-code, claude-desktop, cursor,
                             vscode, windsurf, devin, zed, chatgpt, codex, gemini,
                             antigravity, copilot, cline, roo, continue, kiro, junie,
                             jetbrains, lm-studio, goose, opencode, warp, n8n, stdio, token

Параметры:
  --url <адрес>              MCP-сервер (по умолчанию ${DEFAULT_URL},
                             или YRIIST_MCP_URL)
  --no-browser               не открывать браузер (ссылка — в stderr)
  --scope <права>            login: какие права просить (research,read,write,agent;
                             по умолчанию все)
  --json                     status, doctor: ответ в JSON
  --windows                  config: форма «cmd /c npx» для Windows (там — по умолчанию)
  -v, --version              версия
  -h, --help                 эта справка

Токен вместо OAuth: YRIIST_TOKEN=yrp_… или файл ~/.config/yriist/token.
Токены: https://app.yriist.ru/account/connections
Прокси: HTTPS_PROXY / NO_PROXY (Node.js ≥ 22.21 или ≥ 24).`;

class UsageError extends Error {}

function parseArgs(argv) {
  const args = {
    command: null,
    rest: [],
    url: null,
    browser: true,
    scope: null,
    json: false,
    windows: undefined,
  };
  const value = (i, flag) => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new UsageError(`У ${flag} нет значения.`);
    }
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--url") args.url = value(i++, "--url");
    else if (arg.startsWith("--url=")) args.url = arg.slice(6);
    else if (arg === "--scope") args.scope = value(i++, "--scope");
    else if (arg.startsWith("--scope=")) args.scope = arg.slice(8);
    else if (arg === "--no-browser") args.browser = false;
    else if (arg === "--json") args.json = true;
    else if (arg === "--windows") args.windows = true;
    else if (arg === "-h" || arg === "--help") args.command = "help";
    else if (arg === "-v" || arg === "--version") args.command = "version";
    else if (arg.startsWith("--")) throw new UsageError(`Неизвестный параметр «${arg}».`);
    else if (!args.command) args.command = arg;
    else args.rest.push(arg);
  }
  if (args.url === "") throw new UsageError("У --url нет значения.");
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

const ruTime = (ms) =>
  new Date(ms).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });

async function status(url, { json }) {
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
  const origin = new URL(url).origin;
  const personal = await personalToken();
  const saved = await loadCredentials(origin);
  const report = {
    bridge: VERSION,
    server: url,
    auth: personal ? "personal" : saved?.accessToken ? "oauth" : "none",
    personalTokenShadowsOAuth: Boolean(personal && saved?.accessToken),
    credentials: credentialsPath(),
    tokenExpiresAt: !personal && saved?.expiresAt ? new Date(saved.expiresAt).toISOString() : null,
    scopes: !personal && saved?.scope ? normalizeScopes(saved.scope) : null,
    account: null,
    protocol: null,
    tools: [],
  };
  try {
    const init = await call(1, "initialize", {
      protocolVersion: PROTOCOL_VERSIONS[0],
      capabilities: {},
      clientInfo: { name: "yriist-mcp-status", version: VERSION },
    });
    await bridge.forward({ jsonrpc: "2.0", method: "notifications/initialized" });
    report.protocol = init.protocolVersion;
    const { tools } = await call(2, "tools/list", {});
    report.tools = tools.map((tool) => tool.name);
    let whoText = "";
    if (report.tools.includes("whoami")) {
      const who = await call(3, "tools/call", { name: "whoami", arguments: {} });
      whoText = who?.content?.[0]?.text ?? "";
      report.account = who?.structuredContent ?? null;
      const granted = who?.structuredContent?.connection?.scopes;
      if (Array.isArray(granted)) report.scopes = granted;
    }
    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (whoText) console.log(whoText);
    console.log("");
    console.log(`Мост: @yriist/mcp ${VERSION} · сервер: ${url} (${init.serverInfo?.name ?? "MCP"} ${init.serverInfo?.version ?? ""}, протокол ${init.protocolVersion})`);
    console.log(
      `Вход: ${report.auth === "personal" ? "личный токен" : "OAuth"}${report.tokenExpiresAt ? ` · токен до ${ruTime(saved.expiresAt)} (обновляется сам)` : ""}`,
    );
    if (report.scopes) console.log(`Права: ${report.scopes.join(", ")}`);
    console.log(`Файл входа: ${report.credentials}`);
    if (report.personalTokenShadowsOAuth) console.log(`Внимание: ${PERSONAL_TOKEN_NOTE}`);
    console.log(`Инструменты (${report.tools.length}): ${report.tools.join(", ")}`);
  } catch (error) {
    if (error.code === -32001) {
      if (json) console.log(JSON.stringify({ ...report, error: error.message }, null, 2));
      else console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

/** Checks what a support question would ask about, one line each. */
async function doctor(url, { json }) {
  const target = new URL(url);
  const checks = [];
  const add = (ok, name, detail) => checks.push({ ok, name, detail });

  add(
    Number(process.versions.node.split(".")[0]) >= 18,
    "Node.js",
    `${process.version} (${process.platform} ${process.arch})`,
  );

  const proxy = proxyFromEnv();
  if (proxy) {
    const on = process.env.NODE_USE_ENV_PROXY === "1" || process.execArgv.includes("--use-env-proxy");
    add(
      on,
      "Прокси",
      on
        ? `${proxy.name}=${proxy.value.replace(/\/\/[^@/]*@/, "//***@")} · NO_PROXY=${process.env.NO_PROXY ?? process.env.no_proxy ?? "—"}`
        : nodeHasEnvProxy()
          ? `${proxy.name} задан, но NODE_USE_ENV_PROXY выключен вручную`
          : PROXY_UNSUPPORTED(),
    );
  }
  if (process.env.NODE_EXTRA_CA_CERTS) add(true, "Свои сертификаты", process.env.NODE_EXTRA_CA_CERTS);

  try {
    const { address } = await lookup(target.hostname);
    add(true, "DNS", `${target.hostname} → ${address}`);
  } catch (error) {
    add(false, "DNS", `${target.hostname}: ${error.code ?? error.message}`);
  }

  try {
    const started = Date.now();
    const response = await fetch(`${target.origin}/.well-known/oauth-protected-resource${target.pathname.replace(/\/+$/, "")}`, {
      signal: AbortSignal.timeout(15_000),
    });
    await response.body?.cancel().catch(() => {});
    add(response.ok, "HTTPS", `${target.origin}: HTTP ${response.status}, ${Date.now() - started} мс`);
    const date = Date.parse(response.headers.get("date") ?? "");
    if (!Number.isNaN(date)) {
      const skew = Math.round((Date.now() - date) / 1000);
      add(Math.abs(skew) < 300, "Часы", Math.abs(skew) < 300 ? `расхождение с сервером ${skew} с` : `часы компьютера расходятся с сервером на ${skew} с: вход может не работать`);
    }
  } catch (error) {
    const code = error?.cause?.code ?? error?.name ?? error.message;
    add(false, "HTTPS", `${target.origin}: ${code}${/CERT|SELF_SIGNED|UNABLE_TO/.test(code) ? " — сертификат не принят (корпоративный прокси? задайте NODE_EXTRA_CA_CERTS)" : ""}`);
  }

  try {
    const meta = await discover(url);
    add(true, "OAuth", `сервер авторизации ${meta.issuer}${meta.registrationEndpoint ? ", регистрация клиентов есть" : ", без регистрации клиентов"}`);
  } catch (error) {
    add(false, "OAuth", error.message);
  }

  const files = [
    ["Файл входа", credentialsPath()],
    ["Файл токена", tokenFilePath()],
  ];
  for (const [name, path] of files) {
    const info = await stat(path).catch(() => null);
    if (!info) {
      add(true, name, `${path} — нет`);
      continue;
    }
    const mode = info.mode & 0o777;
    const open = process.platform !== "win32" && (mode & 0o077) !== 0;
    add(!open, name, `${path} (права ${mode.toString(8)}${open ? `: выполните chmod 600 "${path}"` : ""})`);
  }

  try {
    const token = await currentToken(url);
    if (!token) {
      add(false, "Вход", "не выполнен: npx -y @yriist/mcp login");
    } else {
      const bridge = createBridge({ url, interactive: false, log: () => {} });
      const [reply] = await bridge.forward({ jsonrpc: "2.0", id: 1, method: "ping" });
      add(!reply?.error, "Вход", reply?.error ? reply.error.message : `${token.kind === "personal" ? "личный токен" : "OAuth"}, сервер отвечает`);
    }
  } catch (error) {
    add(false, "Вход", error.message);
  }

  if (json) {
    console.log(JSON.stringify({ ok: checks.every((check) => check.ok), checks }, null, 2));
  } else {
    for (const check of checks) console.log(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`);
  }
  if (!checks.every((check) => check.ok)) process.exitCode = 1;
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

  const plan = proxyPlan();
  if (plan === "reexec" && args.command !== "config") {
    await reexecWithProxy();
    return;
  }
  if (plan === "unsupported" && args.command !== "config") {
    process.stderr.write(`[yriist-mcp] ${PROXY_UNSUPPORTED()}\n`);
  }

  const url = serverUrl(args.url || process.env.YRIIST_MCP_URL || DEFAULT_URL);
  switch (args.command) {
    case null:
    case "serve":
    case "stdio":
      await runStdio({ url, openBrowser: args.browser });
      return;
    case "login": {
      await login(url, { openBrowser: args.browser, scope: args.scope ?? undefined });
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
      await status(url, args);
      return;
    case "doctor":
      await doctor(url, args);
      return;
    case "config": {
      const configs = clientConfigs(url, args.windows ? { windows: true } : {});
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
  if (error instanceof UsageError) process.stderr.write("[yriist-mcp] Справка: yriist-mcp --help\n");
  process.exit(1);
});
