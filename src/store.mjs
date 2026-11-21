import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Credentials on disk: `$XDG_CONFIG_HOME/yriist/credentials.json` (default
 * `~/.config/yriist/`, or the file `YRIIST_CREDENTIALS` names), mode 0600,
 * one entry per server origin:
 *   { "<origin>": { clientId, redirectUri, accessToken, refreshToken,
 *                   expiresAt, scope } }
 * A personal token comes from `YRIIST_TOKEN` or `~/.config/yriist/token`
 * (the same file the Claude Code plugin reads).
 *
 * Several clients may run the bridge on one file at once, so every change is
 * a read-modify-write under a lock file (`credentials.json.lock`).
 */

export function configDir(env = process.env) {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "yriist");
}

export function credentialsPath(env = process.env) {
  return env.YRIIST_CREDENTIALS || join(configDir(env), "credentials.json");
}

export function tokenFilePath(env = process.env) {
  return join(configDir(env), "token");
}

const TOKEN_RE = /^yr[pt]_[A-Za-z0-9]{20,120}$/;

export function isToken(value) {
  return typeof value === "string" && TOKEN_RE.test(value.trim());
}

let warnedMode = false;

/** A personal token from the environment or the token file; null if none. */
export async function personalToken(env = process.env) {
  if (isToken(env.YRIIST_TOKEN)) return env.YRIIST_TOKEN.trim();
  const path = tokenFilePath(env);
  try {
    const text = await readFile(path, "utf8");
    const line = text.split(/\r?\n/)[0]?.trim();
    if (!isToken(line)) return null;
    // Windows has no owner-only mode bits to check.
    if (!warnedMode && process.platform !== "win32") {
      const mode = (await stat(path)).mode & 0o777;
      if (mode & 0o077) {
        warnedMode = true;
        process.stderr.write(
          `[yriist-mcp] Файл токена ${path} доступен другим пользователям (права ${mode.toString(8)}): выполните chmod 600 "${path}".\n`,
        );
      }
    }
    return line;
  } catch {
    return null;
  }
}

async function readAll(env) {
  try {
    const parsed = JSON.parse(await readFile(credentialsPath(env), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function loadCredentials(origin, env = process.env) {
  const all = await readAll(env);
  return all[origin] ?? null;
}

const LOCK_WAIT_MS = 5_000;
/** A lock older than this was left by a process that died holding it. */
const LOCK_STALE_MS = 15_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withLock(path, fn) {
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const started = Date.now();
  let handle = null;
  while (!handle) {
    try {
      handle = await open(lock, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const age = await stat(lock)
        .then((info) => Date.now() - info.mtimeMs)
        .catch(() => 0);
      if (age > LOCK_STALE_MS) {
        await rm(lock, { force: true });
        continue;
      }
      if (Date.now() - started > LOCK_WAIT_MS) {
        throw new Error(`файл входа занят другим процессом (${lock})`);
      }
      await sleep(20 + Math.floor(Math.random() * 30));
    }
  }
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await rm(lock, { force: true }).catch(() => {});
  }
}

/**
 * Changes one origin's entry under the lock: `change(current)` returns the
 * new entry, `null` to delete it, or `undefined` to leave the file as it is.
 * Resolves the entry now on disk.
 */
export async function updateCredentials(origin, change, env = process.env) {
  const path = credentialsPath(env);
  return withLock(path, async () => {
    const all = await readAll(env);
    const next = change(all[origin] ?? null);
    if (next === undefined) return all[origin] ?? null;
    if (next === null) delete all[origin];
    else all[origin] = next;
    // Write-then-rename: a crash never leaves half a file.
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
    await chmod(path, 0o600).catch(() => {});
    return next;
  });
}

export async function saveCredentials(origin, value, env = process.env) {
  await updateCredentials(origin, () => value, env);
}

export async function clearCredentials(origin, env = process.env) {
  if (origin) {
    await saveCredentials(origin, null, env);
    return;
  }
  await rm(credentialsPath(env), { force: true });
}
