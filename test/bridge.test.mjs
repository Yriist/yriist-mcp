import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { login, refresh, resourceMetadataUrlOf, revoke } from "../src/auth.mjs";
import { bearerChallengeOf, createBridge, retryAfterMs } from "../src/bridge.mjs";
import { clientConfigs } from "../src/clients.mjs";
import { nodeHasEnvProxy, proxyPlan } from "../src/proxy.mjs";
import { loadCredentials, saveCredentials, updateCredentials } from "../src/store.mjs";

/**
 * A mock MCP server with an OAuth 2.1 authorization server, shaped like
 * app.yriist.ru: metadata, DCR, /authorize that approves at once, a token
 * endpoint with PKCE and rotating refresh (a rotation cancels the previous
 * access token, as the real one does), revocation, and /api/mcp that answers
 * JSON or SSE depending on the method.
 */
let server;
let base;
const state = {
  clients: new Map(),
  codes: new Map(),
  access: new Set(),
  refresh: new Map(),
  revoked: [],
  calls: [],
  aborted: [],
  issued: 0,
  refreshCalls: 0,
  badIss: false,
  /** Bodies POSTed to /api/mcp that were arrays. */
  batches: 0,
  /** Access token → the scope it was granted. */
  scopes: new Map(),
  lastScope: null,
  /** Tool name → how many more times it answers 503. */
  unavailable: new Map(),
  attempts: new Map(),
  dropSession: false,
};

const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
  });
}

