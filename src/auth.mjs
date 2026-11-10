import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { openBrowser } from "./browser.mjs";
import {
  credentialsPath,
  loadCredentials,
  personalToken,
  saveCredentials,
} from "./store.mjs";
import { VERSION } from "./version.mjs";

/**
 * OAuth 2.1 for an MCP server (the MCP authorization spec): protected
 * resource metadata (RFC 9728) → authorization server metadata (RFC 8414) →
 * dynamic client registration (RFC 7591) → authorization code + PKCE S256 in
 * the browser, answered on a loopback port (RFC 8252) → refresh tokens.
 * Works with any spec-compliant server; defaults fit ЮрИИст.
 */

export const CLIENT_NAME = "ЮрИИст MCP (stdio)";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** Refresh a minute before expiry. */
const EXPIRY_SKEW_MS = 60 * 1000;
/** Discovery, registration and token requests: none of them is slow. */
const REQUEST_TIMEOUT_MS = 30 * 1000;

const b64url = (buffer) => Buffer.from(buffer).toString("base64url");
const trimSlash = (value) => String(value).replace(/\/+$/, "");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function pkcePair() {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/**
 * A request that failed before any answer (DNS, refused, timeout). Marked
 * `transient`: the saved sign-in is still good, nothing must be forgotten.
 */
async function request(url, init, fetchImpl) {
  try {
    return await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    const error = new Error(
      `нет связи с ${new URL(url).origin} (${cause?.cause?.code ?? cause?.name ?? "ошибка сети"})`,
    );
    error.transient = true;
    error.cause = cause;
    throw error;
  }
}

async function getJson(url, fetchImpl) {
  const response = await request(
    url,
    { headers: { Accept: "application/json" } },
    fetchImpl,
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  return response.json().catch(() => null);
}

/** `resource_metadata="…"` of a `WWW-Authenticate: Bearer` challenge. */
export function resourceMetadataUrlOf(challenge) {
  const match = /resource_metadata="([^"]+)"/i.exec(challenge ?? "");
  if (!match) return null;
  try {
    const url = new URL(match[1]);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/**
 * Where the server's OAuth lives: resource metadata (the URL the server's
 * 401 names, else the well-known ones), then the authorization server's.
 */
export async function discover(mcpUrl, fetchImpl = fetch, options = {}) {
  const url = new URL(mcpUrl);
  const origin = url.origin;
  const path = trimSlash(url.pathname);
  const resourceCandidates = [
    options.resourceMetadataUrl,
    `${origin}/.well-known/oauth-protected-resource${path}`,
    `${origin}/.well-known/oauth-protected-resource`,
  ].filter(Boolean);
  let resourceMeta = null;
  for (const candidate of new Set(resourceCandidates)) {
    resourceMeta = await getJson(candidate, fetchImpl);
    if (resourceMeta) break;
  }

  const servers = resourceMeta?.authorization_servers;
  const issuer =
    Array.isArray(servers) && typeof servers[0] === "string"
      ? servers[0]
      : origin;
  const issuerUrl = new URL(issuer);
  const issuerPath = trimSlash(issuerUrl.pathname);
  const serverCandidates = [
    `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerPath}`,
    `${issuerUrl.origin}/.well-known/openid-configuration${issuerPath}`,
    `${issuerUrl.origin}${issuerPath}/.well-known/openid-configuration`,
  ];
  let asMeta = null;
  for (const candidate of new Set(serverCandidates)) {
    asMeta = await getJson(candidate, fetchImpl);
    if (asMeta?.authorization_endpoint && asMeta?.token_endpoint) break;
    asMeta = null;
  }
  if (!asMeta) {
    throw new Error(`Сервер ${origin} не сообщает адреса OAuth.`);
  }
  const methods = asMeta.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes("S256")) {
    throw new Error(`Сервер ${origin} не поддерживает PKCE S256.`);
  }

  // RFC 8707: the resource is this MCP server. The server's own name for it
  // is taken only when it covers the URL we were given.
  const canonical = `${origin}${path}`;
  const named =
    typeof resourceMeta?.resource === "string"
      ? trimSlash(resourceMeta.resource)
      : null;
  const resource =
    named && (canonical === named || canonical.startsWith(`${named}/`))
      ? named
      : canonical;

  return {
    resource,
    scopes: resourceMeta?.scopes_supported ?? asMeta.scopes_supported ?? [],
    issuer: trimSlash(asMeta.issuer ?? issuer),
    issRequired: asMeta.authorization_response_iss_parameter_supported === true,
    authorizationEndpoint: asMeta.authorization_endpoint,
    tokenEndpoint: asMeta.token_endpoint,
    registrationEndpoint: asMeta.registration_endpoint ?? null,
    revocationEndpoint: asMeta.revocation_endpoint ?? null,
  };
}

/** The server's 401 challenge, to find its resource metadata by. */
async function challengeOf(mcpUrl, fetchImpl) {
  try {
    const response = await request(
      mcpUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
      },
      fetchImpl,
    );
    await response.body?.cancel().catch(() => {});
    return resourceMetadataUrlOf(response.headers.get("www-authenticate"));
  } catch {
    return null;
  }
}

