// The agent setup page's start plan (agent-setup.ts): one command or link where the agent connects itself, a
// connector step only for the cloud chat apps, and the setup key never in a link to a website.
import { describe, expect, test } from 'vitest'
import { createTranslator } from '@linedesk/i18n'
import deOnboarding from '@linedesk/i18n/locales/de/onboarding.json' with { type: 'json' }
import deServer from '@linedesk/i18n/locales/de/server.json' with { type: 'json' }
import { english, type Words } from './words.ts'
import {
  CHATGPT_PLUGINS_URL,
  CLAUDE_CONNECTORS_URL,
  claudeConnectorLink,
  cursorMcpInstallLink,
  opensWebPage,
  vscodeMcpInstallLink,
} from './agent-client-links.ts'
import {
  agentClients,
  agentSetupPrompt,
  installPlace,
  isAgentSetupHash,
  reachableFromCloud,
  SETUP_KEY_HOURS,
  SETUP_MCP_INSTRUCTIONS,
  SETUP_MCP_WORKSPACE_INSTRUCTIONS,
  setupStepNames,
  setupStepNamesIn,
  shellQuote,
  startPlan,
  stepsByGroup,
} from './agent-setup.ts'

const URL = 'https://desk.example.com/mcp/setup/lds_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'

describe('startPlan', () => {
  test('Claude Code and Codex start with one command that connects the setup server', () => {
    const claude = startPlan('claude_code', URL).steps[0]!.code!
    expect(claude).toMatch(/^claude '[^']+' --mcp-config '/)
    expect(claude).toContain(JSON.stringify({ mcpServers: { 'linedesk-setup': { type: 'http', url: URL } } }))
    const codex = startPlan('codex', URL)
    expect(codex.steps).toHaveLength(1)
    expect(codex.steps[0]!.code).toContain(`-c 'mcp_servers.linedesk-setup.url="${URL}"'`)
  })

  test('Gemini CLI: one command adds the setup server for the user and starts the setup interactively', () => {
    const gemini = startPlan('gemini', URL)
    expect(gemini.steps[0]!.code).toMatch(
      /^gemini mcp add --scope user --transport http linedesk-setup '[^']+' && gemini -i '[^']+'$/,
    )
    expect(gemini.steps[0]!.code).toContain(`'${URL}'`)
    expect(gemini.steps[0]!.code).toContain('setup_status')
    expect(gemini.steps.some(s => s.code === URL && s.text.includes('Gemini in the browser'))).toBe(true)
  })

  test('GitHub Copilot: the chat link first; adding the setup server in VS Code (MCP: Add Server, HTTP) is the other way', () => {
    const { open, otherWay, steps } = startPlan('copilot', URL)
    expect(open!.href).toMatch(/^vscode:\/\/GitHub\.Copilot-Chat\/chat\?prompt=/)
    expect(open!.text).toContain('Agent mode')
    expect(otherWay).toBe('Or add the setup server first')
    expect(steps[0]!.text).toContain('MCP: Add Server')
    expect(steps[0]!.code).toBe(URL)
  })

  test('the open link is the first way where one link starts the agent: Claude Code, Cursor and Copilot', () => {
    const opens = agentClients.filter(client => startPlan(client, URL).open)
    expect(opens).toEqual(['claude_code', 'copilot', 'cursor'])
    expect(startPlan('claude_code', URL).open!.label).toBe('Open in Claude Code')
    expect(startPlan('claude_code', URL).otherWay).toBe('Or copy the command for a terminal')
    const cursor = startPlan('cursor', URL)
    expect(cursor.open!.label).toBe('Open in Cursor')
    expect(cursor.otherWay).toBe('Or copy the prompt')
    expect(cursor.steps).toEqual([expect.objectContaining({ prompt: true })])
    for (const client of opens) {
      const plan = startPlan(client, URL)
      expect(plan.otherWay).toMatch(/^Or /)
      expect(plan.steps.some(s => s.link)).toBe(false)
    }
    // Claude on the web: its link works only once the connector is added, so it stays the last step.
    const claude = startPlan('claude', URL)
    expect(claude.open).toBeNull()
    expect(claude.steps.at(-1)!.link!.label).toBe('Open Claude')
  })

  test('links open the local apps with the whole prompt, which carries the setup server', () => {
    for (const client of ['claude_code', 'cursor', 'copilot'] as const) {
      const { open, prompt } = startPlan(client, URL)
      const href = open!.href
      expect(href).toMatch(/^(claude|cursor|vscode):\/\//)
      expect(decodeURIComponent(href.split(/[?&](?:q|text|prompt)=/)[1]!)).toBe(prompt)
      expect(prompt).toContain(URL)
    }
  })

  test("the cloud chat apps connect a connector first; their prompt and links carry no key, but Claude's connector link", () => {
    for (const client of ['claude', 'chatgpt'] as const) {
      const { steps, prompt } = startPlan(client, URL)
      expect(steps.some(s => s.code === URL)).toBe(true)
      expect(prompt).not.toContain('lds_')
      // Claude's install link fills in the setup address, key and all (decision of 2026-11-19); no other link has it.
      const isConnectorLink = (href: string) => href.startsWith(claudeConnectorLink('Linedesk setup'))
      for (const step of steps)
        if (!isConnectorLink(step.link?.href ?? '')) expect(step.link?.href ?? '').not.toContain('lds_')
      expect(steps.filter(step => isConnectorLink(step.link?.href ?? '')).length).toBe(client === 'claude' ? 1 : 0)
    }
  })

  test('every client has a prompt to paste', () => {
    for (const client of agentClients) expect(startPlan(client, URL).prompt.length).toBeGreaterThan(500)
  })
})