before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/oauth-protected-resource/api/mcp") {
      return json(200, { resource: `${base}/api/mcp`, authorization_servers: [base], scopes_supported: ["yriist:read"] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/api/oauth/token`,
        registration_endpoint: `${base}/api/oauth/register`,
        revocation_endpoint: `${base}/api/oauth/revoke`,
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
      });
    }
    if (url.pathname === "/api/oauth/register") {
      const body = JSON.parse(await readBody(req));
      const id = `yc_${state.clients.size + 1}`;
      state.clients.set(id, body.redirect_uris);
      return json(201, { client_id: id, redirect_uris: body.redirect_uris });
    }
    if (url.pathname === "/oauth/authorize") {
      const p = url.searchParams;
      assert.equal(p.get("code_challenge_method"), "S256");
      assert.equal(p.get("resource"), `${base}/api/mcp`);
      // Loopback redirects match on any port (RFC 8252), as on the real server.
      const loose = (uri) => uri.replace(/^(http:\/\/127\.0\.0\.1):\d+/, "$1");
      assert.ok(state.clients.get(p.get("client_id"))?.some((uri) => loose(uri) === loose(p.get("redirect_uri"))));
      const code = `code_${state.codes.size + 1}_${Math.random().toString(36).slice(2)}`;
      state.lastScope = p.get("scope");
      state.codes.set(code, { challenge: p.get("code_challenge"), client: p.get("client_id"), scope: p.get("scope") });
      const target = new URL(p.get("redirect_uri"));
      target.searchParams.set("code", code);
      target.searchParams.set("state", p.get("state"));
      target.searchParams.set("iss", state.badIss ? "https://evil.example" : base);
      res.writeHead(302, { Location: target.toString() });
      return res.end();
    }
    if (url.pathname === "/api/oauth/token") {
      const p = new URLSearchParams(await readBody(req));
      if (p.get("grant_type") === "authorization_code") {
        const entry = state.codes.get(p.get("code"));
        state.codes.delete(p.get("code"));
        const challenge = createHash("sha256").update(p.get("code_verifier")).digest("base64url");
        if (!entry || entry.challenge !== challenge) return json(400, { error: "invalid_grant" });
        p.set("scope", entry.scope ?? "");
      } else if (p.get("grant_type") === "refresh_token") {
        state.refreshCalls += 1;
        // Long enough for every waiting request to pile up behind it.
        await new Promise((resolve) => setTimeout(resolve, 30));
        const previous = state.refresh.get(p.get("refresh_token"));
        if (!previous) return json(400, { error: "invalid_grant" });
        state.refresh.delete(p.get("refresh_token"));
        state.access.delete(previous);
      }
      state.issued += 1;
      const access = `yrt_access${String(state.issued).padStart(20, "0")}`;
      const refreshToken = `yrr_refresh${state.issued}`;
      state.access.add(access);
      state.refresh.set(refreshToken, access);
      state.scopes.set(access, p.get("scope") ?? "");
      return json(200, { access_token: access, refresh_token: refreshToken, expires_in: 3600, token_type: "Bearer", scope: p.get("scope") || undefined });
    }
    if (url.pathname === "/api/oauth/revoke") {
      const p = new URLSearchParams(await readBody(req));
      state.revoked.push(p.get("token"));
      res.writeHead(200);
      return res.end();
    }
    if (url.pathname === "/api/mcp") {
      const auth = req.headers.authorization?.replace(/^Bearer /, "");
      const known = state.access.has(auth) || (auth?.startsWith("yrp_") && !auth.includes("revoked"));
      if (!auth || !known) {
        return json(401, { error: "unauthorized" }, {
          "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/api/mcp"`,
        });
      }
      const protocol = req.headers["mcp-protocol-version"];
      if (state.dropSession && req.headers["mcp-session-id"]) {
        return json(404, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session not found" } });
      }
      const body = JSON.parse(await readBody(req));
      if (Array.isArray(body)) {
        state.batches += 1;
        // Batches are gone from 2025-06-18 on, as on the real server.
        if (protocol && protocol >= "2025-06-18") {
          return json(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batches are not supported" } });
        }
        const replies = body.filter((item) => item.id !== undefined).map((item) => ({ jsonrpc: "2.0", id: item.id, result: { echo: item.method } }));
        state.calls.push(...body.map((item) => ({ method: item.method, auth, protocol, batch: true })));
        return replies.length ? json(200, replies) : (res.writeHead(202), res.end());
      }
      const message = body;
      const tool = message.method === "tools/call" ? message.params?.name : null;
      state.calls.push({ method: message.method, tool, auth, protocol, session: req.headers["mcp-session-id"] ?? null });
      if (message.id === undefined) {
        res.writeHead(202);
        return res.end();
      }
      const key = tool ?? message.method;
      state.attempts.set(key, (state.attempts.get(key) ?? 0) + 1);
      const left = state.unavailable.get(key) ?? 0;
      if (left > 0) {
        state.unavailable.set(key, left - 1);
        res.writeHead(503, { "Content-Type": "text/html", "Retry-After": "2" });
        return res.end("<html>503</html>");
      }
      if (message.method === "initialize") {
        const asked = message.params?.protocolVersion;
        return json(200, {
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: VERSIONS.includes(asked) ? asked : "2025-06-18", serverInfo: { name: "yriist" }, capabilities: {} },
        }, { "Mcp-Session-Id": "s1" });
      }
      if (message.method === "tools/list") {
        return json(200, {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [
              { name: "whoami", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
              { name: "law_article", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
              { name: "ask_yriist", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
            ],
          },
        });
      }
      if (tool === "big") {
        return json(413, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Body too large" } });
      }
      if (tool === "scoped") {
        const granted = auth.startsWith("yrp_") ? "" : (state.scopes.get(auth) ?? "");
        if (!granted.split(" ").includes("yriist:write")) {
          return json(403, { jsonrpc: "2.0", id: message.id, error: { code: -32003, message: "Forbidden" } }, {
            "WWW-Authenticate": `Bearer error="insufficient_scope", scope="yriist:read yriist:write", resource_metadata="${base}/.well-known/oauth-protected-resource/api/mcp"`,
          });
        }
        return json(200, { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "scoped ok" }] } });
      }
      if (tool === "echo_size") {
        const size = JSON.stringify(message.params.arguments).length;
        return json(200, { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: String(size) }] } });
      }
      if (tool === "multi") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        return res.end(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "working" } })}\n\n` +
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "done" }] } })}\n\n`,
        );
      }
      if (message.method === "tools/call" && message.params?.name === "slow") {
        // Answers after 5 s unless the client hangs up first.
        const timer = setTimeout(() => json(200, { jsonrpc: "2.0", id: message.id, result: {} }), 5_000);
        res.on("close", () => {
          clearTimeout(timer);
          if (!res.writableEnded) state.aborted.push(message.id);
        });
        return;
      }
      if (message.method === "tools/call" && message.params?.name === "brief") {
        return setTimeout(() => json(200, { jsonrpc: "2.0", id: message.id, result: {} }), 120);
      }
      if (message.method === "tools/call") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        return res.end(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "ok" }] } })}\n\n`,
        );
      }
      return json(200, { jsonrpc: "2.0", id: message.id, result: {} });
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections?.();
  server.close();
});

async function tempEnv() {
  const dir = await mkdtemp(join(tmpdir(), "yriist-mcp-"));
  return { XDG_CONFIG_HOME: dir, YRIIST_NO_BROWSER: "1" };
}

/** Plays the browser: follows the printed authorize URL to the loopback callback. */
function fakeBrowserLog(lines, visit = (url) => fetch(url).catch(() => {})) {
  return (line) => {
    lines.push(line);
    const match = /(http\S+\/oauth\/authorize\S+)/.exec(line);
    if (match) setTimeout(() => visit(match[1]), 10);
  };
}

function bridgeFor(env, extra = {}) {
  const out = [];
  const bridge = createBridge({
    url: `${base}/api/mcp`,
    env,
    write: (line) => out.push(JSON.parse(line)),
    log: () => {},
    interactive: false,
    ...extra,
  });
  const send = (message) => bridge.handleLine(JSON.stringify(message));
  return { bridge, out, send };
}

/** Saved credentials whose access token the server no longer knows. */
async function staleCredentials(env, expiresAt = Date.now() + 3_600_000) {
  const refreshToken = `yrr_valid${state.refresh.size + state.issued + 1}`;
  state.refresh.set(refreshToken, "yrt_stale");
  await saveCredentials(
    base,
    { clientId: "yc_1", redirectUri: "http://127.0.0.1:1/callback", accessToken: "yrt_stale", refreshToken, expiresAt },
    env,
  );
  return refreshToken;
}

test("login: discovery, DCR, PKCE, token saved 0600", async () => {
  const env = await tempEnv();
  const lines = [];
  const saved = await login(`${base}/api/mcp`, { env, log: fakeBrowserLog(lines), openBrowser: false });
  assert.match(saved.accessToken, /^yrt_/);
  assert.ok(saved.refreshToken);
  const file = join(env.XDG_CONFIG_HOME, "yriist", "credentials.json");
  const stored = JSON.parse(await readFile(file, "utf8"));
  assert.equal(stored[base].accessToken, saved.accessToken);
  // Windows has no owner-only mode bits to check.
  if (process.platform !== "win32") {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
});

test("login ignores a callback that is not its own and waits for the real one", async () => {
  const env = await tempEnv();
  const visit = async (authorizeUrl) => {
    const redirect = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri"));
    redirect.searchParams.set("code", "stolen");
    redirect.searchParams.set("state", "not-the-state");
    const stray = await fetch(redirect);
    assert.equal(stray.status, 400);
    await fetch(authorizeUrl);
  };
  const saved = await login(`${base}/api/mcp`, { env, log: fakeBrowserLog([], visit), openBrowser: false });
  assert.match(saved.accessToken, /^yrt_/);
});

test("login refuses an answer from another issuer", async () => {
  const env = await tempEnv();
  state.badIss = true;
  try {
    await assert.rejects(
      login(`${base}/api/mcp`, { env, log: fakeBrowserLog([]), openBrowser: false }),
      /не от сервера/,
    );
  } finally {
    state.badIss = false;
  }
  assert.equal((await loadCredentials(base, env))?.accessToken, undefined);
});

test("an abandoned login keeps its registration for the next one", async () => {
  const env = await tempEnv();
  const abort = new AbortController();
  const before = state.clients.size;
  await assert.rejects(
    login(`${base}/api/mcp`, { env, log: () => setTimeout(() => abort.abort(), 10), openBrowser: false, signal: abort.signal }),
    /отменён/,
  );
  assert.equal(state.clients.size, before + 1);
  const kept = await loadCredentials(base, env);
  assert.ok(kept.clientId);
  const saved = await login(`${base}/api/mcp`, { env, log: fakeBrowserLog([]), openBrowser: false });
  assert.equal(state.clients.size, before + 1, "no second registration");
  assert.equal(saved.clientId, kept.clientId);
});

test("logout revokes the connection and forgets it", async () => {
  const env = await tempEnv();
  const saved = await login(`${base}/api/mcp`, { env, log: fakeBrowserLog([]), openBrowser: false });
  assert.equal(await revoke(`${base}/api/mcp`, { env }), true);
  assert.ok(state.revoked.includes(saved.refreshToken));
  assert.equal(await loadCredentials(base, env), null);
  assert.equal(await revoke(`${base}/api/mcp`, { env }), false);
});

test("bridge forwards JSON and SSE, carries the protocol version", async () => {
  const env = { ...(await tempEnv()), YRIIST_TOKEN: "yrp_personaltokenpersonaltoken" };
  const { out, send } = bridgeFor(env);
  await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "whoami" } });
  assert.equal(out.length, 2);
  assert.equal(out[0].result.protocolVersion, "2025-06-18");
  assert.equal(out[1].result.content[0].text, "ok");
  const last = state.calls.at(-1);
  assert.equal(last.auth, "yrp_personaltokenpersonaltoken");
  assert.equal(last.protocol, "2025-06-18");
});

test("bridge refreshes a refused token on 401", async () => {
  const env = await tempEnv();
  const refreshToken = await staleCredentials(env);
  const { out, send } = bridgeFor(env);
  await send({ jsonrpc: "2.0", id: 7, method: "ping" });
  assert.deepEqual(out[0], { jsonrpc: "2.0", id: 7, result: {} });
  assert.ok(!state.refresh.has(refreshToken), "refresh token rotated");
});

test("requests refused together share one refresh", async () => {
  const env = await tempEnv();
  await staleCredentials(env);
  const { out, send } = bridgeFor(env);
  const before = state.refreshCalls;
  await Promise.all([1, 2, 3, 4, 5].map((id) => send({ jsonrpc: "2.0", id, method: "ping" })));
  assert.equal(state.refreshCalls - before, 1);
  assert.equal(out.length, 5);
  assert.ok(out.every((reply) => reply.result && !reply.error));
  assert.match((await loadCredentials(base, env)).accessToken, /^yrt_access/);
});

test("a refresh another process already made is picked up from disk", async () => {
  const env = await tempEnv();
  const used = { clientId: "yc_1", redirectUri: "http://127.0.0.1:1/callback", accessToken: "yrt_old", refreshToken: "yrr_spent" };
  const winner = { ...used, accessToken: "yrt_fromotherprocess", refreshToken: "yrr_next" };
  await saveCredentials(base, winner, env);
  const result = await refresh(`${base}/api/mcp`, used, { env });
  assert.equal(result.accessToken, "yrt_fromotherprocess");
  assert.deepEqual(await loadCredentials(base, env), winner);
});

test("a refresh the server refuses forgets the tokens, keeps the registration", async () => {
  const env = await tempEnv();
  const used = { clientId: "yc_1", redirectUri: "http://127.0.0.1:1/callback", accessToken: "yrt_old", refreshToken: "yrr_revoked" };
  await saveCredentials(base, used, env);
  assert.equal(await refresh(`${base}/api/mcp`, used, { env }), null);
  assert.deepEqual(await loadCredentials(base, env), { clientId: "yc_1", redirectUri: used.redirectUri });
});

test("a network failure during refresh keeps the sign-in", async () => {
  const env = await tempEnv();
  const refreshToken = await staleCredentials(env, Date.now() - 1_000);
  const offline = (url, init) =>
    String(url).includes("/api/oauth/token") ? Promise.reject(new TypeError("fetch failed")) : fetch(url, init);
  const { out, send } = bridgeFor(env, { fetch: offline });
  await send({ jsonrpc: "2.0", id: 4, method: "ping" });
  assert.equal(out[0].error.code, -32000);
  assert.match(out[0].error.message, /недоступен/);
  assert.equal((await loadCredentials(base, env)).refreshToken, refreshToken);
});

test("bridge without credentials answers a clear JSON-RPC error", async () => {
  const { out, send } = bridgeFor(await tempEnv());
  await send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  assert.equal(out[0].id, 3);
  assert.equal(out[0].error.code, -32001);
  assert.match(out[0].error.message, /login/);
});

test("a refused personal token is named as such", async () => {
  const env = { ...(await tempEnv()), YRIIST_TOKEN: "yrp_revokedtokenrevokedtoken" };
  const { out, send } = bridgeFor(env);
  await send({ jsonrpc: "2.0", id: 5, method: "tools/list" });
  assert.equal(out[0].error.code, -32001);
  assert.match(out[0].error.message, /Личный токен/);
});

test("notifications/cancelled aborts the request and it gets no answer", async () => {
  const env = { ...(await tempEnv()), YRIIST_TOKEN: "yrp_personaltokenpersonaltoken" };
  const { out, send } = bridgeFor(env);
  const slow = send({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "slow" } });
  await new Promise((resolve) => setTimeout(resolve, 60));
  await send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 9 } });
  await slow;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(out, []);
  assert.ok(state.aborted.includes(9), "the server saw the request dropped");
});

test("close() drops requests in flight", async () => {
  const env = { ...(await tempEnv()), YRIIST_TOKEN: "yrp_personaltokenpersonaltoken" };
  const { bridge, out, send } = bridgeFor(env);
  const slow = send({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "slow" } });
  await new Promise((resolve) => setTimeout(resolve, 60));
  await bridge.close();
  await slow;
  assert.deepEqual(out, []);
});

test("a long tool call that asked for progress gets a heartbeat", async () => {
  const env = { ...(await tempEnv()), YRIIST_TOKEN: "yrp_personaltokenpersonaltoken" };
  const { out, send } = bridgeFor(env, { heartbeatMs: 25 });
  await send({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "brief", _meta: { progressToken: "p1" } } });
  const progress = out.filter((message) => message.method === "notifications/progress");
  assert.ok(progress.length >= 2);
  assert.equal(progress[0].params.progressToken, "p1");
  assert.ok(progress[1].params.progress > progress[0].params.progress);
  assert.deepEqual(out.at(-1), { jsonrpc: "2.0", id: 12, result: {} });
});

test("parse error on garbage input", async () => {
  const { bridge, out } = bridgeFor(await tempEnv());
  await bridge.handleLine("{not json");
  assert.equal(out[0].error.code, -32700);
  await bridge.handleLine("42");
  assert.equal(out[1].error.code, -32600);
});

test("resource_metadata is read from the 401 challenge", () => {
  assert.equal(
    resourceMetadataUrlOf('Bearer realm="yriist", resource_metadata="https://app.yriist.ru/.well-known/oauth-protected-resource/api/mcp"'),
    "https://app.yriist.ru/.well-known/oauth-protected-resource/api/mcp",
  );
  assert.equal(resourceMetadataUrlOf('Bearer resource_metadata="javascript:alert(1)"'), null);
  assert.equal(resourceMetadataUrlOf(null), null);
});

test("client configs: every JSON one parses, names the server and uses the client's own keys", () => {
  const custom = "http://localhost:3000/api/mcp";
  const configs = clientConfigs(custom, { windows: false });
  for (const [name, config] of Object.entries(configs)) {
    assert.ok(config.title && config.text, name);
    assert.ok(config.text.includes(custom), `${name} carries the custom url`);
    // The first block is the config itself; `# …` lines after it are alternatives.
    const first = config.text.split(/\n\n#/)[0];
    if (first.trimStart().startsWith("{")) JSON.parse(first);
  }
  const first = (name) => JSON.parse(configs[name].text.split(/\n\n#/)[0]);
  assert.deepEqual(first("cursor"), { mcpServers: { yriist: { url: custom } } });
  assert.deepEqual(first("vscode"), { servers: { yriist: { type: "http", url: custom } } });
  assert.deepEqual(first("windsurf"), { mcpServers: { yriist: { serverUrl: custom } } });
  assert.deepEqual(first("gemini"), { mcpServers: { yriist: { httpUrl: custom } } });
  assert.deepEqual(first("zed"), { context_servers: { yriist: { url: custom } } });
  assert.deepEqual(first("devin"), { mcpServers: { yriist: { url: custom, transport: "http" } } });
  assert.deepEqual(first("antigravity"), { mcpServers: { yriist: { serverUrl: custom } } });
  assert.deepEqual(first("copilot"), { mcpServers: { yriist: { type: "http", url: custom, tools: ["*"], timeout: 300000 } } });
  assert.deepEqual(first("cline"), { mcpServers: { yriist: { type: "streamableHttp", url: custom } } });
  assert.deepEqual(first("roo"), { mcpServers: { yriist: { type: "streamable-http", url: custom, timeout: 300 } } });
  assert.deepEqual(first("opencode"), { mcp: { servers: { yriist: { type: "remote", url: custom } } } });
  assert.match(configs.continue.text, /^ {4}type: streamable-http$/m);
  assert.match(configs.goose.text, /^ {4}uri: http:\/\/localhost:3000\/api\/mcp$/m);
  assert.deepEqual(first("stdio"), {
    mcpServers: { yriist: { command: "npx", args: ["-y", "@yriist/mcp", "--url", custom] } },
  });
  assert.match(configs.codex.text, /^codex mcp add yriist --url http:\/\/localhost:3000\/api\/mcp$/m);
  assert.match(configs.codex.text, /^tool_timeout_sec = 300$/m);
  const claude = /add-json yriist '([^']+)'/.exec(configs["claude-code"].text);
  assert.deepEqual(JSON.parse(claude[1]), { type: "http", url: custom, timeout: 300000 });
});

