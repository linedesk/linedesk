// Where each AI client adds an MCP server, and its one-click install links: one place for these addresses, used by the
// agent setup page (startPlan, agent-setup.ts) and Integrations › MCP (apps/web/src/integrations). Each one is from the
// client's own documentation (checked 2026-11-19); a client without a documented link gets its settings page instead.

/**
 * Claude (web and desktop app): its connector settings, where Add › Add custom connector takes a server address.
 * Claude cannot add a connector by itself; claudeConnectorLink opens that dialog filled in.
 */
export const CLAUDE_CONNECTORS_URL = 'https://claude.ai/customize/connectors'

/**
 * Claude's install link for a custom connector: opens Add custom connector with the name (and the address, when given)
 * filled in; the person clicks Add, then Connect (claude.com/docs/connectors/building/directory-vs-custom, "Custom
 * connector install link", checked 2026-11-19). `admin`: Claude Team or Enterprise, where only an owner adds a
 * connector for the organization (admin-settings/connectors). The setup server's address carries its short-lived key:
 * it reaches Claude either way, the link adds only the person's own browser history.
 */
export const claudeConnectorLink = (name: string, url?: string, admin = false) =>
  `https://claude.ai/${admin ? 'admin-settings' : 'customize'}/connectors?modal=add-custom-connector&connectorName=${encodeURIComponent(
    name,
  )}${url ? `&connectorUrl=${encodeURIComponent(url)}` : ''}`

/**
 * ChatGPT (web): its plugins page, where Add › Add custom MCP server takes a server address. ChatGPT cannot add one by
 * itself, and has no link that fills in the address (developers.openai.com/api/docs/guides/developer-mode).
 */
export const CHATGPT_PLUGINS_URL = 'https://chatgpt.com/plugins'

/**
 * Cursor's one-click install link: the server's config as base64 JSON, the `url` of a remote server
 * (cursor.com/docs/plugins/mcp/install-links). Only for an address without a key in it: Cursor saves it in mcp.json.
 */
export const cursorMcpInstallLink = (name: string, url: string) =>
  `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${encodeURIComponent(
    btoa(JSON.stringify({ url })),
  )}`

/**
 * VS Code's one-click install link (`vscode:mcp/install?<JSON>`, Insiders: `vscode-insiders:`), which opens the
 * server's details to review before it is added (code.visualstudio.com/api/extension-guides/ai/mcp, "Install URL").
 * Only for an address without a key in it: VS Code saves it in its settings.
 */
export const vscodeMcpInstallLink = (name: string, url: string, insiders = false) =>
  `${insiders ? 'vscode-insiders' : 'vscode'}:mcp/install?${encodeURIComponent(JSON.stringify({ name, type: 'http', url }))}`

/** Whether a link opens a web page (a new tab) rather than an app on this computer (cursor://, vscode:, claude://). */
export const opensWebPage = (href: string) => /^https?:\/\//.test(href)
