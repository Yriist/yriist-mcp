import { DEFAULT_URL } from "./bridge.mjs";

/**
 * Ready-to-paste configs for MCP clients (`yriist-mcp config <client>`).
 * `remote`: the client talks to the HTTP server itself and does OAuth;
 * `stdio`: the client runs this package, which does OAuth for it.
 */

const STDIO = { command: "npx", args: ["-y", "@yriist/mcp"] };
/** The Claude Code plugin's repository (it is its own marketplace). */
const PLUGIN_REPO = "Yriist/yriist-claude-plugin";

export function clientConfigs(url = DEFAULT_URL) {
  const custom = url !== DEFAULT_URL;
  const stdio = custom ? { ...STDIO, args: [...STDIO.args, "--url", url] } : STDIO;
  return {
    "claude-code": {
      title: "Claude Code",
      kind: "remote",
      text: `claude mcp add --transport http yriist ${url}\n# затем /mcp → yriist → Authenticate\n# или плагин с командами и панелью: claude plugin install yriist --marketplace ${PLUGIN_REPO}`,
    },
    "claude-desktop": {
      title: "Claude Desktop / claude.ai",
      kind: "remote",
      text: `Настройки → Коннекторы → Добавить свой коннектор\nURL: ${url}`,
    },
    cursor: {
      title: "Cursor (~/.cursor/mcp.json)",
      kind: "remote",
      text: JSON.stringify({ mcpServers: { yriist: { url } } }, null, 2),
    },
    vscode: {
      title: "VS Code (.vscode/mcp.json)",
      kind: "remote",
      text: JSON.stringify({ servers: { yriist: { type: "http", url } } }, null, 2),
    },
    windsurf: {
      title: "Windsurf (~/.codeium/windsurf/mcp_config.json)",
      kind: "remote",
      text: JSON.stringify({ mcpServers: { yriist: { serverUrl: url } } }, null, 2),
    },
    zed: {
      title: "Zed (settings.json)",
      kind: "stdio",
      text: JSON.stringify(
        { context_servers: { yriist: { command: stdio.command, args: stdio.args } } },
        null,
        2,
      ),
    },
    chatgpt: {
      title: "ChatGPT (Settings → Connectors → Create, developer mode)",
      kind: "remote",
      text: `MCP Server URL: ${url}\nAuthentication: OAuth`,
    },
    codex: {
      title: "OpenAI Codex CLI (~/.codex/config.toml)",
      kind: "stdio",
      text: `[mcp_servers.yriist]\ncommand = "${stdio.command}"\nargs = ${JSON.stringify(stdio.args)}`,
    },
    gemini: {
      title: "Gemini CLI (~/.gemini/settings.json)",
      kind: "remote",
      text: JSON.stringify({ mcpServers: { yriist: { httpUrl: url } } }, null, 2),
    },
    stdio: {
      title: "Любой клиент со stdio-серверами (Claude Desktop config, Continue, Cline, LM Studio…)",
      kind: "stdio",
      text: JSON.stringify({ mcpServers: { yriist: stdio } }, null, 2),
    },
    token: {
      title: "По личному токену (скрипты, n8n, клиенты без OAuth)",
      kind: "remote",
      text: `POST ${url}\nAuthorization: Bearer yrp_…   # токен: https://app.yriist.ru/account/connections\nContent-Type: application/json\n\nили stdio: YRIIST_TOKEN=yrp_… npx -y @yriist/mcp`,
    },
  };
}