test("client configs: on Windows the stdio form goes through cmd /c", () => {
  const configs = clientConfigs(undefined, { windows: true });
  assert.deepEqual(JSON.parse(configs.stdio.text), {
    mcpServers: { yriist: { command: "cmd", args: ["/c", "npx", "-y", "@yriist/mcp"] } },
  });
  assert.match(configs.codex.text, /command = "cmd"\nargs = \["\/c","npx","-y","@yriist\/mcp"\]/);
});

/** Runs the real CLI as a client would: lines in on stdin, lines out on stdout. */
function runCli(args, env, input = "") {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/yriist-mcp.mjs", import.meta.url)), ...args], {
      // The developer's own token or server must not leak into the run.
      env: { ...process.env, YRIIST_TOKEN: "", YRIIST_MCP_URL: "", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test("cli: stdio server answers and exits when stdin closes", async () => {
  const env = { ...(await tempEnv()), YRIIST_TOKEN: "yrp_personaltokenpersonaltoken" };
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "whoami" } },
  ]
    .map((message) => JSON.stringify(message))
    .join("\n");
  const { code, stdout } = await runCli(["--url", `${base}/api/mcp`], env, `${input}\n`);
  assert.equal(code, 0);
  const replies = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(replies.map((reply) => reply.id).sort(), [1, 2]);
});

