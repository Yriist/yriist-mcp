#!/usr/bin/env node
/**
 * Writes docs/tools.md from the server's own `tools/list`, so the document
 * can't drift from what clients are told. Uses the saved sign-in (or
 * YRIIST_TOKEN) with every scope:
 *
 *   node scripts/gen-tools-doc.mjs [--url http://localhost:3000/api/mcp] [--check]
 *
 * `--check` writes nothing and exits 1 when the file is out of date.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createBridge, DEFAULT_URL } from "../src/bridge.mjs";

const SECTIONS = [
  ["yriist:agent", "ИИ-юрист"],
  ["yriist:read", "Ваши данные (чтение)"],
  ["yriist:write", "Действия"],
  ["yriist:research", "Исследование и расчёты"],
];

const args = process.argv.slice(2);
const urlFlag = args.indexOf("--url");
const url = urlFlag >= 0 ? args[urlFlag + 1] : (process.env.YRIIST_MCP_URL || DEFAULT_URL);
const check = args.includes("--check");
const target = new URL("../docs/tools.md", import.meta.url);

const bridge = createBridge({ url, interactive: false, log: () => {} });
const call = async (id, method, params) => {
  const [reply] = await bridge.forward({ jsonrpc: "2.0", id, method, params });
  if (!reply || reply.error) throw new Error(reply?.error?.message ?? "сервер не ответил");
  return reply.result;
};

await call(1, "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "yriist-mcp-docs", version: "1" },
});
const { tools } = await call(2, "tools/list", {});

function parameters(tool) {
  const properties = Object.keys(tool.inputSchema?.properties ?? {});
  if (properties.length === 0) return "—";
  const required = new Set(tool.inputSchema?.required ?? []);
  return properties.map((name) => `\`${name}\`${required.has(name) ? "" : "?"}`).join(", ");
}

const lines = [
  "# Инструменты ЮрИИст MCP",
  "",
  "Сгенерировано из `tools/list` сервера. Право — OAuth scope, без которого инструмента нет в списке.",
  "",
];
const missing = SECTIONS.filter(([scope]) => !tools.some((tool) => tool._meta?.["yriist/scope"] === scope));
if (missing.length > 0) {
  throw new Error(`У токена нет прав ${missing.map(([scope]) => scope).join(", ")}: документ вышел бы неполным.`);
}
for (const [scope, title] of SECTIONS) {
  lines.push(`## ${title} (\`${scope}\`)`, "");
  for (const tool of tools.filter((item) => item._meta?.["yriist/scope"] === scope)) {
    const facts = [`Параметры: ${parameters(tool)}`];
    const card = tool._meta?.ui?.resourceUri;
    if (card) facts.push(`карточка: \`${card}\``);
    if (tool.annotations?.readOnlyHint) facts.push("только чтение");
    lines.push(`### \`${tool.name}\` — ${tool.title ?? tool.name}`, "", tool.description, "", facts.join(" · "), "");
  }
}
const text = `${lines.join("\n").trimEnd()}\n`;

if (check) {
  const current = await readFile(target, "utf8").catch(() => "");
  if (current !== text) {
    console.error("docs/tools.md отстал от сервера: запустите `npm run docs:tools`.");
    process.exit(1);
  }
  console.log(`docs/tools.md актуален (${tools.length} инструментов).`);
} else {
  await writeFile(target, text);
  console.log(`docs/tools.md: ${tools.length} инструментов.`);
}
