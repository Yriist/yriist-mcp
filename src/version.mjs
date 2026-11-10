import { readFileSync } from "node:fs";

/** The package version, read once from package.json (the one place it is written). */
export const VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