test("cli: refuses to send a token over plain http to another host", async () => {
  const { code, stderr } = await runCli(["status", "--url", "http://example.com/api/mcp"], await tempEnv());
  assert.equal(code, 1);
  assert.match(stderr, /https:\/\//);
});

test("cli: status without a sign-in says how to sign in, on stderr", async () => {
  const { code, stdout, stderr } = await runCli(["status", "--url", `${base}/api/mcp`], await tempEnv());
  assert.equal(code, 1);
  assert.match(stderr, /login/);
  assert.equal(stdout, "");
});

// ── Protocol: batches, errors without an id, sessions, SSE ────────────────

const PERSONAL = "yrp_personaltokenpersonaltoken";
const personalEnv = async () => ({ ...(await tempEnv()), YRIIST_TOKEN: PERSONAL });

test("a batch is split once the protocol has none, and answered as one array", async () => {
  const { out, send } = bridgeFor(await personalEnv());
  await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  const before = state.batches;
  await send([
    { jsonrpc: "2.0", id: 20, method: "ping" },
    { jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "whoami" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
  ]);
  assert.equal(state.batches, before, "no array reached the server");
  const reply = out.at(-1);
  assert.ok(Array.isArray(reply));
  assert.deepEqual(reply.map((item) => item.id).sort(), [20, 21]);
});

test("a batch goes as one on a protocol that still has batches", async () => {
  const { out, send } = bridgeFor(await personalEnv());
  await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  const before = state.batches;
  await send([
    { jsonrpc: "2.0", id: 30, method: "ping" },
    { jsonrpc: "2.0", id: 31, method: "prompts/list" },
  ]);
  assert.equal(state.batches, before + 1);
  assert.deepEqual(out.at(-1).map((item) => item.id), [30, 31]);
});

test("an empty batch is one Invalid Request", async () => {
  const { out, send } = bridgeFor(await personalEnv());
  await send([]);
  assert.equal(out[0].error.code, -32600);
  assert.equal(out[0].id, null);
});

test("a server error without an id answers the request it was for", async () => {
  const { out, send } = bridgeFor(await personalEnv());
  await send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "big" } });
  assert.deepEqual(out, [{ jsonrpc: "2.0", id: 7, error: { code: -32600, message: "Body too large" } }]);
});