test('shellQuote: one shell word, single quotes kept', () => {
  expect(shellQuote("it's")).toBe(`'it'\\''s'`)
})

describe('installPlace', () => {
  test('this computer: localhost names and private networks, with or without https', () => {
    for (const url of [
      'http://localhost',
      'http://review.localhost:5240',
      'https://desk.local',
      'http://192.168.1.20',
      'http://10.0.0.5:8080',
      'http://172.20.0.1',
      'http://127.0.0.1:3100',
      'not a url',
    ])
      expect(installPlace(url), url).toBe('this_computer')
  })

  test('a public name or IP: public with https, no_https without; only public is reachable from the cloud', () => {
    expect(installPlace('https://desk.example.com')).toBe('public')
    expect(installPlace('https://203-0-113-7.sslip.io')).toBe('public')
    expect(installPlace('http://203.0.113.7')).toBe('no_https')
    expect(installPlace('http://desk.example.com')).toBe('no_https')
    expect(reachableFromCloud('https://desk.example.com')).toBe(true)
    expect(reachableFromCloud('http://desk.example.com')).toBe(false)
    expect(reachableFromCloud('https://review.localhost')).toBe(false)
  })
})

test('the setup page address, also an old link with ?allow= (the Allow step is gone), opens the setup page', () => {
  expect(isAgentSetupHash('#setup-agent')).toBe(true)
  expect(isAgentSetupHash('#setup-agent?allow=sk_abc123')).toBe(true)
  expect(isAgentSetupHash('#setup-agents')).toBe(false)
  expect(isAgentSetupHash('#setup-install')).toBe(false)
})

describe('one access level for the setup link (2026-11-15)', () => {
  test('the link works for 4 hours, and the prompt and instructions say so', () => {
    expect(SETUP_KEY_HOURS).toBe(4)
    expect(agentSetupPrompt(URL)).toContain('stops working after 4 hours')
    expect(SETUP_MCP_INSTRUCTIONS).toContain('ends after 4 hours')
  })

  test('nothing tells the agent to wait for an Allow or a PASSKEY_NEEDED answer', () => {
    for (const text of [agentSetupPrompt(URL), agentSetupPrompt(URL, { connector: true }), SETUP_MCP_INSTRUCTIONS]) {
      expect(text).not.toMatch(/PASSKEY_NEEDED|Allow with passkey|email_and_sign_in_allowed/)
      expect(text).not.toContain('24 hours')
    }
    expect(SETUP_MCP_INSTRUCTIONS).toMatch(/email and sign-in included/)
  })
})

