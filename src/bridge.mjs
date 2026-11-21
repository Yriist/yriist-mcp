import { createInterface } from "node:readline";
import { currentToken, login, normalizeScopes, resourceMetadataUrlOf } from "./auth.mjs";
import { loadCredentials } from "./store.mjs";
import { VERSION } from "./version.mjs";

/**
 * A stdio MCP server that forwards every JSON-RPC message to a remote
 * Streamable HTTP MCP server (ЮрИИст: https://app.yriist.ru/api/mcp) with a
 * bearer token, for clients that only run local (stdio) servers or cannot do
 * OAuth themselves. Messages are newline-delimited JSON on stdin/stdout;
 * logs go to stderr only.
 *
 * - JSON and SSE responses are both handled (an SSE response is read to its
 *   end, then relayed); `Mcp-Session-Id` and the negotiated
 *   `MCP-Protocol-Version` are carried on.
 * - A batch is sent as separate requests once the negotiated protocol has no
 *   batches (2025-06-18 and later) and answered as one array.
 * - A server error without an id (413, 400) answers the request it was for.
 * - A token the server refuses is refreshed once for all waiting requests;
 *   if that fails and sign-in is allowed, the browser opens and they wait.
 *   `403 insufficient_scope` asks for the missing right the same way.
 * - Signed out, `initialize` and the lists are answered here, with one
 *   `yriist_login` tool, so the client connects at once; the tools appear
 *   (`notifications/tools/list_changed`) once the sign-in is done.
 * - 502/503/504 and refused connections are retried with backoff (honouring
 *   `Retry-After`) for requests that change nothing; a tool call only when
 *   the server marked the tool read-only.
 * - Requests run concurrently (a long `ask_yriist` doesn't block a `ping`);
 *   `notifications/cancelled` aborts the request it names.
 * - A long tool call that asked for progress gets a heartbeat, so clients
 *   that reset their timeout on progress don't give up on `ask_yriist`.
 */

export const DEFAULT_URL = "https://app.yriist.ru/api/mcp";
const USER_AGENT = `yriist-mcp/${VERSION}`;
const HEARTBEAT_MS = 15 * 1000;
/** Renew a token this close to its expiry instead of waiting for a 401. */
const EXPIRY_SKEW_MS = 60 * 1000;
/** Protocol versions ЮрИИст speaks, newest first. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
/** The last protocol version with JSON-RPC batches. */
const LAST_BATCH_VERSION = "2025-03-26";
const RETRY_STATUSES = new Set([502, 503, 504]);
/** Errors that mean nothing reached the server: safe to send again. */
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);
const RESET_CODES = new Set(["ECONNRESET", "UND_ERR_SOCKET", "ETIMEDOUT", "EPIPE"]);
/** Methods that change nothing on the server. */
const IDEMPOTENT = new Set([
  "initialize",
  "ping",
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "prompts/list",
  "prompts/get",
  "completion/complete",
  "logging/setLevel",
]);
const RETRIES = 2;
/** A `Retry-After` longer than this is reported, not waited for. */
const MAX_RETRY_WAIT_MS = 10 * 1000;

const CONNECTIONS_URL = "https://app.yriist.ru/account/connections";
const SIGN_IN_HINT =
  "Нужен вход в ЮрИИст: выполните `npx -y @yriist/mcp login` или задайте YRIIST_TOKEN.";
const BAD_PERSONAL_TOKEN = `Личный токен ЮрИИста недействителен или отозван. Создайте новый: ${CONNECTIONS_URL}`;