test("a dropped session is started again without the old id", async () => {
  const { out, send } = bridgeFor(await personalEnv());
  await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  state.dropSession = true;
  try {
    await send({ jsonrpc: "2.0", id: 2, method: "ping" });
  } finally {
    state.dropSession = false;
  }
  assert.deepEqual(out.at(-1), { jsonrpc: "2.0", id: 2, result: {} });
  assert.equal(state.calls.at(-1).session, null);
});

test("several SSE events in one response are all relayed", async () => {
  const { out, send } = bridgeFor(await personalEnv());
  await send({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "multi" } });
  assert.equal(out.length, 2);
  assert.equal(out[0].method, "notifications/message");
  assert.equal(out[1].result.content[0].text, "done");
});

test("a line longer than a pipe chunk arrives whole", async () => {
  const { out, send } = bridgeFor(await personalEnv());
  const text = "ю".repeat(200_000);
  await send({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "echo_size", arguments: { text } } });
  assert.equal(out[0].result.content[0].text, String(JSON.stringify({ text }).length));
});

test("a cancellation that matched a request in flight is not sent on", async () => {
  const { out, send } = bridgeFor(await personalEnv());
  const slow = send({ jsonrpc: "2.0", id: 40, method: "tools/call", params: { name: "slow" } });
  await new Promise((resolve) => setTimeout(resolve, 60));
  await send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 40 } });
  await slow;
  assert.deepEqual(out, []);
  assert.ok(!state.calls.some((call) => call.method === "notifications/cancelled"));
});