async function registerClient(meta, redirectUri, fetchImpl) {
  if (!meta.registrationEndpoint) {
    throw new Error("Сервер не поддерживает регистрацию клиентов (DCR).");
  }
  const response = await request(
    meta.registrationEndpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        software_id: "yriist-mcp",
        software_version: VERSION,
      }),
    },
    fetchImpl,
  );
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.client_id) {
    throw new Error(
      `Регистрация клиента не удалась: ${body?.error_description ?? `HTTP ${response.status}`}`,
    );
  }
  return body.client_id;
}

async function tokenRequest(meta, params, fetchImpl) {
  const response = await request(
    meta.tokenEndpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(params).toString(),
    },
    fetchImpl,
  );
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.access_token) {
    const error = new Error(
      body?.error_description ?? body?.error ?? `HTTP ${response.status}`,
    );
    // An OAuth error is the server's verdict; anything else (5xx, 429, a
    // proxy's page) says nothing about the grant.
    error.oauthError = typeof body?.error === "string" ? body.error : null;
    error.transient = !error.oauthError;
    throw error;
  }
  return body;
}

async function revokeToken(meta, token, clientId, fetchImpl) {
  if (!meta?.revocationEndpoint || !token) return;
  await request(
    meta.revocationEndpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, client_id: clientId ?? "" }).toString(),
    },
    fetchImpl,
  )
    .then((response) => response.body?.cancel())
    .catch(() => {});
}

function credentialsFrom(tokens, previous) {
  return {
    ...previous,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? previous.refreshToken ?? null,
    expiresAt: tokens.expires_in
      ? Date.now() + Number(tokens.expires_in) * 1000
      : null,
    scope: tokens.scope ?? previous.scope ?? null,
  };
}

const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );

