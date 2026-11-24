// Settings › Integrations › MCP: how to connect each agent to this install's MCP server for everyday use, as a StartPlan,
// so the page shows it with the same picker and steps as the agent setup page (AgentSteps). The sign-in is OAuth: the
// agent opens the sign-in page here on its first use, there is no key to copy.
import { type AgentClient, CHATGPT_PLUGINS_URL, type StartPlan, type StartStep, type Words } from '@linedesk/actions'
import {
  claudeCodeCommand,
  claudeInstallLink,
  codexCommand,
  cursorInstallLink,
  geminiCommand,
  mcpAddress,
  vscodeInstallLink,
} from './catalog.ts'

/** No prompt here: the agent is only connected, the person then asks it what they want. */
const plan = (rest: Omit<StartPlan, 'prompt' | 'promptFirst'>): StartPlan => ({
  ...rest,
  prompt: '',
  promptFirst: false,
})

export function connectPlan(client: AgentClient, origin: string, brand: string, t: Words['t']): StartPlan {
  const address = mcpAddress(origin)
  const byAddress: StartStep = { text: t('settings.integrations.mcp.addAddress'), code: address }
  const run = (code: string): StartPlan =>
    plan({ open: null, steps: [{ text: t('settings.integrations.mcp.runCommand'), code }] })
  switch (client) {
    case 'claude_code':
      return run(claudeCodeCommand(origin))
    case 'codex':
      return run(codexCommand(origin))
    case 'gemini':
      return run(geminiCommand(origin))
    case 'cursor':
      return plan({
        open: {
          label: t('settings.integrations.mcp.cursor'),
          href: cursorInstallLink(origin),
          title: t('settings.integrations.mcp.cursorTip', { brand }),
          text: t('settings.integrations.mcp.cursorText'),
        },
        otherWay: t('settings.integrations.mcp.byHand'),
        steps: [byAddress],
      })
    case 'copilot':
      return plan({
        open: {
          label: t('settings.integrations.mcp.vscode'),
          href: vscodeInstallLink(origin),
          title: t('settings.integrations.mcp.vscodeTip', { brand }),
          text: t('settings.integrations.mcp.vscodeText'),
        },
        otherWay: t('settings.integrations.mcp.insidersOrByHand'),
        steps: [
          {
            text: t('settings.integrations.mcp.insidersStep'),
            link: {
              label: t('settings.integrations.mcp.vscodeInsiders'),
              href: vscodeInstallLink(origin, true),
              title: t('settings.integrations.mcp.vscodeTip', { brand }),
            },
          },
          byAddress,
        ],
      })
    case 'claude':
      return plan({
        open: {
          label: t('settings.integrations.mcp.openClaude'),
          href: claudeInstallLink(origin, brand),
          title: t('settings.integrations.mcp.openClaudeTip'),
          text: t('settings.integrations.mcp.claudeSteps'),
        },
        otherWay: t('settings.integrations.mcp.claudeTeamWay'),
        steps: [
          {
            text: t('settings.integrations.mcp.claudeTeamStep'),
            link: {
              label: t('settings.integrations.mcp.openClaudeAdmin'),
              href: claudeInstallLink(origin, brand, true),
              title: t('settings.integrations.mcp.openClaudeAdminTip'),
            },
          },
        ],
      })
    case 'chatgpt':
      // ChatGPT's Add custom MCP server form drawn filled in, OAuth picked (labels from
      // developers.openai.com/api/docs/guides/custom-mcp-server, checked 2026-11-20).
      return plan({
        open: null,
        numbered: true,
        steps: [
          {
            text: t('settings.integrations.mcp.chatgptStep1'),
            link: {
              label: t('settings.integrations.mcp.openChatgpt'),
              href: CHATGPT_PLUGINS_URL,
              title: t('settings.integrations.mcp.openChatgptTip'),
            },
          },
          {
            text: t('settings.integrations.mcp.chatgptFill'),
            form: {
              title: t('settings.integrations.mcp.chatgptForm.title'),
              fields: [
                { label: t('settings.integrations.mcp.chatgptForm.name'), value: brand, copy: true },
                { label: t('settings.integrations.mcp.chatgptForm.url'), value: address, copy: true },
                {
                  label: t('settings.integrations.mcp.chatgptForm.auth'),
                  value: t('settings.integrations.mcp.chatgptForm.oauth'),
                },
              ],
              check: t('settings.integrations.mcp.chatgptForm.check'),
              submit: t('settings.integrations.mcp.chatgptForm.submit'),
            },
          },
          { text: t('settings.integrations.mcp.chatgptStep3') },
        ],
      })
    case 'other':
      return plan({ open: null, steps: [{ text: t('settings.integrations.mcp.otherStep'), code: address }] })
  }
}