// ── Retries ───────────────────────────────────────────────────────────────

test("503 with Retry-After is retried for a request that changes nothing", async () => {
  const waits = [];
  const { out, send } = bridgeFor(await personalEnv(), { sleep: async (ms) => waits.push(ms) });
  state.unavailable.set("prompts/list", 1);
  await send({ jsonrpc: "2.0", id: 50, method: "prompts/list" });
  assert.deepEqual(out, [{ jsonrpc: "2.0", id: 50, result: {} }]);
  assert.deepEqual(waits, [2000]);
});

test("a tool call that may change something is not retried, and says when to retry", async () => {
  const waits = [];
  const { out, send } = bridgeFor(await personalEnv(), { sleep: async (ms) => waits.push(ms) });
  state.unavailable.set("ask_yriist", 1);
  const before = state.attempts.get("ask_yriist") ?? 0;
  await send({ jsonrpc: "2.0", id: 51, method: "tools/call", params: { name: "ask_yriist" } });
  assert.equal(state.attempts.get("ask_yriist") - before, 1);
  assert.deepEqual(waits, []);
  assert.match(out[0].error.message, /временно недоступен.*Повторите через 2 с/);
});

test("a read-only tool the server listed is retried", async () => {
  const waits = [];
  const { out, send } = bridgeFor(await personalEnv(), { sleep: async (ms) => waits.push(ms) });
  await send({ jsonrpc: "2.0", id: 52, method: "tools/list" });
  state.unavailable.set("law_article", 2);
  await send({ jsonrpc: "2.0", id: 53, method: "tools/call", params: { name: "law_article" } });
  assert.equal(out.at(-1).result.content[0].text, "ok");
  assert.deepEqual(waits, [2000, 2000]);
});

test("a refused connection is retried: nothing reached the server", async () => {
  let failures = 1;
  const flaky = (url, init) => {
    if (String(url).endsWith("/api/mcp") && failures-- > 0) {
      return Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
    }
    return fetch(url, init);
  };
  const waits = [];
  const { out, send } = bridgeFor(await personalEnv(), { fetch: flaky, sleep: async (ms) => waits.push(ms) });
  await send({ jsonrpc: "2.0", id: 54, method: "tools/call", params: { name: "ask_yriist" } });
  assert.equal(out[0].result.content[0].text, "ok");
  assert.deepEqual(waits, [1000]);
});

test("Retry-After and Bearer challenges are read", () => {
  assert.equal(retryAfterMs("3"), 3000);
  assert.equal(retryAfterMs(null), null);
  assert.equal(retryAfterMs(new Date(Date.now() + 5000).toUTCString(), Date.now()) > 3000, true);
  assert.deepEqual(
    bearerChallengeOf('Bearer error="insufficient_scope", scope="yriist:write", resource_metadata="x"'),
    { error: "insufficient_scope", scope: "yriist:write" },
  );
});

// ── Rights (403 insufficient_scope) ───────────────────────────────────────

test("a personal token without the right is told to get a wider one", async () => {
  const { out, send } = bridgeFor(await personalEnv());
  await send({ jsonrpc: "2.0", id: 60, method: "tools/call", params: { name: "scoped" } });
  assert.equal(out[0].error.code, -32003);
  assert.match(out[0].error.message, /yriist:read, yriist:write.*account\/connections/);
});

test("an OAuth sign-in without the right asks for it and retries", async () => {
  const env = await tempEnv();
  await login(`${base}/api/mcp`, { env, log: fakeBrowserLog([]), openBrowser: false, scope: ["read"] });
  assert.equal(state.lastScope, "yriist:read");
  const { out, send } = bridgeFor(env, { interactive: true, log: fakeBrowserLog([]), openBrowser: false });
  await send({ jsonrpc: "2.0", id: 61, method: "tools/call", params: { name: "scoped" } });
  assert.equal(state.lastScope, "yriist:read yriist:write");
  assert.equal(out.at(-1).result.content[0].text, "scoped ok");
  assert.ok(out.some((message) => message.method === "notifications/tools/list_changed"));
});

test("without a browser the missing right is named with the command to get it", async () => {
  const env = await tempEnv();
  await login(`${base}/api/mcp`, { env, log: fakeBrowserLog([]), openBrowser: false, scope: "read" });
  const { out, send } = bridgeFor(env);
  await send({ jsonrpc: "2.0", id: 62, method: "tools/call", params: { name: "scoped" } });
  assert.equal(out[0].error.code, -32003);
  assert.match(out[0].error.message, /login --scope read,write/);
});

