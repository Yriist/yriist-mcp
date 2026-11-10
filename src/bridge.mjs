import { createInterface } from "node:readline";
import { currentToken, login, resourceMetadataUrlOf } from "./auth.mjs";
import { VERSION } from "./version.mjs";

/**
 * A stdio MCP server that forwards every JSON-RPC message to a remote
 * Streamable HTTP MCP server (ЮрИИст: https://app.yriist.ru/api/mcp) with a
 * bearer token, for clients that only run local (stdio) servers or cannot do
 * OAuth themselves. Messages are newline-delimited JSON on stdin/stdout;
 * logs go to stderr only.
 *
 * - JSON and SSE responses are both handled; `Mcp-Session-Id` and the
 *   negotiated `MCP-Protocol-Version` are carried on.
 * - A token the server refuses is refreshed once for all waiting requests;
 *   if that fails and sign-in is allowed, the browser opens and they wait.
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

const SIGN_IN_HINT =
  "Нужен вход в ЮрИИст: выполните `npx -y @yriist/mcp login` или задайте YRIIST_TOKEN.";
const BAD_PERSONAL_TOKEN =
  "Личный токен ЮрИИста недействителен или отозван. Создайте новый: https://app.yriist.ru/account/connections";

export function createBridge(options = {}) {
  const url = options.url ?? DEFAULT_URL;
  const fetchImpl = options.fetch ?? fetch;
  const env = options.env ?? process.env;
  const write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
  const log = options.log ?? ((line) => process.stderr.write(`[yriist-mcp] ${line}\n`));
  const interactive = options.interactive ?? true;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;

  let sessionId = null;
  let protocolVersion = null;
  /** `{ token, kind, expiresAt }` in use, or null. */
  let auth = null;
  let renewing = null;
  let signingIn = null;
  let resourceMetadataUrl = null;
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

  function signIn() {
    if (!interactive || closing.signal.aborted) return Promise.resolve(null);
    signingIn ??= login(url, {
      env,
      fetch: fetchImpl,
      log,
      openBrowser: options.openBrowser,
      resourceMetadataUrl,
    })
      .then((saved) => {
        log("Вход выполнен.");
        auth = {
          token: saved.accessToken,
          kind: "oauth",
          expiresAt: saved.expiresAt ?? null,
        };
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
    return (Array.isArray(message) ? message : [message]).filter(
      (item) =>
        item &&
        typeof item === "object" &&
        item.id !== undefined &&
        item.id !== null &&
        typeof item.method === "string",
    );
  }

  function errorFor(message, code, text) {
    return requestsOf(message).map(({ id }) => ({
      jsonrpc: "2.0",
      id,
      error: { code, message: text },
    }));
  }

  /** `notifications/cancelled`: stop waiting for the request it names. */
  function cancel(message) {
    for (const item of Array.isArray(message) ? message : [message]) {
      if (item?.method !== "notifications/cancelled") continue;
      inflight.get(item.params?.requestId)?.abort();
    }
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

  async function exchange(message, signal) {
    const body = JSON.stringify(message);
    let current;
    try {
      current = (await bearer()) ?? (await signIn());
    } catch (error) {
      return errorFor(message, -32000, `ЮрИИст недоступен: ${error.message}`);
    }
    if (!current) return errorFor(message, -32001, SIGN_IN_HINT);

    let response;
    try {
      response = await post(body, current.token, signal);
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
        response = await post(body, current.token, signal);
      }
      if (response.status === 404 && sessionId) {
        // The server dropped the session: start without it.
        await response.text().catch(() => "");
        sessionId = null;
        response = await post(body, current.token, signal);
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
        return errorFor(
          message,
          -32000,
          `Ошибка сервера ЮрИИста: HTTP ${response.status}`,
        );
      }
      for (const reply of messages) {
        const version = reply?.result?.protocolVersion;
        if (typeof version === "string" && reply?.result?.serverInfo) {
          protocolVersion = version;
        }
      }
      return messages;
    } catch (error) {
      // Cancelled by the client or by shutdown: a cancelled request gets no answer.
      if (signal.aborted) return [];
      const reason = error?.cause?.code ?? error?.message ?? String(error);
      return errorFor(message, -32000, `ЮрИИст недоступен: ${reason}`);
    }
  }

  async function forward(message) {
    cancel(message);
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
    for (const reply of replies) write(JSON.stringify(reply));
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
