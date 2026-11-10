import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Credentials on disk: `$XDG_CONFIG_HOME/yriist/credentials.json` (default
 * `~/.config/yriist/`), mode 0600, one entry per server origin:
 *   { "<origin>": { clientId, redirectUri, accessToken, refreshToken,
 *                   expiresAt, scope } }
 * A personal token comes from `YRIIST_TOKEN` or `~/.config/yriist/token`
 * (the same file the Claude Code plugin reads).
 */

export function configDir(env = process.env) {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "yriist");
}

export function credentialsPath(env = process.env) {
  return env.YRIIST_CREDENTIALS || join(configDir(env), "credentials.json");
}

const TOKEN_RE = /^yr[pt]_[A-Za-z0-9]{20,120}$/;

export function isToken(value) {
  return typeof value === "string" && TOKEN_RE.test(value.trim());
}

/** A personal token from the environment or the token file; null if none. */
export async function personalToken(env = process.env) {
  if (isToken(env.YRIIST_TOKEN)) return env.YRIIST_TOKEN.trim();
  try {
    const text = await readFile(join(configDir(env), "token"), "utf8");
    const line = text.split(/\r?\n/)[0]?.trim();
    return isToken(line) ? line : null;
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

export async function saveCredentials(origin, value, env = process.env) {
  const path = credentialsPath(env);
  const all = await readAll(env);
  if (value === null) delete all[origin];
  else all[origin] = value;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Write-then-rename: a crash never leaves half a file.
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => {});
}

export async function clearCredentials(origin, env = process.env) {
  if (origin) {
    await saveCredentials(origin, null, env);
    return;
  }
  await rm(credentialsPath(env), { force: true });
}