// ── Signed out ────────────────────────────────────────────────────────────

test("signed out: initialize and tools/list are answered at once; the tools come after sign-in", async () => {
  const env = await tempEnv();
  let visitAuthorize = null;
  const log = (line) => {
    const match = /(http\S+\/oauth\/authorize\S+)/.exec(line);
    if (match) visitAuthorize = () => fetch(match[1]).catch(() => {});
  };
  const { bridge, out, send } = bridgeFor(env, { interactive: true, log, openBrowser: false });
  await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(out[0].result.protocolVersion, "2025-06-18");
  assert.equal(out[0].result.capabilities.tools.listChanged, true);
  await send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(out[1].result.tools.map((tool) => tool.name), ["yriist_login"]);
  // The person signs in in the browser.
  for (let i = 0; i < 50 && !visitAuthorize; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  await visitAuthorize();
  const call = send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "yriist_login" } });
  await call;
  assert.ok(out.some((message) => message.method === "notifications/tools/list_changed"));
  assert.match(out.find((message) => message.id === 3).result.content[0].text, /выполнен/);
  await send({ jsonrpc: "2.0", id: 4, method: "tools/list" });
  assert.ok(out.at(-1).result.tools.some((tool) => tool.name === "whoami"));
  await bridge.close();
});

// ── Tokens and the credentials file ───────────────────────────────────────

test("a token about to expire is renewed before it is sent", async () => {
  const env = await tempEnv();
  await staleCredentials(env, Date.now() + 30_000);
  const { out, send } = bridgeFor(env);
  const before = state.calls.length;
  await send({ jsonrpc: "2.0", id: 70, method: "ping" });
  assert.deepEqual(out[0], { jsonrpc: "2.0", id: 70, result: {} });
  const sent = state.calls.slice(before);
  assert.equal(sent.length, 1, "no request with the old token");
  assert.match(sent[0].auth, /^yrt_access/);
});

test("a refresh that lost the race finds the winner's tokens a moment later", async () => {
  const env = await tempEnv();
  const used = { clientId: "yc_1", redirectUri: "http://127.0.0.1:1/callback", accessToken: "yrt_old", refreshToken: "yrr_lostrace" };
  const winner = { ...used, accessToken: "yrt_winnerwinnerwinnerwin", refreshToken: "yrr_winner" };
  await saveCredentials(base, used, env);
  setTimeout(() => saveCredentials(base, winner, env), 150);
  const result = await refresh(`${base}/api/mcp`, used, { env });
  assert.equal(result.accessToken, winner.accessToken);
  assert.deepEqual(await loadCredentials(base, env), winner);
});

test("credentials of two servers saved at once both stay", async () => {
  const env = await tempEnv();
  await Promise.all(
    Array.from({ length: 8 }, (_, i) => saveCredentials(`https://s${i}.example`, { clientId: `c${i}` }, env)),
  );
  for (let i = 0; i < 8; i++) {
    assert.equal((await loadCredentials(`https://s${i}.example`, env))?.clientId, `c${i}`);
  }
  // A change that returns undefined leaves the entry as it is.
  await updateCredentials("https://s0.example", () => undefined, env);
  assert.equal((await loadCredentials("https://s0.example", env)).clientId, "c0");
});

test("a busy loopback port keeps the registration", async () => {
  const env = await tempEnv();
  const first = await login(`${base}/api/mcp`, { env, log: fakeBrowserLog([]), openBrowser: false });
  const port = Number(new URL(first.redirectUri).port);
  const squatter = createServer();
  await new Promise((resolve) => squatter.listen(port, "127.0.0.1", resolve));
  try {
    const registered = state.clients.size;
    const second = await login(`${base}/api/mcp`, { env, log: fakeBrowserLog([]), openBrowser: false });
    assert.equal(state.clients.size, registered, "no new registration");
    assert.equal(second.clientId, first.clientId);
    assert.notEqual(second.redirectUri, first.redirectUri);
  } finally {
    squatter.close();
  }
});

test("login asks only for the rights it is given", async () => {
  const env = await tempEnv();
  await login(`${base}/api/mcp`, { env, log: fakeBrowserLog([]), openBrowser: false, scope: "research, read" });
  assert.equal(state.lastScope, "yriist:research yriist:read");
  await login(`${base}/api/mcp`, { env, log: fakeBrowserLog([]), openBrowser: false });
  assert.equal(state.lastScope, "yriist:read", "default: every scope the server lists");
});

// ── Proxy ─────────────────────────────────────────────────────────────────