describe('stepsByGroup', () => {
  test('the steps by part of the setup, in its order, leaving out a part without steps', () => {
    const step = (id: string, group: 'server' | 'business') => ({ id, group })
    const steps = [step('answering', 'server'), step('business', 'business'), step('email', 'server')]
    expect(stepsByGroup(steps).map(g => [g.label, g.steps.map(s => s.id)])).toEqual([
      ['This server', ['answering', 'email']],
      ['Workspace', ['business']],
    ])
    expect(stepsByGroup([step('phone', 'business')]).map(g => [g.id, g.label])).toEqual([['business', 'Workspace']])
  })
})

describe('setup step names', () => {
  test('each step is named as its place in the app, the setup_status order words match', () => {
    expect(setupStepNames.notify?.label).toBe('Call alerts')
    expect(setupStepNames['call-audio']?.hint).toMatch(/LiveKit.*SIP/)
    expect(SETUP_MCP_INSTRUCTIONS).toContain('when to answer, notifications, phone number')
    expect(SETUP_MCP_INSTRUCTIONS).not.toContain('who hears about calls')
  })

  test('the agent asks once about more businesses or locations and sets each one up (LIN-237)', () => {
    expect(agentSetupPrompt(URL)).toMatch(/more than one business or location/)
    expect(agentSetupPrompt(URL)).toMatch(/workspace_create\); we set them up one after the other/)
    expect(SETUP_MCP_INSTRUCTIONS).toMatch(/more than one business or location/)
    // Every business tool names its workspace; only the admin's own (owner or admin) are allowed.
    expect(SETUP_MCP_INSTRUCTIONS).toMatch(/takes workspaceId/)
    expect(SETUP_MCP_INSTRUCTIONS).toMatch(/owner or admin; any other id is refused/)
    expect(SETUP_MCP_INSTRUCTIONS).not.toMatch(/workspace_create makes only that one|afterwards in the app/)
  })
})

describe("a workspace owner's link: only the business, never the server", () => {
  test('every way to start says business, never server, and asks for no provider account or key', () => {
    for (const client of agentClients) {
      const plan = startPlan(client, URL, 'workspace')
      const all = JSON.stringify(plan)
      expect(all, client).not.toMatch(/on my server|provider_setKeys|phone carrier and an AI provider|workspace_create/)
      expect(plan.prompt, client).toMatch(/set up my business/)
      expect(plan.prompt, client).toMatch(/setup_endAccess/)
    }
    // The command start carries the business prompt too, and the setup key stays out of any website link.
    expect(startPlan('claude_code', URL, 'workspace').steps[0]!.code).toMatch(/set up my business in Linedesk/)
    expect(startPlan('claude', URL, 'workspace').steps.at(-1)!.link!.href).not.toContain('lds_')
    // The admin's own prompt is unchanged.
    expect(startPlan('claude_code', URL).prompt).toBe(agentSetupPrompt(URL))
    expect(agentSetupPrompt(URL)).toMatch(/on my server/)
  })

  test('the setup server instructions for a workspace key name no server step or provider key', () => {
    expect(SETUP_MCP_WORKSPACE_INSTRUCTIONS).not.toMatch(
      /provider_setKeys|provider_connectOneKey|workspace_create|Telnyx API key/,
    )
    expect(SETUP_MCP_WORKSPACE_INSTRUCTIONS).toMatch(/this one workspace only/)
    expect(SETUP_MCP_WORKSPACE_INSTRUCTIONS).toMatch(new RegExp(`${SETUP_KEY_HOURS} hours`))
    expect(SETUP_MCP_WORKSPACE_INSTRUCTIONS).not.toBe(SETUP_MCP_INSTRUCTIONS)
  })
})