const DONE_PAGE = (ok, text) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>ЮрИИст</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f5f7fb;color:#0a0a0a}
main{background:#fff;border-radius:20px;padding:32px 36px;box-shadow:0 20px 50px -25px #0f172a55;max-width:420px;text-align:center}
.m{width:44px;height:44px;border-radius:14px;background:#0a0a0a;color:#fff;display:grid;place-items:center;margin:0 auto 16px;font-weight:700}
h1{font-size:20px;margin:0 0 8px}p{color:#667085;margin:0}</style></head>
<body><main><div class="m">Ю</div><h1>${ok ? "Готово" : "Не получилось"}</h1><p>${escapeHtml(text)}</p></main></body></html>`;

/** The authorization code the browser brings back to the loopback server. */
function waitForCode({ server, redirectUri, state, meta, signal, start }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn(value);
    };
    const timer = setTimeout(
      () => settle(reject, new Error("Вход не завершён за 5 минут.")),
      LOGIN_TIMEOUT_MS,
    );
    const onAbort = () => settle(reject, new Error("Вход отменён."));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      const page = (status, ok, text) =>
        res
          .writeHead(status, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            Connection: "close",
          })
          .end(DONE_PAGE(ok, text));
      if (req.method !== "GET" || url.pathname !== "/callback") {
        res.writeHead(404, { Connection: "close" }).end();
        return;
      }
      // Not this sign-in's answer (an old tab, another program on the port):
      // say so and keep waiting for the real one.
      if (settled || url.searchParams.get("state") !== state) {
        page(400, false, "Эта ссылка не от текущего входа. Начните вход заново.");
        return;
      }
      const fail = (message) => {
        page(400, false, message);
        settle(reject, new Error(message));
      };
      // RFC 9207: the answer names the server that gave it.
      const iss = url.searchParams.get("iss");
      if (iss ? trimSlash(iss) !== meta.issuer : meta.issRequired) {
        fail("Ответ пришёл не от сервера, на котором начат вход.");
        return;
      }
      const error = url.searchParams.get("error");
      if (error) {
        fail(
          error === "access_denied"
            ? "Доступ не разрешён."
            : (url.searchParams.get("error_description") ?? error),
        );
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        fail("Сервер не вернул код.");
        return;
      }
      page(200, true, "ЮрИИст подключён. Вкладку можно закрыть.");
      settle(resolve, code);
    });
    start();
  });
}

/**
 * Interactive sign-in: a loopback server, the browser on the consent page,
 * the code exchanged for tokens. Resolves the saved credentials.
 */
export async function login(mcpUrl, options = {}) {
  const fetchImpl = options.fetch ?? fetch;
  const env = options.env ?? process.env;
  const log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
  const origin = new URL(mcpUrl).origin;
  const meta = await discover(mcpUrl, fetchImpl, {
    resourceMetadataUrl:
      options.resourceMetadataUrl ?? (await challengeOf(mcpUrl, fetchImpl)),
  });
  const previous = (await loadCredentials(origin, env)) ?? {};

  // Reuse the registered loopback port when it is free (the client id
  // belongs to that redirect URI); else a new port and a new registration.
  const preferredPort = previous.redirectUri
    ? Number(new URL(previous.redirectUri).port)
    : 0;
  const { server, port } = await listen(preferredPort);
  let code;
  let clientId = previous.clientId;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const { verifier, challenge } = pkcePair();
  try {
    if (!clientId || previous.redirectUri !== redirectUri) {
      clientId = await registerClient(meta, redirectUri, fetchImpl);
      // Kept at once, so a sign-in the person abandons isn't registered
      // again next time. A working sign-in is replaced only by a finished one.
      if (!previous.accessToken) {
        await saveCredentials(origin, { clientId, redirectUri }, env);
      }
    }

    const state = b64url(randomBytes(16));
    const authorize = new URL(meta.authorizationEndpoint);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("resource", meta.resource);
    if (meta.scopes.length > 0) {
      authorize.searchParams.set("scope", meta.scopes.join(" "));
    }

    code = await waitForCode({
      server,
      redirectUri,
      state,
      meta,
      signal: options.signal,
      start: () => {
        log(`Откройте в браузере, чтобы войти в ЮрИИст:\n${authorize}`);
        if (options.openBrowser !== false) {
          openBrowser(authorize.toString(), env);
        }
      },
    });
  } finally {
    server.close();
    server.closeAllConnections?.();
  }

  const tokens = await tokenRequest(
    meta,
    {
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: meta.resource,
    },
    fetchImpl,
  );
  const saved = credentialsFrom(tokens, { clientId, redirectUri });
  await saveCredentials(origin, saved, env);
  // The connection this sign-in replaces would otherwise stay listed in
  // «Подключения» until it expires.
  if (previous.refreshToken && previous.refreshToken !== saved.refreshToken) {
    await revokeToken(meta, previous.refreshToken, previous.clientId, fetchImpl);
  }
  return saved;
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    const onError = (error) => {
      if (port !== 0 && error.code === "EADDRINUSE") {
        server.removeListener("error", onError);
        listen(0).then(resolve, reject);
      } else {
        reject(error);
      }
    };
    server.on("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve({ server, port: server.address().port });
    });
  });
}

/** One refresh per refresh token at a time in this process. */
const refreshing = new Map();

/**
 * Trades the refresh token for new tokens and saves them. Resolves null when
 * the server no longer honours the sign-in (it is then forgotten); throws a
 * `transient` error when the server could not be asked.
 */
export function refresh(mcpUrl, credentials, options = {}) {
  if (!credentials?.refreshToken || !credentials.clientId) {
    return Promise.resolve(null);
  }
  const env = options.env ?? process.env;
  const origin = new URL(mcpUrl).origin;
  const key = [credentialsPath(env), origin, credentials.refreshToken].join("\n");
  let pending = refreshing.get(key);
  if (!pending) {
    pending = rotate(mcpUrl, origin, credentials, {
      env,
      fetchImpl: options.fetch ?? fetch,
    }).finally(() => refreshing.delete(key));
    refreshing.set(key, pending);
  }
  return pending;
}

async function rotate(mcpUrl, origin, credentials, { env, fetchImpl }) {
  const meta = await discover(mcpUrl, fetchImpl);
  try {
    const tokens = await tokenRequest(
      meta,
      {
        grant_type: "refresh_token",
        refresh_token: credentials.refreshToken,
        client_id: credentials.clientId,
        resource: meta.resource,
      },
      fetchImpl,
    );
    const saved = credentialsFrom(tokens, credentials);
    await saveCredentials(origin, saved, env);
    return saved;
  } catch (error) {
    const refused =
      error.oauthError === "invalid_grant" ||
      error.oauthError === "invalid_client";
    if (!refused) throw error;
    // Refresh tokens are single-use, and several clients may run this
    // package on one credentials file: whoever lost the race finds the
    // winner's tokens on disk (a moment later, at worst).
    for (const wait of [0, 400]) {
      if (wait) await sleep(wait);
      const onDisk = await loadCredentials(origin, env);
      if (
        onDisk?.accessToken &&
        onDisk.refreshToken !== credentials.refreshToken
      ) {
        return onDisk;
      }
    }
    // Revoked or expired: forget the tokens. An unknown client is forgotten
    // whole, so the next sign-in registers anew.
    await saveCredentials(
      origin,
      error.oauthError === "invalid_client"
        ? null
        : {
            clientId: credentials.clientId,
            redirectUri: credentials.redirectUri,
          },
      env,
    );
    return null;
  }
}

/**
 * The bearer token to send: a personal token wins; else the saved OAuth
 * access token, refreshed when it is about to expire (`forceRefresh`: now,
 * the server refused it). Null: sign-in needed. Throws a `transient` error
 * when a refresh was due and the server could not be reached.
 */
export async function currentToken(mcpUrl, options = {}) {
  const env = options.env ?? process.env;
  const personal = await personalToken(env);
  if (personal) return { token: personal, kind: "personal", expiresAt: null };
  const origin = new URL(mcpUrl).origin;
  let credentials = await loadCredentials(origin, env);
  if (!credentials?.accessToken) return null;
  const now = Date.now();
  const expired = Boolean(credentials.expiresAt) && credentials.expiresAt <= now;
  const expiring =
    Boolean(credentials.expiresAt) &&
    credentials.expiresAt - EXPIRY_SKEW_MS <= now;
  if (options.forceRefresh || expiring) {
    const mustRefresh = options.forceRefresh || expired;
    try {
      const refreshed = await refresh(mcpUrl, credentials, { ...options, env });
      if (refreshed?.accessToken) credentials = refreshed;
      else if (mustRefresh || credentials.refreshToken) return null;
    } catch (error) {
      // Not yet expired: the token in hand still works for a moment.
      if (mustRefresh) throw error;
    }
  }
  return {
    token: credentials.accessToken,
    kind: "oauth",
    expiresAt: credentials.expiresAt ?? null,
  };
}

/** Signs out: the connection is revoked on the server and forgotten here. */
export async function revoke(mcpUrl, options = {}) {
  const fetchImpl = options.fetch ?? fetch;
  const env = options.env ?? process.env;
  const origin = new URL(mcpUrl).origin;
  const credentials = await loadCredentials(origin, env);
  if (!credentials) return false;
  const token = credentials.refreshToken ?? credentials.accessToken;
  if (token) {
    const meta = await discover(mcpUrl, fetchImpl).catch(() => null);
    await revokeToken(meta, token, credentials.clientId, fetchImpl);
  }
  await saveCredentials(origin, null, env);
  return true;
}