test("proxy plan: start again with the switch, or say Node is too old", () => {
  assert.equal(proxyPlan({ env: {}, version: "24.8.0", execArgv: [] }), "none");
  assert.equal(proxyPlan({ env: { HTTPS_PROXY: "http://p:8080" }, version: "24.8.0", execArgv: [] }), "reexec");
  assert.equal(proxyPlan({ env: { https_proxy: "http://p:8080" }, version: "22.21.0", execArgv: [] }), "reexec");
  assert.equal(proxyPlan({ env: { HTTPS_PROXY: "http://p:8080" }, version: "22.20.0", execArgv: [] }), "unsupported");
  assert.equal(proxyPlan({ env: { HTTPS_PROXY: "http://p:8080" }, version: "20.19.0", execArgv: [] }), "unsupported");
  assert.equal(proxyPlan({ env: { HTTPS_PROXY: "http://p", NODE_USE_ENV_PROXY: "1" }, version: "24.8.0", execArgv: [] }), "none");
  assert.equal(proxyPlan({ env: { HTTPS_PROXY: "http://p" }, version: "24.8.0", execArgv: ["--use-env-proxy"] }), "none");
  assert.equal(proxyPlan({ env: { HTTPS_PROXY: "http://p", NODE_USE_ENV_PROXY: "0" }, version: "24.8.0", execArgv: [] }), "none");
});

/** A forward proxy (absolute-form and CONNECT) that counts what it carried. */
async function startProxy() {
  const seen = [];
  const proxy = createServer((req, res) => {
    seen.push(req.url);
    const target = new URL(req.url);
    const upstream = connect(Number(target.port), target.hostname, () => {
      const head = [`${req.method} ${target.pathname}${target.search} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (!/^proxy-/i.test(req.rawHeaders[i])) head.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(`${head.join("\r\n")}\r\n\r\n`);
      req.pipe(upstream);
      upstream.pipe(res.socket);
    });
    upstream.on("error", () => res.destroy());
  });
  proxy.on("connect", (req, socket, head) => {
    seen.push(`CONNECT ${req.url}`);
    const [host, port] = req.url.split(":");
    const upstream = connect(Number(port), host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  return { seen, url: `http://127.0.0.1:${proxy.address().port}`, close: () => { proxy.closeAllConnections?.(); proxy.close(); } };
}

test("cli: HTTP(S)_PROXY is used where Node can", { skip: !nodeHasEnvProxy() }, async () => {
  const proxy = await startProxy();
  try {
    const env = { ...(await personalEnv()), HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, NO_PROXY: "", NODE_USE_ENV_PROXY: undefined };
    delete env.NODE_USE_ENV_PROXY;
    const input = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`;
    const { code, stdout } = await runCli(["--url", `${base}/api/mcp`], env, input);
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(stdout.trim()), { jsonrpc: "2.0", id: 1, result: {} });
    assert.ok(proxy.seen.some((line) => line.includes("/api/mcp") || line.startsWith("CONNECT")), `proxy saw: ${proxy.seen}`);
  } finally {
    proxy.close();
  }
});

// ── CLI ───────────────────────────────────────────────────────────────────

test("cli: status shows the bridge, the sign-in and the tools; --json too", async () => {
  const env = await personalEnv();
  const text = await runCli(["status", "--url", `${base}/api/mcp`], env);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /Мост: @yriist\/mcp \d/);
  assert.match(text.stdout, /Вход: личный токен/);
  assert.match(text.stdout, /Инструменты \(3\): whoami, law_article, ask_yriist/);
  const json = await runCli(["status", "--json", "--url", `${base}/api/mcp`], env);
  const report = JSON.parse(json.stdout);
  assert.equal(report.auth, "personal");
  assert.deepEqual(report.tools, ["whoami", "law_article", "ask_yriist"]);
});

test("cli: doctor checks the server and the sign-in", async () => {
  const { code, stdout } = await runCli(["doctor", "--json", "--url", `${base}/api/mcp`], await personalEnv());
  const report = JSON.parse(stdout);
  assert.equal(code, 0, stdout);
  assert.equal(report.ok, true);
  assert.ok(report.checks.some((check) => check.name === "OAuth" && check.ok));
  assert.ok(report.checks.some((check) => check.name === "Вход" && /личный токен/.test(check.detail)));
});

test("cli: a token file others can read is pointed out", { skip: process.platform === "win32" }, async () => {
  const env = await tempEnv();
  await mkdir(join(env.XDG_CONFIG_HOME, "yriist"), { recursive: true });
  const file = join(env.XDG_CONFIG_HOME, "yriist", "token");
  await writeFile(file, `${PERSONAL}\n`);
  await chmod(file, 0o644);
  const { code, stderr } = await runCli(["status", "--url", `${base}/api/mcp`], env);
  assert.equal(code, 0);
  assert.match(stderr, /chmod 600/);
});

test("cli: config for an unknown client and --url without a value fail", async () => {
  const unknown = await runCli(["config", "nope"], await tempEnv());
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Нет клиента «nope»/);
  const bare = await runCli(["status", "--url"], await tempEnv());
  assert.equal(bare.code, 1);
  assert.match(bare.stderr, /нет значения/);
  const windows = await runCli(["config", "stdio", "--windows"], await tempEnv());
  assert.match(windows.stdout, /"command": "cmd"/);
});

test("cli: SIGTERM while a request is in flight ends the process quietly", { skip: process.platform === "win32" }, async () => {
  const env = await personalEnv();
  const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/yriist-mcp.mjs", import.meta.url)), "--url", `${base}/api/mcp`], {
    env: { ...process.env, YRIIST_MCP_URL: "", ...env },
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 80, method: "tools/call", params: { name: "slow" } })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  child.kill("SIGTERM");
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0);
  assert.equal(stdout, "");
});