const LOGIN_TOOL = {
  name: "yriist_login",
  title: "Войти в ЮрИИст",
  description:
    "Открывает в браузере вход в ЮрИИст (ИИ-юрист по праву РФ). Пока вход не выполнен, других инструментов ЮрИИста нет. Вызови, когда пользователь хочет пользоваться ЮрИИстом; после входа список инструментов обновится.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

const sleepFor = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/** `Retry-After` in milliseconds (seconds or an HTTP date); null if absent. */
export function retryAfterMs(value, now = Date.now()) {
  if (!value) return null;
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const date = Date.parse(text);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/** `error="…"` and `scope="…"` of a `WWW-Authenticate: Bearer` challenge. */
export function bearerChallengeOf(header) {
  const text = header ?? "";
  const field = (name) => new RegExp(`${name}="([^"]*)"`, "i").exec(text)?.[1] ?? null;
  return { error: field("error"), scope: field("scope") };
}

const isRequest = (item) =>
  item &&
  typeof item === "object" &&
  !Array.isArray(item) &&
  item.id !== undefined &&
  item.id !== null &&
  typeof item.method === "string";

export function createBridge(options = {}) {
  const url = options.url ?? DEFAULT_URL;
  const origin = new URL(url).origin;
  const fetchImpl = options.fetch ?? fetch;
  const env = options.env ?? process.env;
  const write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
  const log = options.log ?? ((line) => process.stderr.write(`[yriist-mcp] ${line}\n`));
  const interactive = options.interactive ?? true;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const sleep = options.sleep ?? sleepFor;

  let sessionId = null;
  let protocolVersion = null;
  /** `{ token, kind, expiresAt }` in use, or null. */
  let auth = null;
  let renewing = null;
  let signingIn = null;
  let resourceMetadataUrl = null;
  /** The client was answered here while signed out: tell it when that ends. */
  let answeredSignedOut = false;
  /** Tool name → read-only, from the server's `tools/list`. */
  const readOnlyTools = new Map();
  /** JSON-RPC id → AbortController of the request being forwarded. */
  const inflight = new Map();
  const closing = new AbortController();

  const authOptions = () => ({ env, fetch: fetchImpl });

  /** The token to send; null when there is none. Throws when it can't tell. */
  async function bearer() {
    const fresh =
      auth && (!auth.expiresAt || auth.expiresAt - EXPIRY_SKEW_MS > Date.now());
    if (!fresh) auth = await currentToken(url, authOptions());
    return auth;
  }

  /**
   * The server refused `rejected`. One renewal serves every request that hit
   * the same refusal: a refresh token is single-use, and a second rotation
   * would cancel the access token the first one has just handed out.
   */
  function renew(rejected) {
    renewing ??= (async () => {
      // Another process on the same credentials file may have renewed it.
      const onDisk = await currentToken(url, authOptions());
      if (onDisk && onDisk.token !== rejected) return onDisk;
      if (!onDisk || onDisk.kind === "personal") return null;
      return currentToken(url, { ...authOptions(), forceRefresh: true });
    })()
      .then((next) => {
        auth = next;
        return next;
      })
      .finally(() => {
        renewing = null;
      });
    return renewing;
  }

  /** The tools changed for the client: after a sign-in or a wider grant. */
  function announceChanged() {
    if (!answeredSignedOut) return;
    answeredSignedOut = false;
    for (const method of [
      "notifications/tools/list_changed",
      "notifications/resources/list_changed",
      "notifications/prompts/list_changed",
    ]) {
      write(JSON.stringify({ jsonrpc: "2.0", method }));
    }
  }

  /** Interactive sign-in, one at a time; `scope`: the rights to ask for. */
  function signIn(scope) {
    if (!interactive || closing.signal.aborted) return Promise.resolve(null);
    signingIn ??= login(url, {
      env,
      fetch: fetchImpl,
      log,
      openBrowser: options.openBrowser,
      resourceMetadataUrl,
      scope,
    })
      .then((saved) => {
        log("Вход выполнен.");
        auth = {
          token: saved.accessToken,
          kind: "oauth",
          expiresAt: saved.expiresAt ?? null,
        };
        announceChanged();
        return auth;
      })
      .catch((error) => {
        log(`Вход не выполнен: ${error.message}`);
        return null;
      })
      .finally(() => {
        signingIn = null;
      });
    return signingIn;
  }

  function post(body, token, signal) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": USER_AGENT,
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    if (protocolVersion) headers["MCP-Protocol-Version"] = protocolVersion;
    return fetchImpl(url, { method: "POST", headers, body, signal });
  }

  /** The messages in a response: a JSON body (one or a batch) or SSE events. */
  async function messagesOf(response) {
    const type = response.headers.get("content-type") ?? "";
    const text = await response.text();
    if (!text.trim()) return [];
    if (type.includes("text/event-stream")) {
      const out = [];
      for (const event of text.split(/\r?\n\r?\n/)) {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) continue;
        try {
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed)) out.push(...parsed);
          else out.push(parsed);
        } catch {
          // not JSON-RPC: skip
        }
      }
      return out;
    }
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  }

  /** The requests (messages that expect an answer) in a message or a batch. */
  function requestsOf(message) {
    return (Array.isArray(message) ? message : [message]).filter(isRequest);
  }

  function errorFor(message, code, text) {
    return requestsOf(message).map(({ id }) => ({
      jsonrpc: "2.0",
      id,
      error: { code, message: text },
    }));
  }

  /** May this message be sent again after a failure the server may have seen? */
  function idempotent(message) {
    const items = Array.isArray(message) ? message : [message];
    return items.every((item) => {
      if (!isRequest(item)) return true;
      if (IDEMPOTENT.has(item.method)) return true;
      return item.method === "tools/call" && readOnlyTools.get(item.params?.name) === true;
    });
  }

  /** Progress for a tool call that asked for it, until its answer arrives. */
  function heartbeat(requests) {
    const tokens = requests
      .filter((item) => item.method === "tools/call")
      .map((item) => item.params?._meta?.progressToken)
      .filter((token) => typeof token === "string" || typeof token === "number");
    if (tokens.length === 0 || heartbeatMs <= 0) return () => {};
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      for (const progressToken of tokens) {
        write(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: { progressToken, progress: ticks, message: "ЮрИИст работает…" },
          }),
        );
      }
    }, heartbeatMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /**
   * One POST with its retries: transient server and network failures, for a
   * message that changes nothing. Resolves the response, or throws the last
   * network error.
   */
  async function postWithRetry(body, token, signal, safe) {
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await post(body, token, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        const code = error?.cause?.code ?? error?.code;
        const retry = NOT_SENT_CODES.has(code) || (safe && RESET_CODES.has(code));
        if (!retry || attempt >= RETRIES) throw error;
        await sleep(1000 * 2 ** attempt, signal);
        continue;
      }
      if (!RETRY_STATUSES.has(response.status) || attempt >= RETRIES) return response;
      const after = retryAfterMs(response.headers.get("retry-after"));
      if (!safe || (after !== null && after > MAX_RETRY_WAIT_MS)) return response;
      await response.text().catch(() => "");
      await sleep(after ?? 1000 * 2 ** attempt, signal);
      if (signal.aborted) throw new Error("aborted");
    }
  }

  /** The text for a failure the server answered with no JSON-RPC body. */
  function httpError(response) {
    const after = retryAfterMs(response.headers.get("retry-after"));
    const wait = after !== null ? ` Повторите через ${Math.max(1, Math.ceil(after / 1000))} с.` : "";
    if (response.status === 503 || response.status === 502 || response.status === 504) {
      return `ЮрИИст временно недоступен (HTTP ${response.status}).${wait || " Повторите чуть позже."}`;
    }
    if (response.status === 429) return `Слишком много запросов к ЮрИИсту.${wait}`;
    if (response.status === 413) return "Запрос слишком большой для ЮрИИста (больше 4 МБ).";
    return `Ошибка сервера ЮрИИста: HTTP ${response.status}`;
  }

  /** The rights a 403 asks for, merged with what the sign-in has now. */
  async function widerScope(required) {
    const saved = await loadCredentials(origin, env).catch(() => null);
    return normalizeScopes([...normalizeScopes(saved?.scope ?? ""), ...normalizeScopes(required ?? "")]);
  }

  async function exchange(message, signal) {
    const body = JSON.stringify(message);
    let current;
    try {
      current = (await bearer()) ?? (await signIn());
    } catch (error) {
      return errorFor(message, -32000, `ЮрИИст недоступен: ${error.message}`);
    }
    if (!current) return errorFor(message, -32001, SIGN_IN_HINT);
    const safe = idempotent(message);

    let response;
    try {
      response = await postWithRetry(body, current.token, signal, safe);
      if (response.status === 401) {
        resourceMetadataUrl =
          resourceMetadataUrlOf(response.headers.get("www-authenticate")) ??
          resourceMetadataUrl;
        await response.text().catch(() => "");
        const personal = current.kind === "personal";
        current = (await renew(current.token)) ?? (personal ? null : await signIn());
        if (!current) {
          return errorFor(
            message,
            -32001,
            personal ? BAD_PERSONAL_TOKEN : SIGN_IN_HINT,
          );
        }
        response = await postWithRetry(body, current.token, signal, safe);
      }
      if (response.status === 403) {
        const challenge = bearerChallengeOf(response.headers.get("www-authenticate"));
        if (challenge.error === "insufficient_scope") {
          await response.text().catch(() => "");
          const required = normalizeScopes(challenge.scope ?? "");
          const named = required.length > 0 ? required.join(", ") : "дополнительное право";
          if (current.kind === "personal") {
            return errorFor(
              message,
              -32003,
              `У личного токена нет права ${named}. Создайте токен с этим правом: ${CONNECTIONS_URL}`,
            );
          }
          log(`Нужно право ${named}: открываю вход, чтобы его выдать.`);
          answeredSignedOut = true;
          const wider = await signIn(await widerScope(challenge.scope));
          if (!wider) {
            answeredSignedOut = false;
            return errorFor(
              message,
              -32003,
              `Нет права ${named}. Войдите заново и разрешите его: \`npx -y @yriist/mcp login --scope ${(await widerScope(challenge.scope)).map((scope) => scope.replace(/^yriist:/, "")).join(",")}\``,
            );
          }
          current = wider;
          response = await postWithRetry(body, current.token, signal, safe);
        }
      }
      if (response.status === 404 && sessionId) {
        // The server dropped the session: start without it.
        await response.text().catch(() => "");
        sessionId = null;
        response = await postWithRetry(body, current.token, signal, safe);
      }
      if (response.status === 401) {
        await response.text().catch(() => "");
        return errorFor(
          message,
          -32001,
          current.kind === "personal" ? BAD_PERSONAL_TOKEN : SIGN_IN_HINT,
        );
      }
      const newSession = response.headers.get("mcp-session-id");
      if (newSession) sessionId = newSession;
      if (response.status === 202 || response.status === 204) {
        await response.text().catch(() => "");
        return [];
      }
      const messages = await messagesOf(response);
      if (!response.ok && messages.length === 0) {
        return errorFor(message, -32000, httpError(response));
      }
      for (const reply of messages) {
        const version = reply?.result?.protocolVersion;
        if (typeof version === "string" && reply?.result?.serverInfo) {
          protocolVersion = version;
        }
        if (Array.isArray(reply?.result?.tools)) {
          for (const tool of reply.result.tools) {
            if (typeof tool?.name === "string") {
              readOnlyTools.set(tool.name, tool.annotations?.readOnlyHint === true);
            }
          }
        }
      }
      return answerWithIds(message, messages);
    } catch (error) {
      // Cancelled by the client or by shutdown: a cancelled request gets no answer.
      if (signal.aborted) return [];
      const reason = error?.cause?.code ?? error?.message ?? String(error);
      return errorFor(message, -32000, `ЮрИИст недоступен: ${reason}`);
    }
  }

  /**
   * An error with `id: null` (the server could not read the request: too
   * large, a bad header) answers every request of the message that got no
   * answer of its own; with none left, it is logged.
   */
  function answerWithIds(message, messages) {
    const anonymous = messages.filter((reply) => reply?.id === null && reply?.error);
    if (anonymous.length === 0) return messages;
    const out = messages.filter((reply) => !(reply?.id === null && reply?.error));
    const answered = new Set(out.map((reply) => reply?.id));
    const open = requestsOf(message).filter(({ id }) => !answered.has(id));
    const { code = -32000, message: text = "Ошибка сервера ЮрИИста" } = anonymous[0].error;
    if (open.length === 0) {
      log(`Сервер ответил ошибкой: ${text}`);
      return out;
    }
    for (const { id } of open) {
      out.push({ jsonrpc: "2.0", id, error: { code, message: text } });
    }
    return out;
  }

  /** What is answered here while there is no sign-in (`null`: forward it). */
  function signedOutReply(item) {
    const reply = (result) => [{ jsonrpc: "2.0", id: item.id, result }];
    switch (item.method) {
      case "initialize": {
        const asked = item.params?.protocolVersion;
        protocolVersion = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
        answeredSignedOut = true;
        // Opens the browser now; the client is answered meanwhile.
        void signIn();
        return reply({
          protocolVersion,
          capabilities: {
            tools: { listChanged: true },
            resources: { listChanged: true },
            prompts: { listChanged: true },
          },
          serverInfo: { name: "yriist", title: "ЮрИИст", version: VERSION },
          instructions:
            "Вход в ЮрИИст ещё не выполнен: инструменты появятся после входа (окно входа открыто в браузере; или вызови yriist_login).",
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        answeredSignedOut = true;
        return reply({ tools: [LOGIN_TOOL] });
      case "resources/list":
        answeredSignedOut = true;
        return reply({ resources: [] });
      case "resources/templates/list":
        answeredSignedOut = true;
        return reply({ resourceTemplates: [] });
      case "prompts/list":
        answeredSignedOut = true;
        return reply({ prompts: [] });
      default:
        return null;
    }
  }

  /** `yriist_login`: signs in, or says it already is. */
  async function loginTool(item) {
    const done = (await bearer().catch(() => null)) ?? (await signIn());
    const text = done
      ? "Вход в ЮрИИст выполнен: инструменты ЮрИИста доступны (обновите список инструментов, если клиент не сделал этого сам)."
      : `Вход не выполнен. ${SIGN_IN_HINT}`;
    if (done) announceChanged();
    return [
      {
        jsonrpc: "2.0",
        id: item.id,
        result: { content: [{ type: "text", text }], isError: !done },
      },
    ];
  }

  /** One message (not a batch) from the client. */
  async function forwardOne(item) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [{ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }];
    }
    if (item.method === "notifications/cancelled") {
      const pending = inflight.get(item.params?.requestId);
      // Aborting the HTTP request is the cancellation: the server sees it.
      if (pending) {
        pending.abort();
        return [];
      }
    }
    const request = isRequest(item);
    if (request && item.method === "tools/call" && item.params?.name === LOGIN_TOOL.name) {
      return loginTool(item);
    }
    if (interactive && !auth) {
      let token = null;
      try {
        token = await bearer();
      } catch {
        token = undefined; // could not tell: forward, and say why there
      }
      if (token === null) {
        if (!request) return []; // a notification never starts a sign-in
        const local = signedOutReply(item);
        if (local) return local;
      }
    }
    return dispatch(item);
  }

  async function dispatch(message) {
    const requests = requestsOf(message);
    const controller = new AbortController();
    const onClose = () => controller.abort();
    closing.signal.addEventListener("abort", onClose, { once: true });
    for (const { id } of requests) inflight.set(id, controller);
    const stopHeartbeat = heartbeat(requests);
    try {
      return await exchange(message, controller.signal);
    } finally {
      stopHeartbeat();
      closing.signal.removeEventListener("abort", onClose);
      for (const { id } of requests) {
        if (inflight.get(id) === controller) inflight.delete(id);
      }
    }
  }

  /** The replies to a message or a batch, in arrival order. */
  async function forward(message) {
    if (!Array.isArray(message)) return forwardOne(message);
    if (message.length === 0) {
      return [{ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }];
    }
    // Batches went away in 2025-06-18: past it (or before it is known) each
    // item goes on its own.
    const batching = protocolVersion !== null && protocolVersion <= LAST_BATCH_VERSION && auth;
    if (batching && message.every((item) => item && typeof item === "object")) {
      for (const item of message) {
        if (item.method === "notifications/cancelled") inflight.get(item.params?.requestId)?.abort();
      }
      return dispatch(message.filter((item) => item.method !== "notifications/cancelled"));
    }
    const replies = await Promise.all(message.map((item) => forwardOne(item)));
    return replies.flat();
  }

  async function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      write(
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }),
      );
      return;
    }
    if (!message || typeof message !== "object") {
      write(
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }),
      );
      return;
    }
    const replies = await forward(message);
    if (replies.length === 0) return;
    // An array in, one array out (JSON-RPC 2.0); an empty batch is one error.
    if (Array.isArray(message) && message.length > 0) write(JSON.stringify(replies));
    else for (const reply of replies) write(JSON.stringify(reply));
  }

  /**
   * The client is gone: requests in flight are dropped, but a sign-in the
   * person has open in the browser is allowed to finish, so the next start
   * finds it done.
   */
  async function close() {
    closing.abort();
    await signingIn;
  }

  return { handleLine, forward, close };
}

