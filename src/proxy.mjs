import { spawn } from "node:child_process";

/**
 * HTTP(S) proxies. Node's built-in `fetch` uses `HTTPS_PROXY` / `HTTP_PROXY`
 * / `NO_PROXY` only when `NODE_USE_ENV_PROXY=1` (or `--use-env-proxy`) is set
 * at start: Node ≥ 22.21 and ≥ 24.0. The package has no dependencies, so it
 * does not bring a proxy agent of its own: when a proxy is configured and
 * Node can use it, the CLI starts itself again with that switch on; on an
 * older Node it says what to do.
 */

const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];

/** Does this Node's `fetch` honour `NODE_USE_ENV_PROXY`? */
export function nodeHasEnvProxy(version = process.versions.node) {
  const [major, minor] = String(version).split(".").map(Number);
  return major >= 24 || (major === 22 && minor >= 21);
}

export function proxyFromEnv(env = process.env) {
  for (const name of PROXY_VARS) {
    if (env[name]) return { name, value: env[name] };
  }
  return null;
}

/**
 * What to do about a proxy: `none` (no proxy, or Node already uses it),
 * `reexec` (start again with `NODE_USE_ENV_PROXY=1`), `unsupported` (this
 * Node can't).
 */
export function proxyPlan({
  env = process.env,
  version = process.versions.node,
  execArgv = process.execArgv,
} = {}) {
  if (!proxyFromEnv(env)) return "none";
  if (env.NODE_USE_ENV_PROXY === "1" || execArgv.includes("--use-env-proxy")) return "none";
  // Set to anything else (0, empty): the person turned it off on purpose.
  if (env.NODE_USE_ENV_PROXY !== undefined) return "none";
  return nodeHasEnvProxy(version) ? "reexec" : "unsupported";
}

export const PROXY_UNSUPPORTED = (version = process.versions.node) =>
  `Задан прокси (HTTPS_PROXY / HTTP_PROXY), но Node.js ${version} не направляет через него fetch. Нужен Node.js ≥ 22.21 или ≥ 24: тогда мост сам включит NODE_USE_ENV_PROXY=1.`;

/**
 * Runs this CLI again with the proxy switch on, the same stdin/stdout, and
 * exits with the child's code. Resolves never (the process ends).
 */
export function reexecWithProxy() {
  const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, NODE_USE_ENV_PROXY: "1" },
    windowsHide: true,
  });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }
  return new Promise(() => {
    child.on("error", (error) => {
      process.stderr.write(`[yriist-mcp] ${error.message}\n`);
      process.exit(1);
    });
    child.on("exit", (code, signal) => {
      process.exit(code ?? (signal === "SIGINT" ? 130 : 1));
    });
  });
}
