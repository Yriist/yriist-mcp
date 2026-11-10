import { spawn } from "node:child_process";

/**
 * Opens a URL in the default browser; silent when there is none (SSH, CI,
 * a container). The URL is always printed to stderr as well, so a failed
 * launch never blocks the sign-in.
 */
export function openBrowser(url, env = process.env) {
  if (env.YRIIST_NO_BROWSER === "1") return;
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? // No shell in between, so `&` in the URL needs no escaping.
          ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No browser to launch: the printed URL is the way in.
  }
}