/** Runs the bridge on this process's stdin/stdout until stdin closes. */
export function runStdio(options = {}) {
  const bridge = createBridge(options);
  const pending = new Set();
  // The client closed its end of the pipe: nothing more to say.
  process.stdout.on("error", () => process.exit(0));
  if (process.stdin.isTTY) {
    process.stderr.write(
      "[yriist-mcp] Это stdio-сервер для MCP-клиента: его запускает клиент, а не человек.\n[yriist-mcp] Справка: npx -y @yriist/mcp --help · вход: npx -y @yriist/mcp login\n",
    );
  }
  const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  rl.on("line", (line) => {
    const work = bridge.handleLine(line).catch((error) => {
      process.stderr.write(`[yriist-mcp] ${error?.message ?? error}\n`);
    });
    pending.add(work);
    work.finally(() => pending.delete(work));
  });
  return new Promise((resolve) => {
    let finishing = false;
    const finish = async (drop) => {
      if (finishing) return;
      finishing = true;
      rl.close();
      // Nothing more is read, so the process ends once the work below does.
      process.stdin.destroy();
      // End of input (`echo … | yriist-mcp` too): what was asked is still
      // answered. A signal: the client wants the process gone.
      if (drop) await bridge.close();
      await Promise.allSettled([...pending]);
      await bridge.close();
      resolve();
    };
    rl.once("close", () => finish(false));
    process.once("SIGTERM", () => finish(true));
    process.once("SIGINT", () => process.exit(130));
  });
}
