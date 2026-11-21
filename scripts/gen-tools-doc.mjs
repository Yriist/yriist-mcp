#!/usr/bin/env node
/**
 * docs/tools.md is generated from the server's own `tools/list`, so the
 * document can't drift from what clients are told. Two files:
 *
 * - docs/tools.json — the `tools/list` snapshot (committed);
 * - docs/tools.md — rendered from the snapshot.
 *
 *   node scripts/gen-tools-doc.mjs [--url http://localhost:3000/api/mcp]
 *       asks the server (saved sign-in or YRIIST_TOKEN, every scope) and
 *       writes both files;
 *   node scripts/gen-tools-doc.mjs --offline
 *       renders tools.md from the committed snapshot, no network;
 *   --check: writes nothing, exits 1 when a file is out of date (with
 *       --offline: tools.md against the snapshot — what CI runs on every
 *       push; without: both files against the live server — the scheduled
 *       job with a token).
 */
import { readFile, writeFile } from "node:fs/promises";
import { createBridge, DEFAULT_URL, PROTOCOL_VERSIONS } from "../src/bridge.mjs";

const SECTIONS = [
  ["yriist:agent", "ИИ-юрист"],
  ["yriist:read", "Ваши данные (чтение)"],
  ["yriist:write", "Действия"],
  ["yriist:research", "Исследование и расчёты"],
];

const args = process.argv.slice(2);
const urlFlag = args.indexOf("--url");
const url = urlFlag >= 0 ? args[urlFlag + 1] : process.env.YRIIST_MCP_URL || DEFAULT_URL;
const check = args.includes("--check");
const offline = args.includes("--offline");
const markdownFile = new URL("../docs/tools.md", import.meta.url);
const snapshotFile = new URL("../docs/tools.json", import.meta.url);

/** What a client is told, without what changes per call or per account. */
function snapshotOf(tools) {
  return tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
    _meta: tool._meta,
  }));
}

async function liveTools() {
  const bridge = createBridge({ url, interactive: false, log: () => {} });
  const call = async (id, method, params) => {
    const [reply] = await bridge.forward({ jsonrpc: "2.0", id, method, params });
    if (!reply || reply.error) throw new Error(reply?.error?.message ?? "сервер не ответил");
    return reply.result;
  };
  await call(1, "initialize", {
    protocolVersion: PROTOCOL_VERSIONS[0],
    capabilities: {},
    clientInfo: { name: "yriist-mcp-docs", version: "1" },
  });
  const tools = [];
  let cursor;
  for (let id = 2; ; id++) {
    const page = await call(id, "tools/list", cursor ? { cursor } : {});
    tools.push(...page.tools);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return snapshotOf(tools);
}

function parameters(tool) {
  const properties = Object.keys(tool.inputSchema?.properties ?? {});
  if (properties.length === 0) return "—";
  const required = new Set(tool.inputSchema?.required ?? []);
  return properties.map((name) => `\`${name}\`${required.has(name) ? "" : "?"}`).join(", ");
}

function render(tools) {
  const missing = SECTIONS.filter(([scope]) => !tools.some((tool) => tool._meta?.["yriist/scope"] === scope));
  if (missing.length > 0) {
    throw new Error(`У токена нет прав ${missing.map(([scope]) => scope).join(", ")}: документ вышел бы неполным.`);
  }
  const lines = [
    "# Инструменты ЮрИИст MCP",
    "",
    "Сгенерировано из `tools/list` сервера (`docs/tools.json`). Право — OAuth scope, без которого инструмента нет в списке.",
    "",
  ];
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
  return `${lines.join("\n").trimEnd()}\n`;
}

const read = (file) => readFile(file, "utf8").catch(() => null);

let tools;
if (offline) {
  const text = await read(snapshotFile);
  if (text === null) {
    console.error("Нет docs/tools.json: соберите его с сервера (`npm run docs:tools`).");
    process.exit(1);
  }
  tools = JSON.parse(text);
} else {
  tools = await liveTools();
}
const markdown = render(tools);
const snapshot = `${JSON.stringify(tools, null, 2)}\n`;

if (check) {
  const stale = [];
  if ((await read(markdownFile)) !== markdown) stale.push("docs/tools.md");
  if (!offline && (await read(snapshotFile)) !== snapshot) stale.push("docs/tools.json");
  if (stale.length > 0) {
    console.error(
      `${stale.join(" и ")} отстал${stale.length > 1 ? "и" : ""} от ${offline ? "снимка" : "сервера"}: запустите \`npm run docs:tools${offline ? " -- --offline" : ""}\`.`,
    );
    process.exit(1);
  }
  console.log(`docs/tools.md актуален (${tools.length} инструментов).`);
} else {
  if (!offline) await writeFile(snapshotFile, snapshot);
  await writeFile(markdownFile, markdown);
  console.log(`docs/tools.md${offline ? "" : " и docs/tools.json"}: ${tools.length} инструментов.`);
}