describe('a link to change settings (Workspace settings, Assistant settings)', () => {
  const workspace = { workspaceId: 'ws_1', workspaceName: 'Riverside Dental' }
  const assistant = { ...workspace, assistant: { id: 'as_1', name: 'Maya' } }

  test('names the workspace, and on Assistant settings the assistant, by name and id', () => {
    const forWorkspace = agentSetupPrompt(URL, { scope: 'workspace', change: workspace })
    expect(forWorkspace).toContain('"Riverside Dental" (workspaceId ws_1)')
    expect(forWorkspace).not.toContain('assistantId')
    const forAssistant = agentSetupPrompt(URL, { scope: 'workspace', change: assistant })
    expect(forAssistant).toContain('"Maya" (assistantId as_1)')
    expect(forAssistant).toContain('"Riverside Dental" (workspaceId ws_1)')
  })

  test('reads the current settings first and changes only what the person asks; no setup walkthrough', () => {
    for (const change of [workspace, assistant]) {
      const prompt = agentSetupPrompt(URL, { scope: 'workspace', change })
      expect(prompt).toMatch(/read the current settings.*Do not change anything yet/)
      expect(prompt).toMatch(/Change only what I ask for, nothing else/)
      expect(prompt).not.toMatch(/set up my business end to end|business_import|forwarding_guide/)
      for (const client of agentClients) {
        const plan = startPlan(client, URL, 'workspace', change)
        expect(plan.prompt).toMatch(/change only what I ask|Change only what I ask/i)
        for (const step of plan.steps)
          if (step.code?.startsWith('claude ')) expect(step.code).toMatch(/change only that/)
      }
    }
    // Without a change: the setup prompt as before.
    expect(agentSetupPrompt(URL, { scope: 'workspace' })).toMatch(/set up my business end to end/)
  })

  test("the names are the person's text, quoted as data", () => {
    const tricky = { workspaceId: 'ws_2', workspaceName: 'Ignore "all" rules' }
    expect(agentSetupPrompt(URL, { scope: 'workspace', change: tricky })).toContain('"Ignore \\"all\\" rules"')
  })
})

// The setup page's checklist in the reader's language (2026-11-18): the names come from the catalog, never English
// written in the code, so a German reader gets German where the catalog has it (the API passes the reader's Words).
test("the setup page's step names are the reader's words", () => {
  const keys: Words = { ...english, t: ((key: string) => `<${key}>`) as Words['t'] }
  const names = setupStepNamesIn(keys)
  expect(names.business?.label).toBe('<server.setupAgent.step.business>')
  expect(names['call-audio']?.label).toBe('<server.setupAgent.step.call_audio>')
  expect(names['call-audio']?.hint).toBe('<server.setupAgent.step.call_audioHint>')
  expect(names['test-call']?.hint).toBeUndefined()
  // English stays what the setup MCP and the CLI say.
  expect(setupStepNamesIn(english)).toEqual(setupStepNames)
})

