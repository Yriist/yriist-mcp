import { DEFAULT_URL } from "./bridge.mjs";

/**
 * Ready-to-paste configs for MCP clients (`yriist-mcp config <client>`).
 * `remote`: the client talks to the HTTP server itself and does OAuth;
 * `stdio`: the client runs this package, which does OAuth for it.
 *
 * On native Windows a client that starts servers without a shell can't run
 * `npx` (it is `npx.cmd`): the stdio form there is `cmd /c npx …`
 * (`{ windows: true }`, the default on win32).
 */

/** The Claude Code plugin's repository (it is its own marketplace). */
const PLUGIN_REPO = "Yriist/yriist-claude-plugin";
/** `ask_yriist` may take up to 280 s; many clients cut a call at 60 s. */
const TOOL_TIMEOUT_S = 300;

export function stdioCommand(url = DEFAULT_URL, { windows = process.platform === "win32" } = {}) {
  const args = ["-y", "@yriist/mcp", ...(url !== DEFAULT_URL ? ["--url", url] : [])];
  return windows ? { command: "cmd", args: ["/c", "npx", ...args] } : { command: "npx", args };
}

const json = (value) => JSON.stringify(value, null, 2);

export function clientConfigs(url = DEFAULT_URL, options = {}) {
  const stdio = stdioCommand(url, options);
  const tomlArgs = JSON.stringify(stdio.args);
  return {
    "claude-code": {
      title: "Claude Code",
      kind: "remote",
      text: [
        `claude mcp add-json yriist '${JSON.stringify({ type: "http", url, timeout: TOOL_TIMEOUT_S * 1000 })}' --scope user`,
        "# затем /mcp → yriist → Authenticate",
        "# timeout: ask_yriist отвечает до нескольких минут, а Claude Code без него обрывает запрос через 60 с",
        `# или плагин с командами и панелью: claude plugin install yriist --marketplace ${PLUGIN_REPO}`,
      ].join("\n"),
    },
    "claude-desktop": {
      title: "Claude (приложение для компьютера и claude.ai)",
      kind: "remote",
      text: `Customize → Connectors → «+ Add» → Add custom connector\nURL: ${url}`,
    },
    cursor: {
      title: "Cursor (~/.cursor/mcp.json)",
      kind: "remote",
      text: json({ mcpServers: { yriist: { url } } }),
    },
    vscode: {
      title: "VS Code (.vscode/mcp.json)",
      kind: "remote",
      text: `${json({ servers: { yriist: { type: "http", url } } })}\n\n# новый формат Copilot (.mcp.json в корне проекта или ~/.copilot/mcp-config.json):\n${json({ mcpServers: { yriist: { type: "http", url, tools: ["*"], timeout: TOOL_TIMEOUT_S * 1000 } } })}`,
    },
    windsurf: {
      title: "Windsurf (~/.codeium/windsurf/mcp_config.json)",
      kind: "remote",
      text: json({ mcpServers: { yriist: { serverUrl: url } } }),
    },
    devin: {
      title: "Devin Desktop / Devin CLI (~/.config/devin/mcp_config.json; вход — devin mcp login yriist)",
      kind: "remote",
      text: json({ mcpServers: { yriist: { url, transport: "http" } } }),
    },
    zed: {
      title: "Zed (settings.json; вход — окно OAuth Zed)",
      kind: "remote",
      text: `${json({ context_servers: { yriist: { url } } })}\n\n# или через этот пакет (stdio):\n${json({ context_servers: { yriist: stdio } })}`,
    },
    chatgpt: {
      title: "ChatGPT (Plugins → «+» → Add custom MCP server; полный MCP — Business / Enterprise / Edu)",
      kind: "remote",
      text: `MCP Server URL: ${url}\nAuthentication: OAuth`,
    },
    codex: {
      title: "OpenAI Codex CLI (~/.codex/config.toml)",
      kind: "remote",
      text: [
        `codex mcp add yriist --url ${url}`,
        "codex mcp login yriist",
        "",
        "# или в ~/.codex/config.toml:",
        "[mcp_servers.yriist]",
        `url = "${url}"`,
        `tool_timeout_sec = ${TOOL_TIMEOUT_S}`,
        "",
        "# или через этот пакет (stdio):",
        "[mcp_servers.yriist]",
        `command = "${stdio.command}"`,
        `args = ${tomlArgs}`,
        `tool_timeout_sec = ${TOOL_TIMEOUT_S}`,
      ].join("\n"),
    },
    gemini: {
      title: "Gemini CLI (~/.gemini/settings.json; вход — /mcp auth yriist)",
      kind: "remote",
      text: json({ mcpServers: { yriist: { httpUrl: url } } }),
    },
    antigravity: {
      title: "Antigravity (~/.gemini/config/mcp_config.json)",
      kind: "remote",
      text: json({ mcpServers: { yriist: { serverUrl: url } } }),
    },
    copilot: {
      title: "GitHub Copilot CLI (~/.copilot/mcp-config.json; вход — /mcp auth yriist)",
      kind: "remote",
      text: json({ mcpServers: { yriist: { type: "http", url, tools: ["*"], timeout: TOOL_TIMEOUT_S * 1000 } } }),
    },
    cline: {
      title: "Cline (MCP Servers → Configure MCP Servers)",
      kind: "remote",
      text: json({ mcpServers: { yriist: { type: "streamableHttp", url } } }),
    },
    roo: {
      title: "Roo Code (.roo/mcp.json или Edit Global MCP)",
      kind: "remote",
      text: json({ mcpServers: { yriist: { type: "streamable-http", url, timeout: TOOL_TIMEOUT_S } } }),
    },
    continue: {
      title: "Continue (.continue/mcpServers/yriist.yaml)",
      kind: "remote",
      text: ["mcpServers:", "  - name: yriist", "    type: streamable-http", `    url: ${url}`].join("\n"),
    },
    kiro: {
      title: "Kiro (~/.kiro/settings/mcp.json; вход — окно OAuth Kiro)",
      kind: "remote",
      text: json({ mcpServers: { yriist: { url } } }),
    },
    junie: {
      title: "JetBrains Junie (~/.junie/mcp/mcp.json; вход — Authorize)",
      kind: "remote",
      text: json({ mcpServers: { yriist: { url, timeout: TOOL_TIMEOUT_S * 1000 } } }),
    },
    jetbrains: {
      title: "JetBrains AI Assistant (Settings → Tools → AI Assistant → Model Context Protocol)",
      kind: "remote",
      text: json({ mcpServers: { yriist: { url } } }),
    },
    "lm-studio": {
      title: "LM Studio ≥ 0.3.17 (Program → Install → Edit mcp.json)",
      kind: "remote",
      text: json({ mcpServers: { yriist: { url } } }),
    },
    goose: {
      title: "Goose (~/.config/goose/config.yaml)",
      kind: "remote",
      text: ["extensions:", "  yriist:", "    name: ЮрИИст", "    type: streamable_http", `    uri: ${url}`, "    enabled: true", `    timeout: ${TOOL_TIMEOUT_S}`].join("\n"),
    },
    opencode: {
      title: "opencode (opencode.json; вход — opencode mcp auth yriist)",
      kind: "remote",
      text: json({ mcp: { servers: { yriist: { type: "remote", url } } } }),
    },
    warp: {
      title: "Warp (Warp Drive → MCP Servers → Add)",
      kind: "remote",
      text: json({ mcpServers: { yriist: { url } } }),
    },
    n8n: {
      title: "n8n (узел MCP Client Tool)",
      kind: "remote",
      text: `MCP Endpoint URL: ${url}\nServer Transport: HTTP Streamable\nAuthentication: MCP OAuth2 (Dynamic Client Registration) или Bearer с личным токеном yrp_…`,
    },
    stdio: {
      title: "Любой клиент со stdio-серверами в JSON (claude_desktop_config.json, Cline, LM Studio, Kiro…)",
      kind: "stdio",
      text: json({ mcpServers: { yriist: stdio } }),
    },
    token: {
      title: "По личному токену (скрипты, n8n, клиенты без OAuth)",
      kind: "remote",
      text: `POST ${url}\nAuthorization: Bearer yrp_…   # токен: https://app.yriist.ru/account/connections\nContent-Type: application/json\n\nили stdio: YRIIST_TOKEN=yrp_… npx -y @yriist/mcp`,
    },
  };
}
