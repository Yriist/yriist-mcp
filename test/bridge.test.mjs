import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { login, refresh, resourceMetadataUrlOf, revoke } from "../src/auth.mjs";
import { createBridge } from "../src/bridge.mjs";
import { clientConfigs } from "../src/clients.mjs";
import { loadCredentials, saveCredentials } from "../src/store.mjs";

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
};

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
      assert.ok(state.clients.get(p.get("client_id"))?.includes(p.get("redirect_uri")));
      const code = `code_${state.codes.size + 1}`;
      state.codes.set(code, { challenge: p.get("code_challenge"), client: p.get("client_id") });
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
      return json(200, { access_token: access, refresh_token: refreshToken, expires_in: 3600, token_type: "Bearer" });
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
      const message = JSON.parse(await readBody(req));
      state.calls.push({ method: message.method, auth, protocol: req.headers["mcp-protocol-version"] });
      if (message.id === undefined) {
        res.writeHead(202);
        return res.end();
      }
      if (message.method === "initialize") {
        return json(200, {
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: "2025-06-18", serverInfo: { name: "yriist" }, capabilities: {} },
        });
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

test("client configs: every JSON one parses and names the server", () => {
  const custom = "http://localhost:3000/api/mcp";
  for (const [name, config] of Object.entries(clientConfigs(custom))) {
    assert.ok(config.title && config.text, name);
    assert.ok(config.text.includes(custom), `${name} carries the custom url`);
    if (config.text.trimStart().startsWith("{")) JSON.parse(config.text);
  }
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

test("cli: status without a sign-in says how to sign in", async () => {
  const { code, stdout } = await runCli(["status", "--url", `${base}/api/mcp`], await tempEnv());
  assert.equal(code, 1);
  assert.match(stdout, /login/);
});