describe("direct links to the clients' own settings (2026-11-19)", () => {
  test('Claude and ChatGPT: say they cannot add the server themselves, and link their settings page first', () => {
    const claude = startPlan('claude', URL)
    expect(claude.steps[0]!.text).toMatch(/^Claude cannot add the setup server by itself/)
    // One link: the name and the setup address (with its key) filled in, encoded; the address to copy as the fallback.
    const link = claude.steps[0]!.link!
    expect(link.label).toBe('Open in Claude')
    expect(link.href).toBe(
      `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Linedesk%20setup&connectorUrl=${encodeURIComponent(URL)}`,
    )
    expect(new globalThis.URL(link.href).searchParams.get('connectorUrl')).toBe(URL)
    expect(claude.steps[1]!.text).toBe("Link didn't fill it in? Paste this URL:")
    expect(claude.steps[1]!.code).toBe(URL)
    // Only there: the chat link and the prompt carry no key.
    expect(claude.steps[2]!.link!.href).not.toContain('lds_')
    expect(claude.prompt).not.toContain('lds_')
    expect(CLAUDE_CONNECTORS_URL).toBe('https://claude.ai/customize/connectors')
    const chatgpt = startPlan('chatgpt', URL)
    expect(chatgpt.steps[0]!.text).toMatch(/^ChatGPT cannot add the setup server by itself/)
    expect(chatgpt.steps[0]!.link).toEqual({ label: 'Open ChatGPT plugins', href: CHATGPT_PLUGINS_URL })
    expect(CHATGPT_PLUGINS_URL).toBe('https://chatgpt.com/plugins')
  })

  test("Claude's install link: Add custom connector with the name and the address filled in, or the owner's", () => {
    const link = new globalThis.URL(claudeConnectorLink('Linedesk', 'https://desk.example/mcp?x=1&y=2'))
    expect(link.origin + link.pathname).toBe('https://claude.ai/customize/connectors')
    expect(Object.fromEntries(link.searchParams)).toEqual({
      modal: 'add-custom-connector',
      connectorName: 'Linedesk',
      connectorUrl: 'https://desk.example/mcp?x=1&y=2',
    })
    expect(claudeConnectorLink('Linedesk', 'https://desk.example/mcp', true)).toBe(
      'https://claude.ai/admin-settings/connectors?modal=add-custom-connector&connectorName=Linedesk&connectorUrl=https%3A%2F%2Fdesk.example%2Fmcp',
    )
    expect(claudeConnectorLink('Linedesk setup')).not.toContain('connectorUrl')
  })

  test('one-click install links carry the address and nothing else', () => {
    const cursor = new globalThis.URL(cursorMcpInstallLink('linedesk', 'https://desk.example/mcp'))
    expect(cursor.protocol).toBe('cursor:')
    expect(JSON.parse(atob(cursor.searchParams.get('config')!))).toEqual({ url: 'https://desk.example/mcp' })
    expect(vscodeMcpInstallLink('linedesk', 'https://desk.example/mcp', true)).toMatch(
      /^vscode-insiders:mcp\/install\?/,
    )
    expect(opensWebPage(CLAUDE_CONNECTORS_URL)).toBe(true)
    expect(opensWebPage('cursor://anysphere.cursor-deeplink/mcp/install')).toBe(false)
  })
})

describe("the setup prompt in the person's language", () => {
  const namespaced = (ns: string, messages: Record<string, string>) =>
    Object.fromEntries(Object.entries(messages).map(([key, text]) => [`${ns}.${key}`, text]))
  const german: Words = createTranslator('de', {
    ...namespaced('onboarding', deOnboarding),
    ...namespaced('server', deServer),
  })
  test('English by default: says to talk in English, confirms the business first, no plan up front', () => {
    const prompt = agentSetupPrompt(URL, { scope: 'workspace' })
    expect(prompt).toMatch(/Talk to me in English\.$/)
    expect(prompt).toMatch(/No plan, no list of steps/)
    expect(prompt).toMatch(/workspaces\[\]\.known/)
  })

  test('German on a German page: every prompt and command, with the setup address kept', () => {
    for (const scope of ['install', 'workspace', 'partner'] as const) {
      const plan = startPlan('claude_code', URL, scope, undefined, german)
      expect(plan.prompt, scope).toMatch(/Sprich mit mir auf Deutsch\.$/)
      expect(plan.prompt, scope).toContain(URL)
      expect(plan.steps[0]!.code, scope).toMatch(/Sprich mit mir auf Deutsch/)
    }
    const change = { workspaceId: 'ws_1', workspaceName: 'Sanitär Müller' }
    const changed = agentSetupPrompt(URL, { scope: 'workspace', change, words: german })
    expect(changed).toContain('"Sanitär Müller" (workspaceId ws_1)')
    expect(changed).toMatch(/Sprich mit mir auf Deutsch\.$/)
    // Through a connector: no address, no key.
    expect(agentSetupPrompt(URL, { connector: true, scope: 'workspace', words: german })).not.toContain('lds_')
  })

  test("the setup MCP tells the agent to use the person's language and to confirm before anything else", () => {
    for (const text of [SETUP_MCP_INSTRUCTIONS, SETUP_MCP_WORKSPACE_INSTRUCTIONS]) {
      expect(text).toMatch(/setup_status\.you_act_as\.language/)
      expect(text).toMatch(/no plan, no list of steps/)
    }
  })
})
